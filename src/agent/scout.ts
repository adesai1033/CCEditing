import { z } from "zod";
import type { ProjectState, ScoutContribution, SourceFile } from "../project/types.js";
import type { ChatProvider, ContentBlock, NeutralMessage } from "./providers/types.js";
import type { ToolRegistry } from "./perception-registry.js";
import type { ToolSchema } from "./types.js";
import { boundContribution } from "./content-map.js";

/**
 * A scout is a READ-ONLY sub-agent (3E-3). It perceives exactly ONE source in
 * its OWN context window and returns a distilled contribution — so the raw
 * per-source perception never has to coexist in the director's window. That
 * isolation is the mechanism that removes the context wall; a merely-parallel
 * gather sharing one window would not.
 *
 * Hard invariants (enforced structurally):
 *  - No write path. This module imports neither applyPlan nor propose_edit_plan,
 *    and the scout's tool set is the perception registry's schemas plus a single
 *    read-only terminal, `record_findings`. It cannot edit the timeline.
 *  - No recursion. `survey_sources` is a director-only tool, absent from the
 *    perception registry, so a scout cannot start further scouts.
 *  - Bounded. Its own tool-call budget (separate from the director's 25); on
 *    budget-exhaustion, timeout, or any error it returns `incomplete: true`
 *    rather than throwing, so one bad source never sinks the survey.
 */

export const SCOUT_TOOL_BUDGET = 12;
const SCOUT_MAX_TOKENS = 8000;

// The scout's single terminal tool. Read-only: it records findings, it does not
// change anything. Defined here (not in the registry) so it exists only inside a
// scout's tool set and can never leak into the director's or another tool's.
export const RECORD_FINDINGS_TOOL = "record_findings";

const FindingsSchema = z.object({
  outline: z.array(z.object({
    start: z.number(),
    end: z.number(),
    gist: z.string(),
  })),
  keyMoments: z.array(z.object({
    time: z.number(),
    gist: z.string(),
  })),
  topicBeats: z.array(z.object({
    start: z.number(),
    end: z.number(),
    gist: z.string(),
  })).optional(),
  silences: z.array(z.object({
    start: z.number(),
    end: z.number(),
  })).optional(),
});

const recordFindingsSchema: ToolSchema = {
  name: RECORD_FINDINGS_TOOL,
  description:
    "Record your distilled findings for this ONE source and finish. Call this " +
    "exactly once, when you have perceived enough. `outline` is a short " +
    "beat-by-beat map of the source (a handful of segments, not every second); " +
    "`keyMoments` are the few standout moments worth building an edit around; " +
    "`topicBeats` (optional) are spoken-topic spans; `silences` (optional) are " +
    "notable pauses. Keep every gist to one terse phrase. Do not dump raw " +
    "transcripts or full scene lists — distill.",
  input_schema: {
    type: "object",
    properties: {
      outline: { type: "array", items: { type: "object", properties: {
        start: { type: "number" }, end: { type: "number" }, gist: { type: "string" },
      }, required: ["start", "end", "gist"] } },
      keyMoments: { type: "array", items: { type: "object", properties: {
        time: { type: "number" }, gist: { type: "string" },
      }, required: ["time", "gist"] } },
      topicBeats: { type: "array", items: { type: "object", properties: {
        start: { type: "number" }, end: { type: "number" }, gist: { type: "string" },
      }, required: ["start", "end", "gist"] } },
      silences: { type: "array", items: { type: "object", properties: {
        start: { type: "number" }, end: { type: "number" },
      }, required: ["start", "end"] } },
    },
    required: ["outline", "keyMoments"],
  },
};

export interface ScoutDeps {
  provider: ChatProvider;
  registry: ToolRegistry;       // perception registry — supplies the read-only tool set
  budget?: number;              // tool-call budget; defaults to SCOUT_TOOL_BUDGET
  maxTokens?: number;
  deadlineMs?: number;          // optional wall-clock cap; checked per iteration
  onProgress?: (event: ScoutProgressEvent) => void;
}

export type ScoutProgressEvent =
  | { type: "scout_tool"; sourceId: string; name: string }
  | { type: "scout_done"; sourceId: string; incomplete: boolean };

export interface ScoutResult {
  sourceId: string;
  contribution: ScoutContribution | null;   // null when incomplete
  incomplete: boolean;
  // Perception-cache writes threaded through the run, plus (on success) the
  // distilled contribution written into this source's analyses. The survey
  // merges each scout's source-analyses back into the project state.
  state: ProjectState;
}

/**
 * Perceive one source and return its distilled contribution. Never throws —
 * failures degrade to `incomplete: true`.
 */
export async function runScout(sourceId: string, state: ProjectState, deps: ScoutDeps): Promise<ScoutResult> {
  const budget = deps.budget ?? SCOUT_TOOL_BUDGET;
  const maxTokens = deps.maxTokens ?? SCOUT_MAX_TOKENS;
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) {
    // Nothing to perceive; report incomplete rather than throwing.
    deps.onProgress?.({ type: "scout_done", sourceId, incomplete: true });
    return { sourceId, contribution: null, incomplete: true, state };
  }

  const allowed = new Set(deps.registry.perceptionSchemas().map((s) => s.name));
  const tools = [...deps.registry.perceptionSchemas(), recordFindingsSchema];
  // Static instructions cacheable (shared byte-identical across all N scouts
  // in a survey); the per-source identification segment follows uncached.
  const system = [
    { text: scoutStaticPrefix(), cacheable: true },
    { text: scoutSourceSegment(source) },
  ];

  let running = state;
  let messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text:
      `Perceive source ${source.id} (${source.fileName}, ${source.duration.toFixed(1)}s) and record your findings.` }] },
  ];
  let toolBudget = budget;

  try {
    for (let i = 0; i < budget + 1; i++) {
      if (deps.deadlineMs !== undefined && Date.now() > deps.deadlineMs) break; // timed out → incomplete

      const response = await deps.provider.send({
        system, messages, tools, maxTokens,
        reasoning: { enabled: false },   // scouts distill; they don't plan
        role: "scout",
      });

      messages = [...messages, { role: "assistant", content: response.content }];

      if (response.stopReason === "max_output") break; // truncated → incomplete

      const toolUses = response.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (toolUses.length === 0) break; // scout stopped without recording → incomplete

      const results: Array<Extract<ContentBlock, { type: "tool_result" }>> = [];
      for (const tu of toolUses) {
        if (tu.name === RECORD_FINDINGS_TOOL) {
          const parsed = FindingsSchema.safeParse(tu.input);
          if (!parsed.success) {
            results.push({ type: "tool_result", toolUseId: tu.id, isError: true,
              content: `Findings failed validation: ${parsed.error.message}` });
            continue;
          }
          // Terminal: bound, stamp, write into this source's analyses, done.
          const bounded = boundContribution(parsed.data);
          const contribution: ScoutContribution = {
            outline: bounded.outline,
            keyMoments: bounded.keyMoments,
            ...(bounded.topicBeats ? { topicBeats: bounded.topicBeats } : {}),
            ...(bounded.silences ? { silences: bounded.silences } : {}),
            ...(bounded.truncated ? { truncated: true } : {}),
            generatedAt: new Date().toISOString(),
          };
          const finalState = writeContribution(running, sourceId, contribution);
          deps.onProgress?.({ type: "scout_done", sourceId, incomplete: false });
          return { sourceId, contribution, incomplete: false, state: finalState };
        }

        if (toolBudget <= 0) {
          results.push({ type: "tool_result", toolUseId: tu.id, isError: true,
            content: "Scout tool budget exhausted — record findings now." });
          continue;
        }
        toolBudget -= 1;

        if (!allowed.has(tu.name)) {
          // A name outside the read-only perception set (incl. survey/write
          // tools) is refused structurally — a scout can only perceive.
          results.push({ type: "tool_result", toolUseId: tu.id, isError: true,
            content: `Tool "${tu.name}" is not available to a scout.` });
          continue;
        }

        deps.onProgress?.({ type: "scout_tool", sourceId, name: tu.name });
        const entry = deps.registry.get(tu.name)!;
        try {
          const outcome = await entry.execute(running, tu.input);
          if (outcome.ok) {
            if (outcome.stateUpdate) running = outcome.stateUpdate;
            results.push({ type: "tool_result", toolUseId: tu.id, content: JSON.stringify(outcome.result) });
          } else {
            results.push({ type: "tool_result", toolUseId: tu.id, isError: true, content: outcome.error });
          }
        } catch (err: unknown) {
          results.push({ type: "tool_result", toolUseId: tu.id, isError: true,
            content: `Tool threw: ${(err as Error).message}` });
        }
      }

      messages = [...messages, { role: "user", content: results }];
    }
  } catch {
    // Any unexpected failure degrades to incomplete; the survey continues.
  }

  deps.onProgress?.({ type: "scout_done", sourceId, incomplete: true });
  return { sourceId, contribution: null, incomplete: true, state: running };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeContribution(state: ProjectState, sourceId: string, contribution: ScoutContribution): ProjectState {
  return {
    ...state,
    sources: state.sources.map((s) =>
      s.id === sourceId ? { ...s, analyses: { ...s.analyses, scoutContribution: contribution } } : s,
    ),
  };
}

/**
 * The scout system prompt, split for prompt caching (3E-5): the instructions
 * are identical for every scout, so N parallel scouts in one survey share one
 * cached prefix (instructions + the perception tool schemas); only the
 * source-identification segment varies per scout.
 */
export function scoutStaticPrefix(): string {
  return [
    "You are a read-only scout. Your job is to perceive ONE source video and distill it into a compact map — nothing else.",
    "",
    "Use the perception tools to look at this source. Reuse cached results — do not re-request perception you already have. Then call record_findings ONCE with:",
    "- outline: a short beat-by-beat map (a handful of segments across the whole source, not every second).",
    "- keyMoments: the few standout moments worth building an edit around.",
    "- topicBeats (if it has speech): spoken-topic spans from the transcript.",
    "- silences (if relevant): notable pauses.",
    "",
    "Keep every gist to one terse phrase. Do NOT dump raw transcripts or exhaustive scene lists — distill. You cannot edit the timeline; you only perceive and report. You have a limited tool-call budget, so be economical, then record_findings.",
  ].join("\n");
}

function scoutSourceSegment(source: SourceFile): string {
  const hasAudio = source.audioCodec !== null && source.audioCodec !== undefined;
  return [
    `Source: ${source.id}`,
    `File: ${source.fileName}  ·  ${source.duration.toFixed(1)}s  ·  ${source.width}x${source.height}  ·  audio: ${hasAudio ? "yes" : "no"}`,
  ].join("\n");
}

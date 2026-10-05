import { z } from "zod";
import type { ProjectState } from "../project/types.js";
import type { ChatProvider, ContentBlock, NeutralMessage } from "./providers/types.js";
import type { ToolSchema } from "./types.js";
import type { ContentMap } from "./content-map.js";
import { queryTimeline } from "./tools/query_timeline.js";
import { criticSystemPrompt } from "./critic-prompt.js";
import { renderEvidence, type EvidenceItem } from "./evidence.js";

/**
 * The critic (3G): a SEPARATE context that reviews a drafted plan before the
 * user ever sees it. The isolation is the design, not an implementation detail:
 * the director's context is biased toward the plan it just authored, so the
 * critic gets the user's original request, the ContentMap, the director's
 * perception EVIDENCE (raw tool observations — see evidence.ts), the drafted
 * plan, and the timeline state — and explicitly NOT the director's
 * conversation history or reasoning. Feeding it the director's reasoning would
 * rebuild the prompt-level self-review this slice exists to improve on;
 * withholding the observations made it reject well-grounded plans as guesses.
 *
 * Hard invariants (same family as the scouts', 3E-3):
 *  - Read-only, structurally. This module imports neither applyPlan nor
 *    propose_edit_plan; the critic's only tool is `submit_review`, a terminal
 *    that records a verdict and changes nothing. It cannot write, and it cannot
 *    re-perceive (a critic with perception tools is a slower director).
 *  - Fail open. A malformed verdict, a provider error, or a critic that never
 *    calls submit_review degrades to `approve` with a logged warning — a critic
 *    failure must never strand a valid plan.
 *  - The verdict is structured, not prose (decision 5), so the director gets
 *    feedback it can act on rather than argue with.
 */

export const SUBMIT_REVIEW_TOOL = "submit_review";
// Thinking is on (review is a judgment task, decision 7) and counts toward the
// output budget, so this leaves room for both the reasoning and the verdict.
const CRITIC_MAX_TOKENS = 8000;

export interface CriticConcern {
  severity: "minor" | "major";
  operationIndex?: number;
  issue: string;
}

export interface CriticVerdict {
  verdict: "approve" | "revise";
  concerns: CriticConcern[];
}

/** Everything the critic sees — and, by omission, everything it must not. */
export interface CriticInput {
  userRequest: string;
  contentMap: ContentMap | null;   // null when the director never surveyed
  /** What the director's perception tools returned this turn. */
  evidence?: EvidenceItem[];
  plan: { summary: string; operations: unknown[] };
  renderedPlan: string[];
  timelineState: ProjectState;
}

export interface CriticDeps {
  provider: ChatProvider;
  maxTokens?: number;
  /** Where fail-open warnings surface. Defaults to a no-op — the critic_verdict
   *  progress event is the user-visible trace; this hook is for tests/telemetry. */
  onWarn?: (message: string) => void;
}

const VerdictSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  concerns: z
    .array(
      z.object({
        severity: z.enum(["minor", "major"]),
        operationIndex: z.number().int().nonnegative().optional(),
        issue: z.string(),
      }),
    )
    .default([]),
});

const submitReviewSchema: ToolSchema = {
  name: SUBMIT_REVIEW_TOOL,
  description:
    "Submit your review verdict for the drafted plan. Call this exactly once. " +
    "`verdict` is \"approve\" when the plan is defensible, \"revise\" when a " +
    "concern would change the edit. Each concern names what is wrong; " +
    "`operationIndex` (0-based) points at the offending operation when there " +
    "is one.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "revise"] },
      concerns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["minor", "major"] },
            operationIndex: { type: "number", description: "0-based index into the plan's operations." },
            issue: { type: "string" },
          },
          required: ["severity", "issue"],
        },
      },
    },
    required: ["verdict", "concerns"],
  },
};

/**
 * Review one drafted plan in a fresh context. Never throws; every failure mode
 * degrades to approve-with-warning so the user is never blocked by the critic.
 */
export async function runCritic(input: CriticInput, deps: CriticDeps): Promise<CriticVerdict> {
  const warn = deps.onWarn ?? (() => {});
  const failOpen = (why: string): CriticVerdict => {
    warn(`critic: ${why} — failing open to approve`);
    return { verdict: "approve", concerns: [] };
  };

  const system = [{ text: criticSystemPrompt(), cacheable: true }];
  let messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: await buildReviewPayload(input) }] },
  ];

  try {
    // At most two sends: the review, plus one nudge if the critic replied in
    // prose instead of calling submit_review. Bounded — never a loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await deps.provider.send({
        system,
        messages,
        tools: [submitReviewSchema],
        maxTokens: deps.maxTokens ?? CRITIC_MAX_TOKENS,
        reasoning: { enabled: true },   // review is a judgment task (decision 7)
        role: "critic",
      });

      const tu = response.content.find(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (!tu) {
        messages = [
          ...messages,
          { role: "assistant", content: response.content },
          { role: "user", content: [{ type: "text", text: "Respond by calling submit_review with your verdict. Do not reply in prose." }] },
        ];
        continue;
      }
      if (tu.name !== SUBMIT_REVIEW_TOOL) {
        return failOpen(`called unavailable tool "${tu.name}"`);
      }
      const parsed = VerdictSchema.safeParse(tu.input);
      if (!parsed.success) {
        return failOpen(`verdict failed validation: ${parsed.error.message}`);
      }
      return { verdict: parsed.data.verdict, concerns: parsed.data.concerns };
    }
    return failOpen("never called submit_review");
  } catch (err: unknown) {
    return failOpen(`errored: ${(err as Error).message}`);
  }
}

// ── Payload ───────────────────────────────────────────────────────────────────

/** The review payload: request, timeline, map, and the plan rendered both
 *  human-readable and structured (decision 4). Built fresh — no history. */
async function buildReviewPayload(input: CriticInput): Promise<string> {
  const snapshot = await queryTimeline.execute(input.timelineState, {});
  const timelineJson = snapshot.ok
    ? JSON.stringify(snapshot.result, null, 2)
    : "(timeline unavailable)";

  return [
    "## User request",
    input.userRequest,
    "",
    "## Current timeline",
    "```json",
    timelineJson,
    "```",
    "",
    "## Content map",
    ...(input.contentMap
      ? ["```json", JSON.stringify(input.contentMap, null, 2), "```"]
      : [(input.evidence?.length ?? 0) > 0
          ? "(no content map — the director verified with targeted tools instead; see the evidence below)"
          : "(no content map — the director did not survey sources this turn)"]),
    "",
    "## Director's evidence (raw perception results from this turn)",
    ...((input.evidence?.length ?? 0) > 0
      ? renderEvidence(input.evidence!)
      : ["(none — the director ran no perception tools this turn)"]),
    "",
    "## Drafted plan",
    `Summary: ${input.plan.summary}`,
    "",
    "Operations (structured):",
    "```json",
    JSON.stringify(input.plan.operations, null, 2),
    "```",
    "",
    "Operations (rendered):",
    ...input.renderedPlan.map((line) => `- ${line}`),
  ].join("\n");
}

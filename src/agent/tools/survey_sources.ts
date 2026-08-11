import { z } from "zod";
import type { ProjectState, SourceAnalyses } from "../../project/types.js";
import { clipsInOrder } from "../../project/types.js";
import type { ToolResult, ToolSchema } from "../types.js";
import { buildDefaultProvider } from "../providers/default.js";
import { buildPerceptionRegistry } from "../perception-registry.js";
import { runScout, type ScoutResult } from "../scout.js";
import { reduceContentMap, type ContentMap, type ScoutOutcome } from "../content-map.js";

/**
 * `survey_sources` — the director-facing tool that fixes the context wall (3E-3).
 *
 * From the director's side this is ONE tool call returning a distilled
 * `ContentMap`. Inside, it fans out read-only scouts — one per source, each
 * perceiving in its OWN context, in parallel under a concurrency cap — and
 * reduces their contributions into the map. Whether the map was built by one
 * scout or twenty is invisible to the director; that invariant is what kept this
 * a one-tool change behind the seam built in 3E-2.4.
 *
 * The write invariant: nothing here imports applyPlan or propose_edit_plan. The
 * fan-out is confined to idempotent, additive reads; the director alone plans
 * and writes, serially. This module reaches the perception registry and the
 * provider directly (NOT registry.ts) so it can never pull in the director-only
 * survey tool and recurse.
 */

// Cap in-flight scouts so a many-source project stays under Gemini/TwelveLabs/
// Whisper and provider rate limits. The rest queue.
export const SURVEY_CONCURRENCY = 5;

const SurveyInputSchema = z.object({
  sourceIds: z.array(z.string()).optional(),
});

export interface SurveyDeps {
  // Injected for tests; production wraps runScout with the default provider +
  // perception registry.
  scout: (sourceId: string, state: ProjectState) => Promise<ScoutResult>;
  concurrency?: number;
  onProgress?: (event: { type: "scouting"; sourceId: string }) => void;
}

/**
 * The testable core. Reuses cached scout contributions, fans out the rest under
 * a concurrency cap, merges each scout's per-source analyses back into state,
 * and reduces to a bounded ContentMap. One failed scout marks its source
 * incomplete; the survey still returns a usable map (decision 6).
 */
export async function runSurvey(
  state: ProjectState,
  input: { sourceIds?: string[] },
  deps: SurveyDeps,
): Promise<ToolResult<ContentMap>> {
  const scope = resolveScope(state, input.sourceIds);
  const sourceById = new Map(state.sources.map((s) => [s.id, s]));

  // Split into cached (reuse — do not re-perceive) vs. needs-scouting.
  const toScout: string[] = [];
  for (const id of scope) {
    const cached = sourceById.get(id)?.analyses.scoutContribution;
    if (!cached) toScout.push(id);
  }

  const concurrency = deps.concurrency ?? SURVEY_CONCURRENCY;
  const scoutResults = await mapWithConcurrency(toScout, concurrency, (id) => {
    deps.onProgress?.({ type: "scouting", sourceId: id });
    return deps.scout(id, state);
  });

  // Merge each scout's per-source analyses back into the base state. Scouts ran
  // against the same base and each touched only its own source, so the merge is
  // additive and conflict-free (decision 8).
  const analysesById = new Map<string, SourceAnalyses>();
  for (const r of scoutResults) {
    const s = r.state.sources.find((x) => x.id === r.sourceId);
    if (s) analysesById.set(r.sourceId, s.analyses);
  }
  const mergedState: ProjectState = {
    ...state,
    sources: state.sources.map((s) =>
      analysesById.has(s.id) ? { ...s, analyses: analysesById.get(s.id)! } : s,
    ),
  };

  // Build one outcome per in-scope source. Freshly-scouted sources take their
  // contribution from the scout result; reused sources take theirs from the
  // cached contribution on state. A failed scout contributes none and is flagged
  // incomplete, so the director sees the gap rather than assuming full coverage.
  const scoutById = new Map(scoutResults.map((r) => [r.sourceId, r]));
  const outcomes: ScoutOutcome[] = scope.map((id) => {
    const r = scoutById.get(id);
    if (r) {
      return { sourceId: id, contribution: r.incomplete ? null : r.contribution, incomplete: r.incomplete };
    }
    const cached = sourceById.get(id)?.analyses.scoutContribution ?? null;
    return { sourceId: id, contribution: cached, incomplete: cached === null };
  });

  const map = reduceContentMap(mergedState, outcomes);
  return { ok: true, result: map, stateUpdate: mergedState };
}

/** Sources to survey: the requested ids, or every source referenced by a clip. */
function resolveScope(state: ProjectState, requested?: string[]): string[] {
  if (requested && requested.length > 0) {
    // Keep only ids that actually exist, preserving requested order.
    const exists = new Set(state.sources.map((s) => s.id));
    return requested.filter((id) => exists.has(id));
  }
  const seen = new Set<string>();
  const order: string[] = [];
  for (const clip of clipsInOrder(state.timeline)) {
    if (!seen.has(clip.sourceId)) { seen.add(clip.sourceId); order.push(clip.sourceId); }
  }
  return order;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ── Registered director-facing tool ───────────────────────────────────────────

async function execute(state: ProjectState, input: unknown): Promise<ToolResult<ContentMap>> {
  const parsed = SurveyInputSchema.safeParse(input ?? {});
  const sourceIds = parsed.success ? parsed.data.sourceIds : undefined;
  return runSurvey(state, { sourceIds }, defaultDeps());
}

function defaultDeps(): SurveyDeps {
  const provider = buildDefaultProvider();
  const registry = buildPerceptionRegistry();
  return {
    scout: (sourceId, state) => runScout(sourceId, state, { provider, registry }),
    concurrency: SURVEY_CONCURRENCY,
  };
}

const schema: ToolSchema = {
  name: "survey_sources",
  description:
    "Survey the project's sources and return a distilled, bounded content map: " +
    "per source an outline, key moments, optional spoken-topic beats and " +
    "silences, plus any user label. Call this FIRST for broad or compound " +
    "requests (tightening, reordering for narrative, 'cut anything flat') so you " +
    "can plan across everything without pulling every source's raw perception " +
    "into context. Then verify specific candidate cuts with the targeted " +
    "perception tools before proposing. Sources marked `incomplete` could not be " +
    "fully perceived — account for that rather than assuming full coverage. " +
    "Input: optional `sourceIds` to limit scope (default: all timeline sources).",
  input_schema: {
    type: "object",
    properties: {
      sourceIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional: UUIDs of sources to survey. Omit to survey all timeline sources.",
      },
    },
  },
};

export const surveySources = { execute, schema };

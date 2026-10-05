import type { ProjectState } from "../project/types.js";

/**
 * Perception evidence for the critic: what the director's tools OBSERVED this
 * turn — transcript lines with their exact times, segment descriptions,
 * visual-search hits, scene and silence boundaries. Observations, not
 * reasoning: the critic still never sees the director's thinking (3G's
 * isolation), but it no longer has to judge timestamps blind.
 *
 * Without this the critic only had the content map, so a plan grounded in
 * transcripts was flagged "unverified" whenever the director had not also run
 * a survey — measured on a real edit: two false revise rounds and a 9-minute
 * survey run only to satisfy the critic.
 */

export interface EvidenceItem {
  tool: string;
  /** Source file name, for readability (sourceId when unknown). */
  source: string;
  /** The call's arguments minus the sourceId. */
  input: Record<string, unknown>;
  result: unknown;
}

/** Tools whose results are evidence about source content. */
const EVIDENCE_TOOLS = new Set([
  "transcribe_audio", "describe_segment", "describe_clip",
  "find_visual_moment", "detect_scenes", "detect_silence", "map_visual_beats",
]);

/** Per-item cap so one wide read can't crowd out the rest (a whole 2–3 minute
 *  call in compact lines is ~2–3k chars). */
const MAX_ITEM_CHARS = 6000;
/** Total cap; the most recent items win (they're what the plan was built on). */
export const MAX_EVIDENCE_CHARS = 24000;

/** Record a successful tool call as evidence, or return null if it isn't evidence. */
export function evidenceFrom(
  toolName: string,
  input: unknown,
  result: unknown,
  state: ProjectState,
): EvidenceItem | null {
  if (!EVIDENCE_TOOLS.has(toolName)) return null;
  const args = { ...(input as Record<string, unknown> | null ?? {}) };
  const sourceId = typeof args["sourceId"] === "string" ? (args["sourceId"] as string) : "";
  delete args["sourceId"];
  const source = state.sources.find((s) => s.id === sourceId)?.fileName ?? (sourceId || "(unknown)");
  return { tool: toolName, source, input: args, result: trimResult(toolName, result) };
}

/** Keep the parts of a result that bear on timing and content; drop bookkeeping. */
function trimResult(toolName: string, result: unknown): unknown {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "transcribe_audio": {
      // One compact line per segment ("61.98–62.62 Good news.") so a whole
      // call fits the per-item cap; as JSON objects a 39-line transcript was
      // cut off before its ending, and the critic never saw how the story ends.
      const segs = Array.isArray(r["segments"]) ? (r["segments"] as Array<{ start: number; end: number; text: string }>) : [];
      return {
        lines: segs.map((x) => `${x.start.toFixed(2)}–${x.end.toFixed(2)} ${x.text.trim()}`),
        ...(r["note"] ? { note: r["note"] } : {}),
      };
    }
    case "describe_segment":
    case "describe_clip":
      return { description: r["description"] };
    case "map_visual_beats":
      return { beats: r["beats"] };
    case "find_visual_moment":
      return { hits: Array.isArray(r["hits"]) ? (r["hits"] as unknown[]).slice(0, 5) : r["hits"] };
    default:
      return result;
  }
}

/** Render evidence for the review payload, newest items kept when over budget. */
export function renderEvidence(items: EvidenceItem[]): string[] {
  const rendered = items.map((it) => {
    let text = JSON.stringify(it);
    if (text.length > MAX_ITEM_CHARS) text = text.slice(0, MAX_ITEM_CHARS) + "…(truncated)";
    return text;
  });
  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (used + rendered[i]!.length > MAX_EVIDENCE_CHARS) break;
    kept.unshift(rendered[i]!);
    used += rendered[i]!.length;
  }
  const dropped = rendered.length - kept.length;
  return [
    ...(dropped > 0 ? [`(${dropped} older item${dropped === 1 ? "" : "s"} omitted for length)`] : []),
    ...kept.map((t) => `- ${t}`),
  ];
}

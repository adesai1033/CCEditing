import type { ProjectState, ScoutContribution } from "../project/types.js";
import { clipsInOrder, getClipDisplayRefs } from "../project/types.js";

/**
 * The ContentMap is the distilled substrate the director plans against (3E-3).
 * It is BOUNDED and per-source: each source contributes an outline, a handful of
 * key moments, optional topic beats and silences, and (if annotated) a label.
 * It records nothing about HOW it was gathered — whether one scout or twenty,
 * sequential or parallel, is invisible here. That invariant is what lets
 * `survey_sources` swap a sequential survey for a fan-out with no director-side
 * change.
 *
 * Boundedness is the point: the raw per-source perception never lands in the
 * director's window: only these caps-limited gists do. Removing the caps would
 * reintroduce the context wall this slice exists to knock down.
 */

// Per-source caps. Exceeding any of these sets `truncated` on the map so the
// director knows the picture is elided, not complete.
export const CONTENT_MAP_CAPS = {
  outline: 12,
  keyMoments: 8,
  topicBeats: 12,
  silences: 20,
  gistChars: 200,
} as const;

export interface ContentMapSource {
  sourceId: string;
  displayRef: string;            // refs of the clips drawn from this source, e.g. "2" or "2a,2b"
  duration: number;              // source duration in seconds
  outline: Array<{ start: number; end: number; gist: string }>;
  keyMoments: Array<{ time: number; gist: string }>;
  topicBeats?: Array<{ start: number; end: number; gist: string }>;
  silences?: Array<{ start: number; end: number }>;
  label?: string;                // user annotation(s) from referencing clips
  incomplete?: boolean;          // scout failed/timed out for this source
}

export interface ContentMap {
  sources: ContentMapSource[];
  truncated: boolean;            // any source's caps elided detail
}

/**
 * One source's survey outcome, as produced by the fan-out. `contribution` is
 * null when the scout could not complete (failure/timeout/budget); the source
 * still appears in the map, flagged `incomplete`, so the director can plan
 * around it rather than silently assuming full coverage.
 */
export interface ScoutOutcome {
  sourceId: string;
  contribution: ScoutContribution | null;
  incomplete: boolean;
}

function clampGist(s: string): string {
  const t = String(s ?? "").trim();
  return t.length > CONTENT_MAP_CAPS.gistChars
    ? t.slice(0, CONTENT_MAP_CAPS.gistChars - 1).trimEnd() + "…"
    : t;
}

/**
 * Bound + normalize a raw contribution to the caps. Returns the trimmed lists
 * and whether any cap elided detail. Used both by the scout (before caching)
 * and by the reducer (defensively), so the caps are enforced in one place.
 */
export function boundContribution(raw: {
  outline?: Array<{ start: number; end: number; gist: string }>;
  keyMoments?: Array<{ time: number; gist: string }>;
  topicBeats?: Array<{ start: number; end: number; gist: string }>;
  silences?: Array<{ start: number; end: number }>;
}): {
  outline: Array<{ start: number; end: number; gist: string }>;
  keyMoments: Array<{ time: number; gist: string }>;
  topicBeats?: Array<{ start: number; end: number; gist: string }>;
  silences?: Array<{ start: number; end: number }>;
  truncated: boolean;
} {
  const outlineRaw = raw.outline ?? [];
  const momentsRaw = raw.keyMoments ?? [];
  const beatsRaw = raw.topicBeats;
  const silencesRaw = raw.silences;

  let truncated = false;
  const cap = <T>(arr: T[], limit: number): T[] => {
    if (arr.length > limit) truncated = true;
    return arr.slice(0, limit);
  };

  const outline = cap(outlineRaw, CONTENT_MAP_CAPS.outline).map((o) => ({
    start: o.start, end: o.end, gist: clampGist(o.gist),
  }));
  const keyMoments = cap(momentsRaw, CONTENT_MAP_CAPS.keyMoments).map((m) => ({
    time: m.time, gist: clampGist(m.gist),
  }));
  const topicBeats = beatsRaw
    ? cap(beatsRaw, CONTENT_MAP_CAPS.topicBeats).map((b) => ({ start: b.start, end: b.end, gist: clampGist(b.gist) }))
    : undefined;
  const silences = silencesRaw
    ? cap(silencesRaw, CONTENT_MAP_CAPS.silences).map((s) => ({ start: s.start, end: s.end }))
    : undefined;

  return { outline, keyMoments, topicBeats, silences, truncated };
}

/**
 * Reduce per-source scout outcomes into one bounded ContentMap. Additive: each
 * outcome owns exactly one source, so there is nothing to reconcile — merging is
 * a concat. displayRef/duration/label are layered in from LIVE state (not from
 * the cached contribution), so a `/label` change is reflected without
 * re-surveying. Incomplete sources appear with a flag and empty content.
 */
export function reduceContentMap(state: ProjectState, outcomes: ScoutOutcome[]): ContentMap {
  const sourceMap = new Map(state.sources.map((s) => [s.id, s]));
  const refs = getClipDisplayRefs(state.timeline);

  // Collect referencing-clip refs and user labels per source, in timeline order.
  const refsBySource = new Map<string, string[]>();
  const labelsBySource = new Map<string, string[]>();
  for (const clip of clipsInOrder(state.timeline)) {
    const ref = refs.get(clip.id);
    if (ref) (refsBySource.get(clip.sourceId) ?? setDefault(refsBySource, clip.sourceId, [])).push(ref);
    if (clip.userLabel) {
      const labels = labelsBySource.get(clip.sourceId) ?? setDefault(labelsBySource, clip.sourceId, []);
      if (!labels.includes(clip.userLabel)) labels.push(clip.userLabel);
    }
  }

  let truncated = false;
  const sources: ContentMapSource[] = outcomes.map((outcome) => {
    const src = sourceMap.get(outcome.sourceId);
    const displayRef = (refsBySource.get(outcome.sourceId) ?? []).join(",") || "?";
    const labels = labelsBySource.get(outcome.sourceId) ?? [];
    const label = labels.length > 0 ? labels.join("; ") : undefined;
    const duration = src?.duration ?? 0;

    if (!outcome.contribution || outcome.incomplete) {
      return {
        sourceId: outcome.sourceId,
        displayRef,
        duration,
        outline: [],
        keyMoments: [],
        ...(label !== undefined ? { label } : {}),
        incomplete: true,
      };
    }

    const bounded = boundContribution(outcome.contribution);
    if (bounded.truncated || outcome.contribution.truncated) truncated = true;

    return {
      sourceId: outcome.sourceId,
      displayRef,
      duration,
      outline: bounded.outline,
      keyMoments: bounded.keyMoments,
      ...(bounded.topicBeats ? { topicBeats: bounded.topicBeats } : {}),
      ...(bounded.silences ? { silences: bounded.silences } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  });

  return { sources, truncated };
}

function setDefault<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  return value;
}

import type { MediaInfo } from "../media/types.js";

export interface SourceFile {
  id: string;             // uuid
  filePath: string;       // absolute path to file on disk
  fileName: string;
  duration: number;       // seconds
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  fileSize: number;       // bytes
  analyses: SourceAnalyses;
}

// Cached results of video-understanding tool calls. Populated lazily by the
// agent's analysis tools and persisted in the project file so subsequent
// sessions reuse the work.
export interface SourceAnalyses {
  twelveLabs?: {
    indexId: string;
    videoId: string;
    status: "indexed" | "failed";
    indexedAt: string;     // ISO timestamp
    error?: string;
  };
  description?: {
    text: string;
    model: string;         // e.g. "gemini-2.5-flash"
    generatedAt: string;
  };
  scenes?: {
    threshold: number;
    boundaries: number[];   // seconds where shot cuts occur
    detectedAt: string;
  };
  moments?: MomentCacheEntry[];
  segmentDescriptions?: SegmentDescriptionEntry[];
  // Full transcript for the source. The cache holds everything; the
  // transcribe_audio tool only ever returns a window/query slice of it, so a
  // long transcript never lands in the agent's context wholesale.
  transcript?: TranscriptCacheEntry;
  // Keyed by (thresholdDb, minDuration) — a -35dB result must never satisfy a
  // -50dB request, so entries accumulate rather than overwrite.
  silences?: SilenceCacheEntry[];
  // A scout's distilled, bounded perception of this source (3E-3). Cached so a
  // survey reuses it instead of re-perceiving/re-distilling on every planning
  // turn. Only complete contributions are cached; a failed scout leaves this
  // unset so the next survey retries. Derived, never authoritative content.
  scoutContribution?: ScoutContribution;
  // Dense, time-coded "what's on screen" map of the whole source (map_visual_beats).
  // The substrate for matching cutaways to dialogue.
  visualBeats?: VisualBeatsCacheEntry;
}

export interface VisualBeat {
  start: number;          // seconds
  end: number;
  description: string;    // what is visible: page, UI state, action, on-screen text
}

export interface VisualBeatsCacheEntry {
  beats: VisualBeat[];
  model: string;
  generatedAt: string;
}

/**
 * One source's distilled contribution to a ContentMap (3E-3), produced by a
 * read-only scout in its own context. Bounded (caps on outline/moment counts);
 * `truncated` marks that caps elided detail. Holds source-derived perception
 * only — the per-clip user label is layered in at reduce time, not stored here.
 */
export interface ScoutContribution {
  outline: Array<{ start: number; end: number; gist: string }>;
  keyMoments: Array<{ time: number; gist: string }>;
  topicBeats?: Array<{ start: number; end: number; gist: string }>;
  silences?: Array<{ start: number; end: number }>;
  truncated?: boolean;
  generatedAt: string;      // ISO timestamp
}

export interface TranscriptSegment {
  start: number;          // seconds
  end: number;            // seconds
  text: string;
}

export interface TranscriptCacheEntry {
  segments: TranscriptSegment[];
  duration: number;       // seconds of audio transcribed
  model: string;
  // False when the source has no audio track. Cached so a silent source is
  // not re-sent to the backend on every request.
  hasAudio: boolean;
  transcribedAt: string;
}

export interface SilenceCacheEntry {
  thresholdDb: number;
  minDuration: number;
  silences: Array<{ start: number; end: number; duration: number }>;
  detectedAt: string;
}

/**
 * One visual-search hit. TwelveLabs returns only an ordering, no score, so
 * `rank` (1 = best match) is all there is: it says which hit is likeliest,
 * never how good a match is. Pre-rank caches stored a derived `confidence`
 * (1/(1+rank)); read them through normalizeMomentHits().
 */
export interface MomentHit {
  start: number;
  end: number;
  rank: number;
}

/** Hits sorted best-first with a 1-based rank, whatever shape they were cached in. */
export function normalizeMomentHits(hits: Array<{ start: number; end: number; rank?: number; confidence?: number }>): MomentHit[] {
  const keyed = hits.map((h, i) => ({
    h,
    // Legacy entries: higher confidence was better; fall back to stored order.
    key: h.rank ?? (h.confidence !== undefined ? 1 / h.confidence : i + 1),
    i,
  }));
  keyed.sort((a, b) => a.key - b.key || a.i - b.i);
  return keyed.map(({ h }, i) => ({ start: h.start, end: h.end, rank: i + 1 }));
}

export interface MomentCacheEntry {
  query: string;
  hits: MomentHit[];
  retrievedAt: string;
}

export interface SegmentDescriptionEntry {
  start: number;
  end: number;
  text: string;
  model: string;
  generatedAt: string;
}

/**
 * Video transition styles — the FFmpeg xfade names. "fade" is the classic
 * crossfade/dissolve; the command layer accepts "crossfade" and "dissolve"
 * as aliases for it. Audio always crossfades regardless of the picture style.
 */
export const TRANSITION_TYPES = [
  "fade", "fadeblack", "fadewhite",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "circleopen", "circleclose", "radial", "pixelize", "zoomin",
  "smoothleft", "smoothright",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const DEFAULT_TRANSITION_TYPE: TransitionType = "fade";
export const DEFAULT_TRANSITION_DURATION = 1;

/** A transition from a clip INTO the clip that follows it. */
export interface Transition {
  type: TransitionType;
  duration: number;       // seconds of overlap
}

export interface Clip {
  id: string;             // uuid
  sourceId: string;       // references SourceFile.id
  inPoint: number;        // start time within source (seconds)
  outPoint: number;       // end time within source (seconds)
  label: string;          // display name
  prevId: string | null;  // previous clip in timeline, null if head
  nextId: string | null;  // next clip in timeline, null if tail
  // Non-null when this clip is one of several halves produced by splitting.
  // All siblings (and their further-split descendants) share the same groupId.
  // null means the clip was never split.
  splitGroupId: string | null;
  // User-authored annotation set via `/label` (3E-3). Distinct from `label`
  // (the display name). NEVER agent-written; the agent may read and act on it.
  // Absent when the clip has no annotation. Lifecycle: split → both halves
  // inherit; trim/move → kept; delete → dropped with the clip.
  userLabel?: string;
  // Transition out of this clip into the NEXT one (a crossfade overlaps the
  // two by `duration`, shortening the timeline). Attached to the out edge, so
  // it travels with the clip on move, goes to the second half on split, and
  // is simply ignored while the clip is the tail. Absent = hard cut.
  transitionOut?: Transition;
  // Fade from black / to black (video) with a matching audio fade, seconds.
  // Split: the first half keeps fadeIn, the second half keeps fadeOut.
  fadeIn?: number;
  fadeOut?: number;
}

/**
 * Which point of an overlay is pinned to its (x, y) position. "top-right"
 * pins the overlay's own top-right corner, "center" its center, and so on.
 * Positions are therefore independent of the overlay's size and aspect: a
 * bottom-right overlay stays in the bottom-right corner when it is rescaled.
 */
export type OverlayAnchor =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";

export const OVERLAY_ANCHORS: readonly OverlayAnchor[] = [
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
];

/**
 * A picture-in-picture layer: a window of a source composited on top of the
 * main track. Overlays live on their own track — they are not part of the
 * clip linked list and are addressed in TIMELINE time (`at`), so cutting the
 * main track underneath one does not move it, exactly like a second video
 * track in a desktop editor. Overlay audio is never mixed in; the main track
 * keeps the soundtrack.
 *
 * Geometry is stored as fractions of the base frame so it survives the
 * preview downscale and any source resolution:
 *   - `scale`  overlay width as a fraction of the base width (aspect kept)
 *   - `x`, `y` where the anchor point lands, as fractions of base width/height
 */
/**
 * How a full-frame overlay fills the frame. Absent = picture-in-picture
 * geometry (anchor/x/y/scale). With a fit, the overlay covers the whole frame
 * and anchor/x/y/scale are ignored — a CUTAWAY: different picture while the
 * main track's sound keeps playing.
 *   cover   — scale to fill, cropping the overflow (no bars)
 *   contain — scale to fit inside, letterboxed on black (nothing cropped)
 */
export type OverlayFit = "cover" | "contain";
export const OVERLAY_FITS: readonly OverlayFit[] = ["cover", "contain"];

export interface Overlay {
  id: string;             // uuid
  sourceId: string;       // references SourceFile.id
  inPoint: number;        // start within source (seconds)
  outPoint: number;       // end within source (seconds)
  at: number;             // timeline time where the overlay starts (seconds)
  anchor: OverlayAnchor;
  x: number;              // 0–1 (values outside allow partial off-screen placement)
  y: number;              // 0–1
  scale: number;          // (0, 1]
  label: string;          // display name
  fit?: OverlayFit;       // set = full-frame cutaway (see OverlayFit)
}

export interface Timeline {
  headId: string | null;           // first clip in playback order
  tailId: string | null;           // last clip — kept for O(1) append
  clips: Record<string, Clip>;     // keyed by clip ID for O(1) lookup
  // Overlay track, bottom → top in stacking order. Optional so pre-v5 state
  // (and every existing literal) stays valid; read it through overlaysOf().
  overlays?: Overlay[];
}

export interface ProjectState {
  version: number;        // schema version for future migrations
  name: string;
  createdAt: string;      // ISO timestamp
  updatedAt: string;      // ISO timestamp
  sources: SourceFile[];
  timeline: Timeline;
  /** Measured audio sync between sources (media/sync.ts). Absent until measured. */
  sync?: ProjectSync;
}

/** Sources recorded at the same time, with measured offsets: source time = reference time + offset. */
export interface ProjectSync {
  referenceSourceId: string;
  offsets: Record<string, { offset: number; evidence: string }>;
  unsynced: Array<{ id: string; reason: string }>;
  measuredAt: string;
}

/** Offset between two synced sources (b time = a time + result), or null if either isn't synced. */
export function syncOffset(sync: ProjectSync | undefined, a: string, b: string): number | null {
  if (!sync) return null;
  const oa = sync.offsets[a];
  const ob = sync.offsets[b];
  if (!oa || !ob) return null;
  return ob.offset - oa.offset;
}

// Returned by every mutation — callers handle errors explicitly
export type MutationResult =
  | { ok: true; state: ProjectState }
  | { ok: false; error: string };

// Walk the linked list head→tail and return an ordered array.
export function clipsInOrder(timeline: Timeline): Clip[] {
  const result: Clip[] = [];
  let id = timeline.headId;
  while (id !== null) {
    const clip = timeline.clips[id];
    if (!clip) break; // guard against corrupt state
    result.push(clip);
    id = clip.nextId;
  }
  return result;
}

/**
 * Compute display references for every clip in the timeline.
 * Standalone clips (splitGroupId === null) are numbered sequentially: "1", "2", "3", ...
 * Split siblings share a base integer and get letter suffixes in timeline order:
 *   the first encountered member of a group is "2a", the next "2b", then "2c", etc.
 * The base integer increments only once per group, so subsequent standalone clips
 * are not shifted — e.g. splitting clip 2 yields [1] [2a] [2b] [3], not [1] [2] [3] [4].
 *
 * Returns Map<clipId, displayRef>.
 */
export function getClipDisplayRefs(timeline: Timeline): Map<string, string> {
  const ordered = clipsInOrder(timeline);
  const refs = new Map<string, string>();
  let nextIdx = 1;
  const groupBaseIdx = new Map<string, number>();   // groupId → base integer
  const groupLetterIdx = new Map<string, number>(); // groupId → next letter index (0=a, 1=b, ...)

  for (const clip of ordered) {
    if (clip.splitGroupId === null) {
      refs.set(clip.id, String(nextIdx++));
    } else {
      if (!groupBaseIdx.has(clip.splitGroupId)) {
        groupBaseIdx.set(clip.splitGroupId, nextIdx++);
        groupLetterIdx.set(clip.splitGroupId, 0);
      }
      const base   = groupBaseIdx.get(clip.splitGroupId)!;
      const letter = groupLetterIdx.get(clip.splitGroupId)!;
      groupLetterIdx.set(clip.splitGroupId, letter + 1);
      refs.set(clip.id, `${base}${String.fromCharCode(97 + letter)}`); // 97 = 'a'
    }
  }

  return refs;
}

/**
 * Resolve a clip reference to a Clip. Accepted forms, in priority order:
 *   1. Direct UUID  — fast O(1) map lookup
 *   2. Display ref  — "1", "2", "3", "2a", "2b", "2c", …  (O(n) walk)
 *   3. Plain integer fallback — "2" also matches "2a" when there is no standalone [2]
 * Returns undefined if nothing matches.
 */
export function resolveClip(timeline: Timeline, ref: string): Clip | undefined {
  // Fast path: direct UUID lookup
  if (timeline.clips[ref]) return timeline.clips[ref];

  // Walk display refs for exact match
  const displayRefs = getClipDisplayRefs(timeline);
  const lref = ref.toLowerCase();
  for (const [clipId, displayRef] of displayRefs) {
    if (displayRef === lref) return timeline.clips[clipId];
  }

  // Fallback: plain integer "2" → first member of the split group at that base index ("2a")
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1) {
    const aRef = `${n}a`;
    for (const [clipId, displayRef] of displayRefs) {
      if (displayRef === aRef) return timeline.clips[clipId];
    }
  }

  return undefined;
}

// ── Timeline layout ───────────────────────────────────────────────────────────
//
// Where each clip sits in TIMELINE time. Crossfades overlap adjacent clips, so
// timeline positions are not a running sum of clip durations; every consumer
// (display, preview windows, overlay placement, query_timeline, export) goes
// through this one function so they can never disagree.

export interface PlacedClip {
  clip: Clip;
  start: number;          // timeline time the clip begins
  end: number;            // timeline time the clip ends (start + source duration)
  duration: number;       // end - start (the clip's own length)
  /** Transition into the next clip, duration clamped to what both clips can
   *  give (null on the tail, or when the clip has none). */
  transitionOut: Transition | null;
  /** Fades clamped so in + out never exceed the clip. 0 = none. */
  fadeIn: number;
  fadeOut: number;
}

export interface TimelineLayout {
  clips: PlacedClip[];
  duration: number;       // total timeline duration (sum of clips minus overlaps)
}

export function layoutTimeline(timeline: Timeline): TimelineLayout {
  const ordered = clipsInOrder(timeline);
  const placed: PlacedClip[] = [];
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    const clip = ordered[i]!;
    const next = ordered[i + 1];
    const duration = clip.outPoint - clip.inPoint;
    const start = cursor;
    const end = start + duration;

    let transitionOut: Transition | null = null;
    if (clip.transitionOut && next) {
      const nextDur = next.outPoint - next.inPoint;
      const d = Math.min(clip.transitionOut.duration, duration, nextDur);
      if (d > 0) transitionOut = { type: clip.transitionOut.type, duration: d };
    }

    let fadeIn = Math.max(0, Math.min(clip.fadeIn ?? 0, duration));
    let fadeOut = Math.max(0, Math.min(clip.fadeOut ?? 0, duration));
    if (fadeIn + fadeOut > duration) {
      const scale = duration / (fadeIn + fadeOut);
      fadeIn *= scale;
      fadeOut *= scale;
    }

    placed.push({ clip, start, end, duration, transitionOut, fadeIn, fadeOut });
    cursor = end - (transitionOut?.duration ?? 0);
  }
  return { clips: placed, duration: placed.length > 0 ? placed[placed.length - 1]!.end : 0 };
}

/** Total timeline duration, transitions accounted for. */
export function timelineDuration(timeline: Timeline): number {
  return layoutTimeline(timeline).duration;
}

// ── Overlays ──────────────────────────────────────────────────────────────────

/** The overlay track in stacking order (bottom first). Never undefined. */
export function overlaysOf(timeline: Timeline): Overlay[] {
  return timeline.overlays ?? [];
}

/**
 * Overlay display refs are "o1", "o2", … in stacking order — a separate
 * namespace from clip refs so `/overlay move o1 …` can never be confused with
 * clip [1]. Returns Map<overlayId, displayRef>.
 */
export function getOverlayDisplayRefs(timeline: Timeline): Map<string, string> {
  const refs = new Map<string, string>();
  overlaysOf(timeline).forEach((o, i) => refs.set(o.id, `o${i + 1}`));
  return refs;
}

/**
 * Resolve an overlay reference: a UUID, a display ref ("o2"), or a bare
 * 1-based index ("2"). Returns undefined if nothing matches.
 */
export function resolveOverlay(timeline: Timeline, ref: string): Overlay | undefined {
  const overlays = overlaysOf(timeline);
  const direct = overlays.find((o) => o.id === ref);
  if (direct) return direct;
  const m = /^o?(\d+)$/i.exec(ref.trim());
  if (!m) return undefined;
  const idx = Number(m[1]) - 1;
  return idx >= 0 && idx < overlays.length ? overlays[idx] : undefined;
}

/** Fractional (ax, ay) of the overlay's own frame that an anchor pins. */
export function anchorFractions(anchor: OverlayAnchor): { ax: number; ay: number } {
  const ax = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 1 : 0.5;
  const ay = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 1 : 0.5;
  return { ax, ay };
}

/** Timeline-time span an overlay occupies: [at, at + (out - in)). */
export function overlaySpan(o: Overlay): { start: number; end: number } {
  return { start: o.at, end: o.at + (o.outPoint - o.inPoint) };
}

// Convert a MediaInfo (from probe.ts) into a SourceFile
export function sourceFileFromMediaInfo(info: MediaInfo): SourceFile {
  return {
    id: crypto.randomUUID(),
    filePath: info.filePath,
    fileName: info.fileName,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec,
    fileSize: info.fileSize,
    analyses: {},
  };
}

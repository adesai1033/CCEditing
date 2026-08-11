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

export interface MomentCacheEntry {
  query: string;
  hits: Array<{ start: number; end: number; confidence: number }>;
  retrievedAt: string;
}

export interface SegmentDescriptionEntry {
  start: number;
  end: number;
  text: string;
  model: string;
  generatedAt: string;
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
}

export interface Timeline {
  headId: string | null;           // first clip in playback order
  tailId: string | null;           // last clip — kept for O(1) append
  clips: Record<string, Clip>;     // keyed by clip ID for O(1) lookup
}

export interface ProjectState {
  version: number;        // schema version for future migrations
  name: string;
  createdAt: string;      // ISO timestamp
  updatedAt: string;      // ISO timestamp
  sources: SourceFile[];
  timeline: Timeline;
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

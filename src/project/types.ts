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
}

export interface MomentCacheEntry {
  query: string;
  hits: Array<{ start: number; end: number; confidence: number }>;
  retrievedAt: string;
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

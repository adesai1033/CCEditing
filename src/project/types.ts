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
}

export interface Clip {
  id: string;             // uuid
  sourceId: string;       // references SourceFile.id
  inPoint: number;        // start time within source (seconds)
  outPoint: number;       // end time within source (seconds)
  label: string;          // display name
  prevId: string | null;  // previous clip in timeline, null if head
  nextId: string | null;  // next clip in timeline, null if tail
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

// Resolve a clip reference that is either a 1-based integer string ("2")
// or a clip ID (UUID). Returns undefined if not found.
export function resolveClip(timeline: Timeline, ref: string): Clip | undefined {
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1) {
    return clipsInOrder(timeline)[n - 1];
  }
  return timeline.clips[ref];
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
  };
}

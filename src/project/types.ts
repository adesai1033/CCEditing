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
}

export interface Timeline {
  clips: Clip[];          // ordered sequence, plays first to last
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

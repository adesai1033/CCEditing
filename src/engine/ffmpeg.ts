import type { TrimOperation, ConcatOperation, EditOperation } from "./types.js";

/**
 * Build the FFmpeg argument list for a trim operation.
 *
 * Strategy: output seeking (-ss after -i) forces FFmpeg to decode every frame
 * from the nearest keyframe to the exact timestamp, giving frame-accurate cuts.
 * We re-encode the video (libx264, CRF 18, fast preset) because stream copy
 * cannot produce frame-accurate cuts — it can only split on keyframe boundaries.
 * Audio is re-encoded to AAC to stay in sync with the new video segment.
 *
 * Tradeoff vs stream copy: slower (seconds vs milliseconds for large files),
 * but the output starts and ends on the exact requested frame.
 */
export function buildTrimArgs(op: TrimOperation): string[] {
  const duration = op.end - op.start;
  return [
    "-i", op.input,
    "-ss", String(op.start),
    "-t", String(duration),
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "fast",
    "-c:a", "aac",
    "-y",
    op.output,
  ];
}

/** Returns the content of an FFmpeg concat demuxer list file. */
export function buildConcatFileContent(segmentPaths: string[]): string {
  return segmentPaths.map((p) => `file '${p}'`).join("\n") + "\n";
}

export function buildConcatArgs(op: ConcatOperation, listFilePath: string): string[] {
  return ["-f", "concat", "-safe", "0", "-i", listFilePath, "-c", "copy", "-y", op.output];
}

export function buildArgs(op: EditOperation, listFilePath?: string): string[] {
  switch (op.type) {
    case "trim":
      return buildTrimArgs(op);
    case "concat":
      return buildConcatArgs(op, listFilePath!);
  }
}

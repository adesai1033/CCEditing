import type { TrimOperation, EditOperation } from "./types.js";

/**
 * Build the FFmpeg argument list for a trim operation.
 *
 * Strategy: input seeking (-ss before -i) for fast seeks to keyframe,
 * then -t for duration (not -to, which behaves differently with input seeking).
 * Stream copy (-c copy) avoids re-encoding.
 */
export function buildTrimArgs(op: TrimOperation): string[] {
  const duration = op.end - op.start;
  return [
    "-ss", String(op.start),
    "-i", op.input,
    "-t", String(duration),
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-y",
    op.output,
  ];
}

export function buildArgs(op: EditOperation): string[] {
  switch (op.type) {
    case "trim":
      return buildTrimArgs(op);
  }
}

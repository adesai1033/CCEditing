import type { TrimOperation, ConcatOperation, EditOperation } from "./types.js";

/**
 * Encoder quality knobs for a trim re-encode. Seek/cut precision is NOT a knob:
 * every caller gets the same frame-accurate output-seeking strategy; these only
 * trade picture quality for speed (preview, 3H) vs fidelity (export).
 */
export interface EncodeSettings {
  crf: number;
  preset: string;
  /** Downscale to at most this height (keeping aspect); undefined = keep native. */
  maxHeight?: number;
  /** Cap the audio bitrate; undefined = encoder default. */
  audioBitrate?: string;
}

/** The export defaults — full resolution, near-transparent quality. */
export const EXPORT_ENCODE: EncodeSettings = { crf: 18, preset: "fast" };

/**
 * Build the FFmpeg argument list for a trim operation.
 *
 * Strategy: output seeking (-ss after -i) forces FFmpeg to decode every frame
 * from the nearest keyframe to the exact timestamp, giving frame-accurate cuts.
 * We re-encode the video (libx264) because stream copy cannot produce
 * frame-accurate cuts — it can only split on keyframe boundaries. Audio is
 * re-encoded to AAC to stay in sync with the new video segment.
 *
 * Tradeoff vs stream copy: slower (seconds vs milliseconds for large files),
 * but the output starts and ends on the exact requested frame.
 */
export function buildTrimArgs(op: TrimOperation, enc: EncodeSettings = EXPORT_ENCODE): string[] {
  const duration = op.end - op.start;
  return [
    "-i", op.input,
    "-ss", String(op.start),
    "-t", String(duration),
    // The comma inside min() is escaped so the filter parser doesn't read it
    // as a filter separator.
    ...(enc.maxHeight !== undefined ? ["-vf", `scale=-2:min(${enc.maxHeight}\\,ih)`] : []),
    "-c:v", "libx264",
    "-crf", String(enc.crf),
    "-preset", enc.preset,
    "-c:a", "aac",
    ...(enc.audioBitrate !== undefined ? ["-b:a", enc.audioBitrate] : []),
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

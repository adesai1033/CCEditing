import type { TrimOperation, ConcatOperation, JoinOperation, JoinSegment, OverlayOperation, OverlayLayer, EditOperation } from "./types.js";
import { anchorFractions } from "../project/types.js";

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

// ── Join with transitions & fades ─────────────────────────────────────────────

export interface JoinTarget extends FrameSize { fps: number }

/**
 * True when every segment shares one frame size and rate, so the concat
 * demuxer can stream-copy them. Mixed sources (a 60fps 4K phone clip next to a
 * variable-rate screen recording) can't be copied together: measured, the copy
 * produced a file with 2,023s of video timestamps over 227s of audio, and the
 * overlay pass on top of it then stalled. Those go through the filter join,
 * which conforms every input to the first.
 */
export function formatsMatch(infos: Array<{ width: number; height: number; fps: number }>): boolean {
  const [first, ...rest] = infos;
  if (!first) return true;
  return rest.every((i) => i.width === first.width && i.height === first.height && Math.abs(i.fps - first.fps) < 0.01);
}

/** True when the segments need the filter-graph join rather than a stream copy. */
export function joinNeedsFilter(segments: JoinSegment[]): boolean {
  return segments.some((s, i) =>
    (s.fadeIn ?? 0) > 0 || (s.fadeOut ?? 0) > 0 ||
    (i < segments.length - 1 && (s.transitionOut?.duration ?? 0) > 0));
}

/**
 * Build the filter_complex that joins segments left to right. Each input is
 * first normalized (size, SAR, fps, pixel format, timebase; audio to 48 kHz
 * stereo float) and given its edge fades; then the running result is either
 * crossfaded into the next segment (xfade/acrossfade, offset = where the
 * overlap begins in the accumulated output) or hard-concatenated to it.
 * Audio is joined only when EVERY segment has it; a mix is rejected upstream.
 */
export function buildJoinFilter(segments: JoinSegment[], target: JoinTarget): { filter: string; audio: boolean } {
  const audio = segments.every((s) => s.hasAudio);
  const parts: string[] = [];

  segments.forEach((seg, i) => {
    const v: string[] = [
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
      `fps=${num(target.fps)}`,
      "format=yuv420p",
      "settb=AVTB",
    ];
    const a: string[] = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", "asetpts=PTS-STARTPTS"];
    const fi = seg.fadeIn ?? 0;
    const fo = seg.fadeOut ?? 0;
    if (fi > 0) { v.push(`fade=t=in:st=0:d=${num(fi)}`); a.push(`afade=t=in:st=0:d=${num(fi)}`); }
    if (fo > 0) {
      const st = Math.max(0, seg.duration - fo);
      v.push(`fade=t=out:st=${num(st)}:d=${num(fo)}`);
      a.push(`afade=t=out:st=${num(st)}:d=${num(fo)}`);
    }
    parts.push(`[${i}:v]${v.join(",")}[v${i}]`);
    if (audio) parts.push(`[${i}:a]${a.join(",")}[a${i}]`);
  });

  // Fold left: [acc] ⊕ [next] → [acc'] tracking the accumulated duration so
  // each xfade offset lands where the previous material ends minus overlap.
  let accV = "[v0]";
  let accA = "[a0]";
  let accDur = segments[0]!.duration;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    const outV = last ? "[vout]" : `[vj${i}]`;
    const outA = last ? "[aout]" : `[aj${i}]`;
    const d = Math.min(prev.transitionOut?.duration ?? 0, accDur, seg.duration);
    if (d > 0) {
      const type = prev.transitionOut!.type;
      const offset = Math.max(0, accDur - d);
      parts.push(`${accV}[v${i}]xfade=transition=${type}:duration=${num(d)}:offset=${num(offset)}${outV}`);
      if (audio) parts.push(`${accA}[a${i}]acrossfade=d=${num(d)}:c1=tri:c2=tri${outA}`);
      accDur = accDur + seg.duration - d;
    } else {
      parts.push(`${accV}[v${i}]concat=n=2:v=1:a=0${outV}`);
      if (audio) parts.push(`${accA}[a${i}]concat=n=2:v=0:a=1${outA}`);
      accDur += seg.duration;
    }
    accV = outV;
    accA = outA;
  }
  if (segments.length === 1) {
    // Nothing to join: rename the normalized single input to the output pads.
    parts[0] = parts[0]!.replace(/\[v0\]$/, "[vout]");
    if (audio) parts[1] = parts[1]!.replace(/\[a0\]$/, "[aout]");
  }
  return { filter: parts.join(";"), audio };
}

export function buildJoinArgs(op: JoinOperation, target: JoinTarget, enc: EncodeSettings = EXPORT_ENCODE): string[] {
  const { filter, audio } = buildJoinFilter(op.segments, target);
  return [
    ...op.segments.flatMap((s) => ["-i", s.path]),
    "-filter_complex", filter,
    "-map", "[vout]",
    ...(audio ? ["-map", "[aout]"] : []),
    "-c:v", "libx264",
    "-crf", String(enc.crf),
    "-preset", enc.preset,
    ...(audio ? ["-c:a", "aac", ...(enc.audioBitrate !== undefined ? ["-b:a", enc.audioBitrate] : [])] : []),
    "-y",
    op.output,
  ];
}

// ── Overlay compositing ───────────────────────────────────────────────────────

export interface FrameSize { width: number; height: number }

export interface OverlayPlacementPx {
  width: number;   // even
  height: number;  // even
  x: number;       // may be negative / past the edge (partly off-screen)
  y: number;
}

const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2));

/**
 * Resolve a layer's fractional geometry to pixels on a concrete base frame.
 * Width comes from `scale`; height follows the overlay's own aspect; both are
 * forced even for libx264. The anchor point of the scaled overlay is then
 * placed at (x·baseW, y·baseH).
 */
export function computeOverlayPlacement(layer: OverlayLayer, base: FrameSize): OverlayPlacementPx {
  // A full-frame cutaway occupies exactly the frame.
  if (layer.fit) return { width: base.width, height: base.height, x: 0, y: 0 };
  const width = even(layer.scale * base.width);
  const aspect = layer.sourceWidth > 0 && layer.sourceHeight > 0
    ? layer.sourceHeight / layer.sourceWidth
    : base.height / base.width;
  const height = even(width * aspect);
  const { ax, ay } = anchorFractions(layer.anchor);
  return {
    width,
    height,
    x: Math.round(layer.x * base.width - ax * width),
    y: Math.round(layer.y * base.height - ay * height),
  };
}

/**
 * Scale step for one layer. Picture-in-picture: an exact size. Cutaways are
 * conformed to the frame — "cover" scales up to fill and center-crops the
 * overflow; "contain" scales down to fit and pads with black — so a 9:16
 * phone clip or an odd-sized screen recording never leaves the base peeking
 * through.
 */
function layerScaleFilter(layer: OverlayLayer, p: OverlayPlacementPx, base: FrameSize): string {
  const W = base.width;
  const H = base.height;
  switch (layer.fit) {
    case "cover":
      return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    case "contain":
      return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    default:
      return `scale=${p.width}:${p.height}`;
  }
}

/** Format a filtergraph number: no exponent, no trailing noise. */
const num = (n: number): string => Number(n.toFixed(3)).toString();

/**
 * Build the filter_complex for stacking `layers` on input 0. Each layer is
 * input i+1, pre-seeked to its in-point (see buildOverlayArgs) so its frames
 * start at t=0; setpts shifts them to `at`. Before `at` the overlay stream
 * has no frame yet and the base passes through; after it ends eof_action=pass
 * keeps the base going; `enable` pins the exact window so a trailing frame is
 * never held past the out-point.
 */
export function buildOverlayFilter(layers: OverlayLayer[], base: FrameSize): string {
  const parts: string[] = [];
  let last = "[0:v]";
  layers.forEach((layer, i) => {
    const p = computeOverlayPlacement(layer, base);
    const dur = layer.outPoint - layer.inPoint;
    const ov = `[ov${i}]`;
    const out = i === layers.length - 1 ? "[vout]" : `[v${i}]`;
    parts.push(`[${i + 1}:v]${layerScaleFilter(layer, p, base)},setpts=PTS-STARTPTS+${num(layer.at)}/TB${ov}`);
    parts.push(
      `${last}${ov}overlay=x=${p.x}:y=${p.y}:eof_action=pass` +
      `:enable=between(t\\,${num(layer.at)}\\,${num(layer.at + dur)})${out}`,
    );
    last = out;
  });
  // The final format is applied on the way out so every layer sees yuv420p.
  const lastIdx = parts.length - 1;
  parts[lastIdx] = parts[lastIdx]!.replace(/\[vout\]$/, ",format=yuv420p[vout]");
  return parts.join(";");
}

/**
 * FFmpeg args compositing overlay layers onto an already-rendered base. Each
 * layer is trimmed by input seeking (-ss/-t before -i: decoded from the
 * nearest keyframe and discarded up to the exact point, so the first emitted
 * frame is the requested one), then scaled, delayed and stacked in order.
 * The base's audio is carried over untouched; overlay audio is dropped.
 */
export function buildOverlayArgs(op: OverlayOperation, base: FrameSize, enc: EncodeSettings = EXPORT_ENCODE): string[] {
  const inputs: string[] = ["-i", op.base];
  for (const layer of op.layers) {
    inputs.push("-ss", num(layer.inPoint), "-t", num(layer.outPoint - layer.inPoint), "-i", layer.input);
  }
  return [
    ...inputs,
    "-filter_complex", buildOverlayFilter(op.layers, base),
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-crf", String(enc.crf),
    "-preset", enc.preset,
    "-c:a", "copy",
    "-y",
    op.output,
  ];
}

export function buildArgs(op: EditOperation, listFilePath?: string, base?: FrameSize | JoinTarget): string[] {
  switch (op.type) {
    case "trim":
      return buildTrimArgs(op);
    case "concat":
      return buildConcatArgs(op, listFilePath!);
    case "join":
      return buildJoinArgs(op, base as JoinTarget);
    case "overlay":
      return buildOverlayArgs(op, base!);
  }
}

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
/** The export defaults — full resolution, near-transparent quality, and
 *  audio at a bitrate that doesn't fall below a phone camera's AAC (an unset
 *  bitrate measured 83 kbps on the final video). */
export const EXPORT_ENCODE: EncodeSettings = { crf: 18, preset: "fast", audioBitrate: "256k" };

/**
 * Build the FFmpeg argument list for a trim operation.
 *
 * Seeking: INPUT seeking (-ss/-t before -i). When re-encoding, FFmpeg decodes
 * from the keyframe before the cut and discards up to the exact timestamp, so
 * the first emitted frame is the requested one. Measured on a 4K/60fps HEVC
 * source: a 3 s cut at 2:02 came out frame-identical (PSNR ∞, same 180
 * frames) to the old output seeking (-ss after -i), in 14 s instead of 115 s —
 * output seeking decodes the file from its start to every cut point. On macOS
 * decoding is hardware accelerated (also frame-identical).
 *
 * We re-encode the video (libx264) because stream copy can only cut on
 * keyframes. Audio is re-encoded to AAC at the encode's bitrate.
 */
export function buildTrimArgs(op: TrimOperation, enc: EncodeSettings = EXPORT_ENCODE, platform: NodeJS.Platform = process.platform): string[] {
  const duration = op.end - op.start;
  return [
    ...(platform === "darwin" ? ["-hwaccel", "videotoolbox"] : []),
    "-ss", String(op.start),
    "-t", String(duration),
    "-i", op.input,
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

/**
 * The frame every joined segment is conformed to: the LARGEST segment's size
 * (by pixel count) and the highest frame rate among them. Picking the first
 * segment instead would quietly downscale a whole 4K video to 1080p whenever a
 * smaller clip happened to come first — the output must never be lower
 * resolution than its best source.
 */
export function conformTarget(infos: JoinTarget[]): JoinTarget {
  if (infos.length === 0) throw new Error("conformTarget needs at least one segment");
  const size = infos.reduce((best, i) => (i.width * i.height > best.width * best.height ? i : best));
  const fps = Math.max(...infos.map((i) => i.fps || 0)) || 30;
  return { width: size.width, height: size.height, fps };
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
export interface JoinFilterOptions {
  /** Output pad names (default [vout] / [aout]). */
  labels?: { video: string; audio: string };
  /** Generate silence for segments without audio instead of dropping audio
   *  for the whole join (the single-pass render uses this). */
  synthesizeSilence?: boolean;
}

export function buildJoinFilter(segments: JoinSegment[], target: JoinTarget, opts: JoinFilterOptions = {}): { filter: string; audio: boolean } {
  const vOut = opts.labels?.video ?? "[vout]";
  const aOut = opts.labels?.audio ?? "[aout]";
  const audio = opts.synthesizeSilence ? segments.some((s) => s.hasAudio) : segments.every((s) => s.hasAudio);
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
    if (audio) {
      parts.push(seg.hasAudio
        ? `[${i}:a]${a.join(",")}[a${i}]`
        : `aevalsrc=0:c=stereo:s=48000:d=${num(seg.duration)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
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
    const outV = last ? vOut : `[vj${i}]`;
    const outA = last ? aOut : `[aj${i}]`;
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
    parts[0] = parts[0]!.replace(/\[v0\]$/, vOut);
    if (audio) parts[1] = parts[1]!.replace(/\[a0\]$/, aOut);
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
export interface OverlayFilterOptions {
  /** Pad holding the base picture (default [0:v]). */
  baseLabel?: string;
  /** Input index of the first layer (default 1). */
  firstInput?: number;
}

export function buildOverlayFilter(layers: OverlayLayer[], base: FrameSize, opts: OverlayFilterOptions = {}): string {
  const parts: string[] = [];
  let last = opts.baseLabel ?? "[0:v]";
  const first = opts.firstInput ?? 1;
  layers.forEach((layer, i) => {
    const p = computeOverlayPlacement(layer, base);
    const dur = layer.outPoint - layer.inPoint;
    const ov = `[ov${i}]`;
    const out = i === layers.length - 1 ? "[vout]" : `[vo${i}]`;
    parts.push(`[${first + i}:v]${layerScaleFilter(layer, p, base)},setpts=PTS-STARTPTS+${num(layer.at)}/TB${ov}`);
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

// ── Single-pass render ────────────────────────────────────────────────────────

/** One main-track clip of a render: a range of a source plus its edge effects. */
export interface RenderClip {
  input: string;
  start: number;
  duration: number;
  hasAudio: boolean;
  fadeIn?: number;
  fadeOut?: number;
  transitionOut?: JoinSegment["transitionOut"];
}

export interface RenderPlan {
  clips: RenderClip[];
  layers: OverlayLayer[];     // `at` in timeline time
  target: JoinTarget;         // the output frame (conformTarget of the sources)
  output: string;
}

/**
 * The whole timeline in ONE FFmpeg invocation, straight from the sources:
 * every clip and overlay is an input trimmed by input seeking; the main track
 * is conformed and joined (cuts, transitions, fades) and the overlays are
 * composited on top inside one filter graph, then encoded once. The
 * trim → join → composite pipeline encoded the video three times — three
 * generations of loss and three passes of 4K encoding.
 */
export function buildRenderArgs(plan: RenderPlan, enc: EncodeSettings = EXPORT_ENCODE, platform: NodeJS.Platform = process.platform): string[] {
  if (plan.clips.length === 0) throw new Error("Nothing to render");
  const hw = platform === "darwin" ? ["-hwaccel", "videotoolbox"] : [];
  const inputs: string[] = [];
  for (const c of plan.clips) inputs.push(...hw, "-ss", num(c.start), "-t", num(c.duration), "-i", c.input);
  for (const l of plan.layers) inputs.push(...hw, "-ss", num(l.inPoint), "-t", num(l.outPoint - l.inPoint), "-i", l.input);

  const joinSegs: JoinSegment[] = plan.clips.map((c) => ({
    path: c.input, duration: c.duration, hasAudio: c.hasAudio,
    fadeIn: c.fadeIn, fadeOut: c.fadeOut, transitionOut: c.transitionOut ?? null,
  }));
  const layered = plan.layers.length > 0;
  const join = buildJoinFilter(joinSegs, plan.target, {
    labels: { video: layered ? "[vbase]" : "[vout]", audio: "[aout]" },
    synthesizeSilence: true,
  });
  const graph = layered
    ? `${join.filter};${buildOverlayFilter(plan.layers, plan.target, { baseLabel: "[vbase]", firstInput: plan.clips.length })}`
    : join.filter;

  return [
    ...inputs,
    "-filter_complex", graph,
    "-map", "[vout]",
    ...(join.audio ? ["-map", "[aout]"] : []),
    "-c:v", "libx264", "-crf", String(enc.crf), "-preset", enc.preset, "-pix_fmt", "yuv420p",
    ...(join.audio ? ["-c:a", "aac", ...(enc.audioBitrate !== undefined ? ["-b:a", enc.audioBitrate] : [])] : []),
    "-movflags", "+faststart",
    "-y", plan.output,
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

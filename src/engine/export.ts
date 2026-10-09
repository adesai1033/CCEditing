import path from "node:path";
import { stat } from "node:fs/promises";
import type { ProjectState } from "../project/types.js";
import { layoutTimeline } from "../project/types.js";
import { probeFile } from "../media/probe.js";
import { buildRenderArgs, conformTarget, EXPORT_ENCODE, type JoinTarget, type RenderClip } from "./ffmpeg.js";
import { overlayLayersFor } from "./layers.js";
import { runFfmpeg, type FfmpegRunner } from "./preview.js";

/**
 * The export, shared by `/export` and `cutcli export`: the whole timeline in a
 * single FFmpeg pass from the original files (buildRenderArgs) — one encode,
 * at the largest main-track source's resolution and the highest frame rate.
 * (It used to trim each clip, join, then composite: three encodes.)
 */

export interface ExportStep {
  kind: "render";
  index: number;
  total: number;
  detail: string;
}

export interface ExportOptions {
  onStep?: (step: ExportStep) => void;
  onStepDone?: (step: ExportStep) => void;
  /** 0–100, from FFmpeg's own progress. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Injected for tests. */
  ffmpeg?: FfmpegRunner;
  probe?: (file: string) => Promise<JoinTarget | null>;
}

export type ExportOutcome =
  | { ok: true; outputPath: string; outputSize: number; duration: number; clipCount: number; overlayCount: number }
  | { ok: false; error: string };

export async function exportTimeline(
  state: ProjectState,
  outputPath: string,
  opts: ExportOptions = {},
): Promise<ExportOutcome> {
  const layout = layoutTimeline(state.timeline);
  if (layout.clips.length === 0) return { ok: false, error: "Timeline is empty." };

  const sourceById = new Map(state.sources.map((s) => [s.id, s]));
  const clips: RenderClip[] = [];
  for (const [i, p] of layout.clips.entries()) {
    const source = sourceById.get(p.clip.sourceId);
    if (!source) return { ok: false, error: `Source file missing for clip [${i + 1}].` };
    clips.push({
      input: source.filePath,
      start: p.clip.inPoint,
      duration: p.duration,
      hasAudio: source.audioCodec != null,
      fadeIn: p.fadeIn,
      fadeOut: p.fadeOut,
      transitionOut: p.transitionOut,
    });
  }
  const layers = overlayLayersFor(state);
  if (!layers.ok) return { ok: false, error: layers.error };

  // Output frame: the largest main-track source at the highest frame rate.
  const probe = opts.probe ?? defaultProbe;
  const files = [...new Set(clips.map((c) => c.input))];
  const infos = await Promise.all(files.map((f) => probe(f)));
  const bad = infos.findIndex((x) => !x);
  if (bad >= 0) return { ok: false, error: `Could not read ${path.basename(files[bad]!)}` };
  const target = conformTarget(infos as JoinTarget[]);

  const absOutput = path.resolve(outputPath);
  const step: ExportStep = {
    kind: "render", index: 0, total: 1,
    detail: `${clips.length} clip${clips.length === 1 ? "" : "s"}` +
      (layers.layers.length > 0 ? `, ${layers.layers.length} overlay${layers.layers.length === 1 ? "" : "s"}` : "") +
      ` at ${target.width}×${target.height}`,
  };
  opts.onStep?.(step);
  const ffmpeg = opts.ffmpeg ?? runFfmpeg;
  const r = await ffmpeg(
    buildRenderArgs({ clips, layers: layers.layers, target, output: absOutput }, EXPORT_ENCODE),
    {
      signal: opts.signal,
      onOutTime: (sec) => opts.onProgress?.(Math.min(99, Math.round((sec / Math.max(layout.duration, 0.001)) * 100))),
    },
  );
  if (!r.ok) return { ok: false, error: `Render failed: ${r.error}` };
  opts.onStepDone?.(step);
  opts.onProgress?.(100);

  const size = (await stat(absOutput)).size;
  return {
    ok: true,
    outputPath: absOutput,
    outputSize: size,
    duration: layout.duration,
    clipCount: clips.length,
    overlayCount: layers.layers.length,
  };
}

async function defaultProbe(file: string): Promise<JoinTarget | null> {
  const r = await probeFile(file);
  return r.ok ? { width: r.data.width, height: r.data.height, fps: r.data.fps || 30 } : null;
}

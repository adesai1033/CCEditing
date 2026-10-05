import path from "node:path";
import os from "node:os";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import type { ProjectState } from "../project/types.js";
import { layoutTimeline } from "../project/types.js";
import type { JoinSegment } from "./types.js";
import { execute } from "./engine.js";
import { joinNeedsFilter, formatsMatch } from "./ffmpeg.js";
import { probeFile } from "../media/probe.js";
import { overlayLayersFor } from "./layers.js";

/**
 * The export pipeline, shared by `/export` and `cutcli export`:
 *   1. frame-accurate trim of every main-track clip to a temp segment
 *   2. the join: a concat-demuxer stream copy on a plain cut timeline
 *      (skipped for a single clip), or a filter-graph join re-encoding
 *      once any clip carries a transition or fade
 *   3. if the overlay track is non-empty, one compositing pass over the
 *      joined base — overlays are addressed in timeline time, so they can
 *      only be placed once the main track is a single continuous file.
 *
 * Steps are reported through `onStep` so the CLI can print per-segment
 * progress lines and the REPL can stay quiet.
 */

export interface ExportStep {
  kind: "trim" | "concat" | "join" | "overlay";
  index: number;      // 0-based, for trim steps
  total: number;      // number of trim steps
  detail: string;     // e.g. "clip1.mp4 (0:00 → 0:15)"
}

export interface ExportOptions {
  onStep?: (step: ExportStep) => void;
  onStepDone?: (step: ExportStep) => void;
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
  const clips = layout.clips.map((p) => p.clip);
  if (clips.length === 0) return { ok: false, error: "Timeline is empty." };

  const sourceMap = new Map(state.sources.map((s) => [s.id, s]));
  const layersResult = overlayLayersFor(state);
  if (!layersResult.ok) return { ok: false, error: layersResult.error };
  const layers = layersResult.layers;

  const absOutput = path.resolve(outputPath);
  const tmpDir = path.join(os.tmpdir(), `cutcli-export-${Date.now()}-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
  const cleanup = () => rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  try {
    // ── 1. trims ──────────────────────────────────────────────────────────
    const segPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!;
      const source = sourceMap.get(clip.sourceId);
      if (!source) return { ok: false, error: `Source file missing for clip [${i + 1}].` };

      const step: ExportStep = {
        kind: "trim", index: i, total: clips.length,
        detail: `${source.fileName} (${fmt(clip.inPoint)} → ${fmt(clip.outPoint)})`,
      };
      opts.onStep?.(step);
      const seg = path.join(tmpDir, `seg-${String(i).padStart(3, "0")}.mp4`);
      const r = await execute({ type: "trim", input: source.filePath, start: clip.inPoint, end: clip.outPoint, output: seg });
      if (!r.ok) return { ok: false, error: `Trim failed for clip [${i + 1}]: ${r.error}` };
      opts.onStepDone?.(step);
      segPaths.push(seg);
    }

    // ── 2. join ───────────────────────────────────────────────────────────
    // The base lands directly on the output path unless a compositing pass
    // still has to run over it.
    const basePath = layers.length > 0 ? path.join(tmpDir, "base.mp4") : absOutput;
    const joinSegments: JoinSegment[] = layout.clips.map((p, i) => ({
      path: segPaths[i]!,
      duration: p.duration,
      hasAudio: sourceMap.get(p.clip.sourceId)?.audioCodec != null,
      fadeIn: p.fadeIn,
      fadeOut: p.fadeOut,
      transitionOut: p.transitionOut,
    }));
    // Mixed sources can't be stream-copied together (see formatsMatch).
    let conform = false;
    if (!joinNeedsFilter(joinSegments) && segPaths.length > 1) {
      const infos = await Promise.all(segPaths.map(async (p) => {
        const r = await probeFile(p);
        return r.ok ? { width: r.data.width, height: r.data.height, fps: r.data.fps } : null;
      }));
      conform = infos.every((i) => i !== null) && !formatsMatch(infos as Array<{ width: number; height: number; fps: number }>);
    }
    if (joinNeedsFilter(joinSegments) || conform) {
      const detail = conform && !joinNeedsFilter(joinSegments) ? "mixed sizes and frame rates" : describeJoin(joinSegments);
      const step: ExportStep = { kind: "join", index: 0, total: clips.length, detail };
      opts.onStep?.(step);
      const joined = await execute({ type: "join", segments: joinSegments, output: basePath });
      if (!joined.ok) return { ok: false, error: `Join failed: ${joined.error}` };
      opts.onStepDone?.(step);
    } else if (segPaths.length === 1) {
      await rename(segPaths[0]!, basePath);
    } else {
      const step: ExportStep = { kind: "concat", index: 0, total: clips.length, detail: `${segPaths.length} segments` };
      opts.onStep?.(step);
      const concat = await execute({ type: "concat", segments: segPaths, output: basePath });
      if (!concat.ok) return { ok: false, error: `Concat failed: ${concat.error}` };
      opts.onStepDone?.(step);
    }

    // ── 3. overlays ───────────────────────────────────────────────────────
    if (layers.length > 0) {
      const step: ExportStep = {
        kind: "overlay", index: 0, total: clips.length,
        detail: `${layers.length} overlay${layers.length === 1 ? "" : "s"}`,
      };
      opts.onStep?.(step);
      const composed = await execute({ type: "overlay", base: basePath, layers, output: absOutput });
      if (!composed.ok) return { ok: false, error: `Overlay failed: ${composed.error}` };
      opts.onStepDone?.(step);
    }

    const size = (await stat(absOutput)).size;
    return {
      ok: true,
      outputPath: absOutput,
      outputSize: size,
      duration: layout.duration,
      clipCount: clips.length,
      overlayCount: layers.length,
    };
  } finally {
    await cleanup();
  }
}

function describeJoin(segments: JoinSegment[]): string {
  const transitions = segments.filter((s, i) => i < segments.length - 1 && (s.transitionOut?.duration ?? 0) > 0).length;
  const fades = segments.filter((s) => (s.fadeIn ?? 0) > 0).length + segments.filter((s) => (s.fadeOut ?? 0) > 0).length;
  const parts: string[] = [];
  if (transitions > 0) parts.push(`${transitions} transition${transitions === 1 ? "" : "s"}`);
  if (fades > 0) parts.push(`${fades} fade${fades === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

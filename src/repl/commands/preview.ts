import type { ProjectState } from "../../project/types.js";
import { resolveClip, getClipDisplayRefs, layoutTimeline, type PlacedClip } from "../../project/types.js";
import { applyOperations, type Operation } from "../../project/session.js";
import {
  renderPreviewFromSegments,
  openInPlayer,
  playInTerminal,
  type PreviewSegment,
  type SegmentEffects,
  type RenderPreviewResult,
  type PlayerLaunch,
  type TerminalPlayback,
} from "../../engine/preview.js";
import { parseTime } from "../../utils/time.js";
import { overlayLayersFor } from "../../engine/layers.js";
import type { OverlayLayer } from "../../engine/types.js";

/**
 * `/preview` and the confirm gate's `p` (3H): map a ProjectState — the real one
 * or a scratch post-plan one — onto renderable segments, render at preview
 * quality, and hand the result to the system player.
 *
 * READ-ONLY, structurally: this module imports applyOperations (the pure
 * state→state half of the plan machinery) and never applyPlan — previewing can
 * compute a would-be state but can never commit one, push an undo entry, or
 * touch persistence (decisions 1 & 9). The architecture guard pins this.
 */

// ── Scope ─────────────────────────────────────────────────────────────────────

export type PreviewScope =
  | { type: "timeline" }
  | { type: "clip"; ref: string }
  | { type: "range"; start: number; end: number };

export const PREVIEW_USAGE = "Usage: /preview [--term] [clip | start end]";

/** `--term` (or `--terminal`) anywhere in the args plays inline via timg. */
export function parsePreviewArgs(rawArgs: string[]):
  | { ok: true; scope: PreviewScope; terminal: boolean }
  | { ok: false; error: string } {
  const terminal = rawArgs.some((a) => a === "--term" || a === "--terminal");
  const args = rawArgs.filter((a) => a !== "--term" && a !== "--terminal");
  const unknownFlag = args.find((a) => a.startsWith("--"));
  if (unknownFlag) return { ok: false, error: `Unknown option ${unknownFlag}. ${PREVIEW_USAGE}` };

  if (args.length === 0) return { ok: true, scope: { type: "timeline" }, terminal };
  if (args.length === 1) return { ok: true, scope: { type: "clip", ref: args[0]! }, terminal };
  if (args.length === 2) {
    let start: number, end: number;
    try {
      start = parseTime(args[0]!);
      end = parseTime(args[1]!);
    } catch (e) {
      return { ok: false, error: `Error: ${(e as Error).message}` };
    }
    if (end <= start) return { ok: false, error: "Range end must be after its start." };
    return { ok: true, scope: { type: "range", start, end }, terminal };
  }
  return { ok: false, error: PREVIEW_USAGE };
}

// ── State → segments ──────────────────────────────────────────────────────────

/** A [start, end) span of TIMELINE time — what a scope covers of the main track. */
export interface TimelineWindow { start: number; end: number }

export function segmentsForScope(state: ProjectState, scope: PreviewScope):
  | { ok: true; segments: PreviewSegment[]; window: TimelineWindow }
  | { ok: false; error: string } {
  const layout = layoutTimeline(state.timeline);
  const clips = layout.clips;
  if (clips.length === 0) return { ok: false, error: "No clips on timeline. Use /open to add a file." };
  const sourceById = new Map(state.sources.map((s) => [s.id, s]));
  const total = layout.duration;

  // Edge effects ride along only when the timeline has any: a plain cut
  // timeline keeps the bare {input, start, end} shape (and the stream-copy join).
  const anyEffects = clips.some((p) => p.transitionOut !== null || p.fadeIn > 0 || p.fadeOut > 0);

  const segmentFor = (
    placed: PlacedClip,
    start: number,
    end: number,
    effects: { fadeIn: boolean; fadeOut: boolean; transitionOut: boolean },
  ): { ok: true; segment: PreviewSegment } | { ok: false; error: string } => {
    const source = sourceById.get(placed.clip.sourceId);
    if (!source) return { ok: false, error: `Source file missing for clip "${placed.clip.label}".` };
    const segment: PreviewSegment = { input: source.filePath, start, end };
    if (anyEffects) {
      const e: SegmentEffects = { hasAudio: source.audioCodec != null };
      if (effects.fadeIn && placed.fadeIn > 0) e.fadeIn = placed.fadeIn;
      if (effects.fadeOut && placed.fadeOut > 0) e.fadeOut = placed.fadeOut;
      if (effects.transitionOut && placed.transitionOut) e.transitionOut = placed.transitionOut;
      segment.effects = e;
    }
    return { ok: true, segment };
  };

  switch (scope.type) {
    case "timeline": {
      const segments: PreviewSegment[] = [];
      for (const placed of clips) {
        const r = segmentFor(placed, placed.clip.inPoint, placed.clip.outPoint, { fadeIn: true, fadeOut: true, transitionOut: true });
        if (!r.ok) return r;
        segments.push(r.segment);
      }
      return { ok: true, segments, window: { start: 0, end: total } };
    }

    case "clip": {
      const clip = resolveClip(state.timeline, scope.ref);
      const placed = clip ? clips.find((p) => p.clip.id === clip.id) : undefined;
      if (!placed) return { ok: false, error: `Clip "${scope.ref}" not found (1–${clips.length}).` };
      // A lone clip keeps its own fades; its out-transition has nothing to blend into.
      const r = segmentFor(placed, placed.clip.inPoint, placed.clip.outPoint, { fadeIn: true, fadeOut: true, transitionOut: false });
      if (!r.ok) return r;
      return { ok: true, segments: [r.segment], window: { start: placed.start, end: placed.end } };
    }

    case "range": {
      // Map a [start, end) window of TIMELINE time onto per-clip source
      // ranges. Crossfaded neighbours overlap in timeline time, so both sides
      // of an overlap that falls inside the window are included and the
      // transition between them is kept (its duration clamps to what's left).
      if (scope.start >= total) {
        return { ok: false, error: `Range starts past the end of the timeline (${total.toFixed(1)}s total).` };
      }
      const rangeEnd = Math.min(scope.end, total);
      const segments: PreviewSegment[] = [];
      for (let i = 0; i < clips.length; i++) {
        const placed = clips[i]!;
        const overlapStart = Math.max(scope.start, placed.start);
        const overlapEnd = Math.min(rangeEnd, placed.end);
        if (overlapEnd <= overlapStart) continue;
        const next = clips[i + 1];
        const nextIncluded = next !== undefined && next.start < rangeEnd;
        const r = segmentFor(
          placed,
          placed.clip.inPoint + (overlapStart - placed.start),
          placed.clip.inPoint + (overlapEnd - placed.start),
          {
            fadeIn: overlapStart === placed.start,
            fadeOut: overlapEnd === placed.end,
            transitionOut: nextIncluded,
          },
        );
        if (!r.ok) return r;
        segments.push(r.segment);
      }
      return { ok: true, segments, window: { start: scope.start, end: rangeEnd } };
    }
  }
}

// ── Scratch plan application (decision 1) ─────────────────────────────────────

/**
 * The post-plan state as a scratch VALUE: same operation semantics as
 * applyPlan (shared applyOperations), zero commitment — the caller renders it
 * and drops it. The input session state is immutable and untouched.
 */
export function scratchStateForPlan(state: ProjectState, ops: Operation[]):
  | { ok: true; state: ProjectState }
  | { ok: false; error: string } {
  const r = applyOperations(state, ops);
  if (!r.ok) {
    return { ok: false, error: `This plan can't be previewed — operation ${r.failedAt + 1} fails: ${r.error}` };
  }
  return { ok: true, state: r.state };
}

// ── Render + open orchestration ───────────────────────────────────────────────

export interface PreviewDeps {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Play inline in the terminal (timg) instead of launching the system player. */
  terminal?: boolean;
  /**
   * Fired just before / after inline playback takes over the screen, so the
   * REPL can freeze its own redraws (a spinner tick painted over the video is
   * the failure mode). Awaited so the last frame lands before the handoff.
   */
  onPlayback?: (playing: boolean) => void | Promise<void>;
  /** Injected for tests. Defaults to the real renderer / player launcher. */
  render?: (segments: PreviewSegment[], opts: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
    overlays?: OverlayLayer[];
  }) => Promise<RenderPreviewResult>;
  open?: (path: string) => Promise<PlayerLaunch>;
  play?: (path: string, opts: { signal?: AbortSignal }) => Promise<TerminalPlayback>;
}

export type PreviewOutcome =
  | { ok: true; message: string }
  | { ok: false; error: string; aborted?: boolean };

/** Render one scope of one state and hand the file to the player. */
export async function previewStateScope(
  state: ProjectState,
  scope: PreviewScope,
  deps: PreviewDeps = {},
): Promise<PreviewOutcome> {
  const segs = segmentsForScope(state, scope);
  if (!segs.ok) return { ok: false, error: segs.error };
  // Overlays intersecting the rendered window, re-based to the file's t=0.
  const layers = overlayLayersFor(state, segs.window);
  if (!layers.ok) return { ok: false, error: layers.error };

  const render = deps.render ?? renderPreviewFromSegments;
  const r = await render(segs.segments, {
    onProgress: deps.onProgress,
    signal: deps.signal,
    ...(layers.layers.length > 0 ? { overlays: layers.layers } : {}),
  });
  if (!r.ok) {
    if (r.code === "ABORTED") return { ok: false, error: "Preview cancelled.", aborted: true };
    return { ok: false, error: `Preview failed: ${r.error}` };
  }

  const reuse = r.cachedSegments > 0
    ? `  ·  ${r.cachedSegments} segment${r.cachedSegments === 1 ? "" : "s"} reused from cache`
    : "";

  if (deps.terminal) {
    const play = deps.play ?? playInTerminal;
    await deps.onPlayback?.(true);
    let played: TerminalPlayback;
    try {
      played = await play(r.path, { signal: deps.signal });
    } finally {
      await deps.onPlayback?.(false);
    }
    if (!played.ok) {
      if (played.code === "ABORTED") return { ok: false, error: "Preview stopped.", aborted: true };
      // The file is rendered and fine — point at it so the fallback is one step.
      return { ok: false, error: `${played.error}\nPreview rendered — open it manually:${reuse}\n${r.path}` };
    }
    return { ok: true, message: `Preview played in the terminal${reuse}\n${r.path}` };
  }

  const open = deps.open ?? openInPlayer;
  const launch = await open(r.path);
  return {
    ok: true,
    message: launch.launched
      ? `Preview playing in the system player${reuse}\n${r.path}`
      : `Preview rendered — couldn't launch a player, open it manually:${reuse}\n${r.path}`,
  };
}

/** A friendly one-line description of a preview scope, for status output. */
export function describeScope(state: ProjectState, scope: PreviewScope): string {
  switch (scope.type) {
    case "timeline": return "timeline";
    case "clip": {
      const clip = resolveClip(state.timeline, scope.ref);
      const ref = clip ? getClipDisplayRefs(state.timeline).get(clip.id) ?? scope.ref : scope.ref;
      return `clip [${ref}]`;
    }
    case "range": return `${scope.start.toFixed(1)}s–${scope.end.toFixed(1)}s`;
  }
}

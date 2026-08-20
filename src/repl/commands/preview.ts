import type { ProjectState } from "../../project/types.js";
import { clipsInOrder, resolveClip, getClipDisplayRefs } from "../../project/types.js";
import { applyOperations, type Operation } from "../../project/session.js";
import {
  renderPreviewFromSegments,
  openInPlayer,
  type PreviewSegment,
  type RenderPreviewResult,
  type PlayerLaunch,
} from "../../engine/preview.js";
import { parseTime } from "../../utils/time.js";

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

export function parsePreviewArgs(args: string[]):
  | { ok: true; scope: PreviewScope }
  | { ok: false; error: string } {
  if (args.length === 0) return { ok: true, scope: { type: "timeline" } };
  if (args.length === 1) return { ok: true, scope: { type: "clip", ref: args[0]! } };
  if (args.length === 2) {
    let start: number, end: number;
    try {
      start = parseTime(args[0]!);
      end = parseTime(args[1]!);
    } catch (e) {
      return { ok: false, error: `Error: ${(e as Error).message}` };
    }
    if (end <= start) return { ok: false, error: "Range end must be after its start." };
    return { ok: true, scope: { type: "range", start, end } };
  }
  return { ok: false, error: "Usage: /preview [clip | start end]" };
}

// ── State → segments ──────────────────────────────────────────────────────────

export function segmentsForScope(state: ProjectState, scope: PreviewScope):
  | { ok: true; segments: PreviewSegment[] }
  | { ok: false; error: string } {
  const clips = clipsInOrder(state.timeline);
  if (clips.length === 0) return { ok: false, error: "No clips on timeline. Use /open to add a file." };
  const sourceById = new Map(state.sources.map((s) => [s.id, s]));

  const segmentFor = (clip: (typeof clips)[number], start: number, end: number):
    | { ok: true; segment: PreviewSegment }
    | { ok: false; error: string } => {
    const source = sourceById.get(clip.sourceId);
    if (!source) return { ok: false, error: `Source file missing for clip "${clip.label}".` };
    return { ok: true, segment: { input: source.filePath, start, end } };
  };

  switch (scope.type) {
    case "timeline": {
      const segments: PreviewSegment[] = [];
      for (const clip of clips) {
        const r = segmentFor(clip, clip.inPoint, clip.outPoint);
        if (!r.ok) return r;
        segments.push(r.segment);
      }
      return { ok: true, segments };
    }

    case "clip": {
      const clip = resolveClip(state.timeline, scope.ref);
      if (!clip) return { ok: false, error: `Clip "${scope.ref}" not found (1–${clips.length}).` };
      const r = segmentFor(clip, clip.inPoint, clip.outPoint);
      return r.ok ? { ok: true, segments: [r.segment] } : r;
    }

    case "range": {
      // Map a [start, end) window of TIMELINE time onto per-clip source ranges.
      const total = clips.reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
      if (scope.start >= total) {
        return { ok: false, error: `Range starts past the end of the timeline (${total.toFixed(1)}s total).` };
      }
      const segments: PreviewSegment[] = [];
      let offset = 0;
      for (const clip of clips) {
        const dur = clip.outPoint - clip.inPoint;
        const overlapStart = Math.max(scope.start, offset);
        const overlapEnd = Math.min(scope.end, offset + dur);
        if (overlapEnd > overlapStart) {
          const r = segmentFor(
            clip,
            clip.inPoint + (overlapStart - offset),
            clip.inPoint + (overlapEnd - offset),
          );
          if (!r.ok) return r;
          segments.push(r.segment);
        }
        offset += dur;
      }
      return { ok: true, segments };
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
  /** Injected for tests. Defaults to the real renderer / player launcher. */
  render?: (segments: PreviewSegment[], opts: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  }) => Promise<RenderPreviewResult>;
  open?: (path: string) => Promise<PlayerLaunch>;
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

  const render = deps.render ?? renderPreviewFromSegments;
  const r = await render(segs.segments, { onProgress: deps.onProgress, signal: deps.signal });
  if (!r.ok) {
    if (r.code === "ABORTED") return { ok: false, error: "Preview cancelled.", aborted: true };
    return { ok: false, error: `Preview failed: ${r.error}` };
  }

  const open = deps.open ?? openInPlayer;
  const launch = await open(r.path);
  const reuse = r.cachedSegments > 0
    ? `  ·  ${r.cachedSegments} segment${r.cachedSegments === 1 ? "" : "s"} reused from cache`
    : "";
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

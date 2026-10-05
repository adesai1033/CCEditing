import type { ProjectState, Overlay } from "../project/types.js";
import { overlaysOf, overlaySpan } from "../project/types.js";
import type { OverlayLayer } from "./types.js";

/**
 * Project overlays → engine layers. Shared by preview and export so both
 * composite the same thing (a preview that diverges from the export is worse
 * than no preview).
 *
 * `window` is a [start, end) span of TIMELINE time: the part of the main
 * track being rendered. Overlays are clipped to it and re-based so that
 * `at` is relative to the rendered file's own t=0. An overlay that doesn't
 * intersect the window is dropped. Omitting the window renders the whole
 * timeline (window = [0, ∞)).
 */
export function overlayLayersFor(
  state: ProjectState,
  window?: { start: number; end: number },
): { ok: true; layers: OverlayLayer[] } | { ok: false; error: string } {
  const sourceById = new Map(state.sources.map((s) => [s.id, s]));
  const wStart = window?.start ?? 0;
  const wEnd = window?.end ?? Number.POSITIVE_INFINITY;
  const layers: OverlayLayer[] = [];

  for (const o of overlaysOf(state.timeline)) {
    const clipped = clipOverlayToWindow(o, wStart, wEnd);
    if (!clipped) continue;
    const source = sourceById.get(o.sourceId);
    if (!source) return { ok: false, error: `Source file missing for overlay "${o.label}".` };
    layers.push({
      input: source.filePath,
      inPoint: clipped.inPoint,
      outPoint: clipped.outPoint,
      at: clipped.at,
      anchor: o.anchor,
      x: o.x,
      y: o.y,
      scale: o.scale,
      sourceWidth: source.width,
      sourceHeight: source.height,
      ...(o.fit ? { fit: o.fit } : {}),
    });
  }
  return { ok: true, layers };
}

/**
 * Intersect an overlay's timeline span with [wStart, wEnd) and return its
 * source range + start re-based to the window, or null when disjoint.
 */
export function clipOverlayToWindow(
  o: Overlay,
  wStart: number,
  wEnd: number,
): { at: number; inPoint: number; outPoint: number } | null {
  const { start, end } = overlaySpan(o);
  const visStart = Math.max(start, wStart);
  const visEnd = Math.min(end, wEnd);
  if (visEnd <= visStart) return null;
  return {
    at: visStart - wStart,
    inPoint: o.inPoint + (visStart - start),
    outPoint: o.outPoint - (end - visEnd),
  };
}

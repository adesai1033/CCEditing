import type { Overlay } from "../project/types.js";

/** "25%" — a fraction as a whole-number percent. */
export function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** "top-right @ 97%,3%" — anchor plus where it is pinned; "full frame" for a cutaway. */
export function formatOverlayPosition(o: Pick<Overlay, "anchor" | "x" | "y"> & { fit?: Overlay["fit"] }): string {
  if (o.fit) return "full frame";
  return `${o.anchor} @ ${pct(o.x)},${pct(o.y)}`;
}

/** "25% wide", or the fit mode for a cutaway. */
export function formatOverlaySize(o: Pick<Overlay, "scale"> & { fit?: Overlay["fit"] }): string {
  if (o.fit) return `cutaway (${o.fit})`;
  return `${pct(o.scale)} wide`;
}

/** "0:05 → 0:15" in timeline time. */
export function formatOverlaySpan(o: Pick<Overlay, "at" | "inPoint" | "outPoint">): string {
  return `${clock(o.at)} → ${clock(o.at + (o.outPoint - o.inPoint))}`;
}

export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

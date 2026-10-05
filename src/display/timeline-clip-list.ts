import type { ProjectState } from "../project/types.js";
import { getClipDisplayRefs, overlaysOf, getOverlayDisplayRefs, layoutTimeline } from "../project/types.js";
import { paint, glyphs } from "../ui/theme.js";
import { formatOverlayPosition, formatOverlaySize, formatOverlaySpan } from "./overlay-format.js";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join("");
}

/**
 * A numbered list of clips with in/out points and duration. Columns are sized
 * from the content (ref width, name width) so a run of rows scans vertically;
 * user labels (3E-3 /label) trail as a distinct chip.
 */
export function renderClipList(state: ProjectState): string {
  const layout = layoutTimeline(state.timeline);
  if (layout.clips.length === 0) return "";

  const sourceMap   = new Map(state.sources.map((s) => [s.id, s]));
  const displayRefs = getClipDisplayRefs(state.timeline);

  const rows = layout.clips.map((placed) => {
    const clip = placed.clip;
    const source = sourceMap.get(clip.sourceId);
    const name   = clip.label !== source?.fileName ? clip.label : (source?.fileName ?? clip.sourceId);
    return { clip, placed, name, ref: displayRefs.get(clip.id) ?? "?" };
  });

  const refWidth  = Math.max(...rows.map((r) => r.ref.length));
  const nameWidth = Math.min(32, Math.max(12, ...rows.map((r) => r.name.length)));

  const secs = (n: number) => `${Number(n.toFixed(2))}s`;
  const lines = rows.map(({ clip, placed, name, ref }) => {
    const duration = clip.outPoint - clip.inPoint;
    const refCol   = paint.accent(`[${ref}]`.padEnd(refWidth + 2));
    const nameCol  = paint.emphasis(name.slice(0, nameWidth).padEnd(nameWidth));
    const range    = paint.muted(`${formatDuration(clip.inPoint)} ${glyphs.arrow} ${formatDuration(clip.outPoint)}`);
    const dur      = paint.muted(`(${formatSeconds(duration)})`);
    const tag      = clip.userLabel ? "  " + paint.warning(`${glyphs.label} ${clip.userLabel}`) : "";
    // Edge effects, in playback order: fade in, then what leads out of the clip.
    const edges: string[] = [];
    if (placed.fadeIn > 0)  edges.push(`${glyphs.fade} in ${secs(placed.fadeIn)}`);
    if (placed.fadeOut > 0) edges.push(`${glyphs.fade} out ${secs(placed.fadeOut)}`);
    if (placed.transitionOut) edges.push(`${glyphs.transition} ${placed.transitionOut.type} ${secs(placed.transitionOut.duration)}`);
    const edgeTag = edges.length > 0 ? "  " + paint.muted(edges.join("  ")) : "";
    return `  ${refCol} ${nameCol} ${range}  ${dur}${tag}${edgeTag}`;
  });

  // The overlay track, when present: refs live in their own "o" namespace
  // and times are TIMELINE times (where the overlay plays), unlike the clip
  // rows above, which show source in/out points.
  const overlays = overlaysOf(state.timeline);
  if (overlays.length > 0) {
    const oRefs = getOverlayDisplayRefs(state.timeline);
    lines.push("", paint.muted("  overlays"));
    for (const o of overlays) {
      const refCol  = paint.accent(`[${oRefs.get(o.id) ?? "?"}]`.padEnd(refWidth + 2));
      const nameCol = paint.emphasis(o.label.slice(0, nameWidth).padEnd(nameWidth));
      const span    = paint.muted(formatOverlaySpan(o));
      const place   = paint.muted(`${formatOverlayPosition(o)}  ${glyphs.bullet}  ${formatOverlaySize(o)}`);
      lines.push(`  ${refCol} ${nameCol} ${span}  ${place}`);
    }
  }

  return lines.join("\n");
}

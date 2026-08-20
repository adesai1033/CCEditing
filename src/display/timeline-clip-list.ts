import type { ProjectState } from "../project/types.js";
import { clipsInOrder, getClipDisplayRefs } from "../project/types.js";
import { paint, glyphs } from "../ui/theme.js";

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
  const ordered = clipsInOrder(state.timeline);
  if (ordered.length === 0) return "";

  const sourceMap   = new Map(state.sources.map((s) => [s.id, s]));
  const displayRefs = getClipDisplayRefs(state.timeline);

  const rows = ordered.map((clip) => {
    const source = sourceMap.get(clip.sourceId);
    const name   = clip.label !== source?.fileName ? clip.label : (source?.fileName ?? clip.sourceId);
    return { clip, name, ref: displayRefs.get(clip.id) ?? "?" };
  });

  const refWidth  = Math.max(...rows.map((r) => r.ref.length));
  const nameWidth = Math.min(32, Math.max(12, ...rows.map((r) => r.name.length)));

  const lines = rows.map(({ clip, name, ref }) => {
    const duration = clip.outPoint - clip.inPoint;
    const refCol   = paint.accent(`[${ref}]`.padEnd(refWidth + 2));
    const nameCol  = paint.emphasis(name.slice(0, nameWidth).padEnd(nameWidth));
    const range    = paint.muted(`${formatDuration(clip.inPoint)} ${glyphs.arrow} ${formatDuration(clip.outPoint)}`);
    const dur      = paint.muted(`(${formatSeconds(duration)})`);
    const tag      = clip.userLabel ? "  " + paint.warning(`${glyphs.label} ${clip.userLabel}`) : "";
    return `  ${refCol} ${nameCol} ${range}  ${dur}${tag}`;
  });

  return lines.join("\n");
}

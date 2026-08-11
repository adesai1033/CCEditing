import chalk from "chalk";
import type { ProjectState } from "../project/types.js";
import { clipsInOrder, getClipDisplayRefs } from "../project/types.js";

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

/** Renders a numbered list of clips with in/out points and duration. */
export function renderClipList(state: ProjectState): string {
  const ordered = clipsInOrder(state.timeline);
  if (ordered.length === 0) return "";

  const sourceMap  = new Map(state.sources.map((s) => [s.id, s]));
  const displayRefs = getClipDisplayRefs(state.timeline);

  const lines = ordered.map((clip) => {
    const source   = sourceMap.get(clip.sourceId);
    const name     = clip.label !== source?.fileName ? clip.label : (source?.fileName ?? clip.sourceId);
    const duration = clip.outPoint - clip.inPoint;
    const ref      = displayRefs.get(clip.id) ?? "?";
    const index    = chalk.dim(`[${ref}]`);
    const nameStr  = chalk.white(name.padEnd(24));
    const range    = chalk.dim(`${formatDuration(clip.inPoint)} → ${formatDuration(clip.outPoint)}`);
    const dur      = chalk.dim(`(${formatSeconds(duration)})`);
    const tag      = clip.userLabel ? "  " + chalk.dim(`♦ ${clip.userLabel}`) : "";
    return `  ${index} ${nameStr} ${range}  ${dur}${tag}`;
  });

  return lines.join("\n");
}

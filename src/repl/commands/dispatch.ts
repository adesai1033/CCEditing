import path from "node:path";
import os from "node:os";
import { mkdir, unlink } from "node:fs/promises";
import type { ProjectState } from "../../project/types.js";
import { clipsInOrder, resolveClip } from "../../project/types.js";
import type { ViewportState } from "../../display/timeline.js";
import { buildHelpText } from "./registry.js";
import { probeFile } from "../../media/probe.js";
import { renderMediaInfo, formatFileSize } from "../../display/media-info.js";
import { renderTimeline } from "../../display/timeline.js";
import { renderClipList } from "../../display/timeline-clip-list.js";
import { addSource, trimClip, reorderClip } from "../../project/mutations.js";
import { loadOrCreateProject, saveProjectToStandardPath } from "../../cli/project-context.js";
import { parseTime } from "../../utils/time.js";
import { execute } from "../../engine/engine.js";

export interface ReplState {
  project: ProjectState | null;
}

export interface DispatchResult {
  output: string;
  isError: boolean;
  newState?: ReplState;
  shouldExit?: boolean;
  activatesTimeline?: boolean;
}

export async function dispatch(
  raw: string,
  state: ReplState,
  viewport?: ViewportState,
): Promise<DispatchResult> {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("/")) {
    return { output: "Unknown input. Type /help to see available commands.", isError: true };
  }

  const [token, ...args] = trimmed.slice(1).split(/\s+/);
  const cmd = token?.toLowerCase();

  switch (cmd) {
    case "help":
      return { output: buildHelpText(), isError: false };

    case "quit":
      return { output: "Goodbye.", isError: false, shouldExit: true };

    case "open":
      return dispatchOpen(args, state);

    case "timeline":
      return dispatchTimeline(state, viewport);

    case "trim":
      return dispatchTrim(args, state);

    case "move":
      return dispatchMove(args, state);

    case "export":
      return dispatchExport(args, state);

    default:
      return { output: `Unknown command: /${cmd}. Type /help for available commands.`, isError: true };
  }
}

// ── /open ─────────────────────────────────────────────────────────────────────

async function dispatchOpen(args: string[], state: ReplState): Promise<DispatchResult> {
  const filePath = args[0];
  if (!filePath) return { output: "Usage: /open <file>", isError: true };

  const absPath = path.resolve(filePath);
  const probe = await probeFile(absPath);
  if (!probe.ok) return { output: `Error: ${probe.error}`, isError: true };

  const ctx = state.project
    ? { ok: true as const, state: state.project, existed: true }
    : await loadOrCreateProject();
  if (!ctx.ok) return { output: `Error: ${ctx.error}`, isError: true };

  const mutation = addSource(ctx.state, probe.data);
  if (!mutation.ok) return { output: `Error: ${mutation.error}`, isError: true };

  const saved = await saveProjectToStandardPath(mutation.state);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  const clipCount = clipsInOrder(mutation.state.timeline).length;
  return {
    output: renderMediaInfo(probe.data) + `\n\nAdded to project  ·  ${clipCount} clip${clipCount === 1 ? "" : "s"}`,
    isError: false,
    newState: { project: mutation.state },
  };
}

// ── /timeline ─────────────────────────────────────────────────────────────────

function dispatchTimeline(state: ReplState, viewport?: ViewportState): DispatchResult {
  if (!state.project || state.project.timeline.headId === null) {
    return { output: "No clips on timeline. Use /open to add a file.", isError: true };
  }
  const rendered = renderTimeline(state.project, process.stdout.columns, viewport)
    + "\n" + renderClipList(state.project);
  return { output: rendered, isError: false, activatesTimeline: true };
}

// ── /trim ─────────────────────────────────────────────────────────────────────

async function dispatchTrim(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.project) return { output: "No project open. Use /open first.", isError: true };
  if (args.length < 3) return { output: "Usage: /trim <index> <start> <end>", isError: true };

  const clip = resolveClip(state.project.timeline, args[0]!);
  if (!clip) {
    const count = clipsInOrder(state.project.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }

  let inPoint: number, outPoint: number;
  try {
    inPoint  = parseTime(args[1]!);
    outPoint = parseTime(args[2]!);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  const mutation = trimClip(state.project, clip.id, { inPoint, outPoint });
  if (!mutation.ok) return { output: `Error: ${mutation.error}`, isError: true };

  const saved = await saveProjectToStandardPath(mutation.state);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  const trimmed = mutation.state.timeline.clips[clip.id]!;
  return {
    output: `Trimmed ${trimmed.label}  ${args[1]} → ${args[2]}  (${formatSeconds(trimmed.outPoint - trimmed.inPoint)})`,
    isError: false,
    newState: { project: mutation.state },
  };
}

// ── /move ─────────────────────────────────────────────────────────────────────

async function dispatchMove(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.project) return { output: "No project open. Use /open first.", isError: true };
  if (args.length < 2) return { output: "Usage: /move <from> <to>", isError: true };

  const clip = resolveClip(state.project.timeline, args[0]!);
  if (!clip) {
    const count = clipsInOrder(state.project.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }

  const toIdx = parseInt(args[1]!, 10) - 1;
  const count = clipsInOrder(state.project.timeline).length;
  if (isNaN(toIdx) || toIdx < 0 || toIdx >= count) {
    return { output: `To-index ${args[1]} out of range (1–${count})`, isError: true };
  }

  const mutation = reorderClip(state.project, clip.id, toIdx);
  if (!mutation.ok) return { output: `Error: ${mutation.error}`, isError: true };

  const saved = await saveProjectToStandardPath(mutation.state);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  return {
    output: `Moved ${clip.label} → position [${args[1]}]`,
    isError: false,
    newState: { project: mutation.state },
  };
}

// ── /export ───────────────────────────────────────────────────────────────────

async function dispatchExport(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.project) return { output: "No project open. Use /open first.", isError: true };
  if (!args[0]) return { output: "Usage: /export <output-file>", isError: true };

  const clips = clipsInOrder(state.project.timeline);
  if (clips.length === 0) return { output: "Timeline is empty. Use /open to add clips.", isError: true };

  const outputPath = path.resolve(args[0]);
  const sourceMap = new Map(state.project.sources.map((s) => [s.id, s]));

  // Single clip — direct trim
  if (clips.length === 1) {
    const clip = clips[0]!;
    const source = sourceMap.get(clip.sourceId);
    if (!source) return { output: "Source file missing for clip [1].", isError: true };

    const result = await execute({ type: "trim", input: source.filePath, start: clip.inPoint, end: clip.outPoint, output: outputPath });
    if (!result.ok) return { output: `Export failed: ${result.error}`, isError: true };

    return {
      output: `Exported: ${outputPath}\nSize: ${formatFileSize(result.outputSize)}\nDuration: ${formatDuration(clip.outPoint - clip.inPoint)}`,
      isError: false,
    };
  }

  // Multi-clip — trim each to temp, then concat
  const tmpDir = path.join(os.tmpdir(), `cutcli-export-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const segPaths: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const source = sourceMap.get(clip.sourceId);
    if (!source) {
      await cleanupSegments(segPaths);
      return { output: `Source file missing for clip [${i + 1}].`, isError: true };
    }
    const seg = path.join(tmpDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    const r = await execute({ type: "trim", input: source.filePath, start: clip.inPoint, end: clip.outPoint, output: seg });
    if (!r.ok) {
      await cleanupSegments(segPaths);
      return { output: `Trim failed for clip [${i + 1}]: ${r.error}`, isError: true };
    }
    segPaths.push(seg);
  }

  const concat = await execute({ type: "concat", segments: segPaths, output: outputPath });
  await cleanupSegments(segPaths);
  if (!concat.ok) return { output: `Concat failed: ${concat.error}`, isError: true };

  const total = clips.reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
  return {
    output: `Exported: ${outputPath}\nSize: ${formatFileSize(concat.outputSize)}\nDuration: ${formatDuration(total)}  (${clips.length} clips)`,
    isError: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanupSegments(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
}

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

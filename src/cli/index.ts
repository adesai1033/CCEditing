#!/usr/bin/env node
import "../utils/env.js"; // must stay first — populates process.env from .env
import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import os from "node:os";
import { mkdir, rename, unlink } from "node:fs/promises";
import { probeFile } from "../media/probe.js";
import { renderMediaInfo } from "../display/media-info.js";
import { renderTimeline } from "../display/timeline.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { execute } from "../engine/engine.js";
import { parseTime } from "../utils/time.js";
import { clipsInOrder, resolveClip, getClipDisplayRefs } from "../project/types.js";
import { applyPlan, undoSession, redoSession, type ProjectSession } from "../project/session.js";
import { formatFileSize } from "../display/media-info.js";
import {
  projectFilePath,
  loadOrCreateProject,
  saveProjectToStandardPath,
} from "./project-context.js";

const program = new Command();

program
  .name("cutcli")
  .description("AI-powered CLI video editor")
  .version("0.2.0");

// ── open ──────────────────────────────────────────────────────────────────────

program
  .command("open <file>")
  .description("Import a video file into the current project")
  .action(async (file: string) => {
    const absFile = path.resolve(file);

    const probe = await probeFile(absFile);
    if (!probe.ok) {
      console.error(chalk.red(`Error: ${probe.error}`));
      process.exit(1);
    }

    console.log();
    console.log(renderMediaInfo(probe.data));
    console.log();

    const ctx = await loadOrCreateProject();
    if (!ctx.ok) {
      console.error(chalk.red(`Error: ${ctx.error}`));
      process.exit(1);
    }

    const result = applyPlan(
      ctx.session,
      `add source ${probe.data.fileName}`,
      [{ type: "addSource", mediaInfo: probe.data }],
    );
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    await saveOrExit(result.session);

    const statusMsg = ctx.existed
      ? `Added to project  ·  ${chalk.dim(projectFilePath())}  (${result.session.state.sources.length} sources, ${clipsInOrder(result.session.state.timeline).length} clips)`
      : `Created project  ·  ${chalk.dim(projectFilePath())}`;
    console.log(chalk.green(statusMsg));
    console.log();
    console.log(renderTimeline(result.session.state, process.stdout.columns));
    console.log();
    console.log(renderClipList(result.session.state));
    console.log();
  });

// ── trim ──────────────────────────────────────────────────────────────────────

program
  .command("trim <index> <start> <end>")
  .description("Trim a clip in the project by 1-based index")
  .action(async (indexStr: string, startStr: string, endStr: string) => {
    const session = await requireProject();

    const clip = resolveClip(session.state.timeline, indexStr);
    if (!clip) {
      const count = clipsInOrder(session.state.timeline).length;
      console.error(chalk.red(`Error: Clip "${indexStr}" not found (project has ${count} clip${count === 1 ? "" : "s"}).`));
      process.exit(1);
    }

    let inPoint: number;
    let outPoint: number;
    try {
      inPoint  = parseTime(startStr);
      outPoint = parseTime(endStr);
    } catch (err: unknown) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }

    const ref = getClipDisplayRefs(session.state.timeline).get(clip.id) ?? indexStr;
    const result = applyPlan(
      session,
      `trim clip [${ref}]`,
      [{ type: "trim", clipId: clip.id, inPoint, outPoint }],
    );
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    await saveOrExit(result.session);

    const trimmedClip = result.session.state.timeline.clips[clip.id]!;
    const duration = trimmedClip.outPoint - trimmedClip.inPoint;
    console.log();
    console.log(chalk.green(`Trimmed clip ${trimmedClip.label}`));
    console.log(chalk.dim(`  ${startStr} → ${endStr}  (${formatSeconds(duration)})`));
    console.log();
    console.log(renderTimeline(result.session.state, process.stdout.columns));
    console.log();
    console.log(renderClipList(result.session.state));
    console.log();
  });

// ── move ──────────────────────────────────────────────────────────────────────

program
  .command("move <from> <to>")
  .description("Move a clip to a new position (1-based indices)")
  .action(async (fromStr: string, toStr: string) => {
    const session = await requireProject();

    const clip = resolveClip(session.state.timeline, fromStr);
    if (!clip) {
      const count = clipsInOrder(session.state.timeline).length;
      console.error(chalk.red(`Error: Clip "${fromStr}" not found (project has ${count} clip${count === 1 ? "" : "s"}).`));
      process.exit(1);
    }

    const toIdx = parseInt(toStr, 10) - 1;
    const count = clipsInOrder(session.state.timeline).length;
    if (isNaN(toIdx) || toIdx < 0 || toIdx >= count) {
      console.error(chalk.red(`Error: To-index ${toStr} out of range (project has ${count} clip${count === 1 ? "" : "s"}).`));
      process.exit(1);
    }

    const ref = getClipDisplayRefs(session.state.timeline).get(clip.id) ?? fromStr;
    const result = applyPlan(
      session,
      `move clip [${ref}] → position ${toStr}`,
      [{ type: "move", clipId: clip.id, newIndex: toIdx }],
    );
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    await saveOrExit(result.session);

    console.log();
    console.log(chalk.green(`Moved clip [${fromStr}] ${clip.label} → position [${toStr}]`));
    console.log();
    console.log(renderTimeline(result.session.state, process.stdout.columns));
    console.log();
    console.log(renderClipList(result.session.state));
    console.log();
  });

// ── split ─────────────────────────────────────────────────────────────────────

program
  .command("split <clip> <time>")
  .description("Split a clip at a source time into two consecutive clips")
  .action(async (clipRef: string, timeStr: string) => {
    const session = await requireProject();

    const clip = resolveClip(session.state.timeline, clipRef);
    if (!clip) {
      const count = clipsInOrder(session.state.timeline).length;
      console.error(chalk.red(`Error: Clip "${clipRef}" not found (project has ${count} clip${count === 1 ? "" : "s"}).`));
      process.exit(1);
    }

    let splitPoint: number;
    try {
      splitPoint = parseTime(timeStr);
    } catch (err: unknown) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }

    const ref = getClipDisplayRefs(session.state.timeline).get(clip.id) ?? clipRef;
    const result = applyPlan(
      session,
      `split clip [${ref}] at ${timeStr}`,
      [{ type: "split", clipId: clip.id, splitPoint }],
    );
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    await saveOrExit(result.session);

    const displayRefs = getClipDisplayRefs(result.session.state.timeline);
    const ordered = clipsInOrder(result.session.state.timeline);
    const newSecondClip = ordered[ordered.findIndex((c) => c.id === clip.id) + 1]!;
    const refA = displayRefs.get(clip.id) ?? "?";
    const refB = displayRefs.get(newSecondClip.id) ?? "?";
    console.log();
    console.log(chalk.green(`Split ${clip.label} at ${timeStr} → clips [${refA}] and [${refB}]`));
    console.log();
    console.log(renderTimeline(result.session.state, process.stdout.columns));
    console.log();
    console.log(renderClipList(result.session.state));
    console.log();
  });

// ── delete ────────────────────────────────────────────────────────────────────

program
  .command("delete <clip>")
  .description("Remove a clip from the timeline (source file is kept)")
  .action(async (clipRef: string) => {
    const session = await requireProject();

    const clip = resolveClip(session.state.timeline, clipRef);
    if (!clip) {
      const count = clipsInOrder(session.state.timeline).length;
      console.error(chalk.red(`Error: Clip "${clipRef}" not found (project has ${count} clip${count === 1 ? "" : "s"}).`));
      process.exit(1);
    }

    const ref = getClipDisplayRefs(session.state.timeline).get(clip.id) ?? clipRef;
    const result = applyPlan(
      session,
      `delete clip [${ref}]`,
      [{ type: "delete", clipId: clip.id }],
    );
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    await saveOrExit(result.session);

    const remaining = clipsInOrder(result.session.state.timeline).length;
    console.log();
    console.log(chalk.green(`Deleted clip ${clip.label}`));
    console.log(chalk.dim(`  ${remaining} clip${remaining === 1 ? "" : "s"} remaining`));
    console.log();
    if (remaining > 0) {
      console.log(renderTimeline(result.session.state, process.stdout.columns));
      console.log();
      console.log(renderClipList(result.session.state));
      console.log();
    }
  });

// ── undo ──────────────────────────────────────────────────────────────────────

program
  .command("undo")
  .description("Undo the most recent change")
  .action(async () => {
    const session = await requireProject();

    const result = undoSession(session);
    if (!result.ok) {
      console.error(chalk.yellow("Nothing to undo."));
      process.exit(0);
    }

    await saveOrExit(result.session);

    console.log();
    console.log(chalk.green(`Undid: ${result.label}`));
    console.log();
    const clips = clipsInOrder(result.session.state.timeline);
    if (clips.length > 0) {
      console.log(renderTimeline(result.session.state, process.stdout.columns));
      console.log();
      console.log(renderClipList(result.session.state));
      console.log();
    }
  });

// ── redo ──────────────────────────────────────────────────────────────────────

program
  .command("redo")
  .description("Redo the most recently undone change")
  .action(async () => {
    const session = await requireProject();

    const result = redoSession(session);
    if (!result.ok) {
      console.error(chalk.yellow("Nothing to redo."));
      process.exit(0);
    }

    await saveOrExit(result.session);

    console.log();
    console.log(chalk.green(`Redid: ${result.label}`));
    console.log();
    const clips = clipsInOrder(result.session.state.timeline);
    if (clips.length > 0) {
      console.log(renderTimeline(result.session.state, process.stdout.columns));
      console.log();
      console.log(renderClipList(result.session.state));
      console.log();
    }
  });

// ── export ────────────────────────────────────────────────────────────────────

program
  .command("export <output>")
  .description("Export the project timeline to a video file")
  .action(async (output: string) => {
    const session = await requireProject();

    const { state } = session;
    const clips = clipsInOrder(state.timeline);

    if (clips.length === 0) {
      console.error(chalk.red("Error: Timeline is empty. Add clips with `cutcli open <file>`."));
      process.exit(1);
    }

    const sourceMap = new Map(state.sources.map((s) => [s.id, s]));
    const absOutput = path.resolve(output);
    const tmpDirPath = path.join(os.tmpdir(), `cutcli-export-${Date.now()}`);
    await mkdir(tmpDirPath, { recursive: true });
    const tmpDir = tmpDirPath;

    console.log();
    console.log(`Exporting ${clips.length} clip${clips.length === 1 ? "" : "s"}...`);
    console.log();

    const segmentPaths: string[] = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!;
      const source = sourceMap.get(clip.sourceId);
      if (!source) {
        console.error(chalk.red(`Error: Source file missing for clip [${i + 1}]: ${clip.sourceId}`));
        await cleanupSegments(segmentPaths);
        process.exit(1);
      }

      const segPath = path.join(tmpDir, `segment-${String(i).padStart(3, "0")}.mp4`);
      process.stdout.write(`  [${i + 1}/${clips.length}] Trimming ${source.fileName} (${formatDuration(clip.inPoint)} → ${formatDuration(clip.outPoint)})...`);

      const result = await execute({
        type: "trim",
        input: source.filePath,
        start: clip.inPoint,
        end: clip.outPoint,
        output: segPath,
      });

      if (!result.ok) {
        process.stdout.write("  failed\n");
        console.error(chalk.red(`Error: ${result.error}`));
        await cleanupSegments(segmentPaths);
        process.exit(1);
      }

      segmentPaths.push(segPath);
      process.stdout.write(chalk.green("  done\n"));
    }

    let finalSize: number;

    if (segmentPaths.length === 1) {
      await rename(segmentPaths[0]!, absOutput);
      const { stat } = await import("node:fs/promises");
      finalSize = (await stat(absOutput)).size;
    } else {
      process.stdout.write("  Concatenating segments...");
      const concatResult = await execute({
        type: "concat",
        segments: segmentPaths,
        output: absOutput,
      });
      if (!concatResult.ok) {
        process.stdout.write("  failed\n");
        console.error(chalk.red(`Error: ${concatResult.error}`));
        await cleanupSegments(segmentPaths);
        process.exit(1);
      }
      finalSize = concatResult.outputSize;
      process.stdout.write(chalk.green("  done\n"));
      await cleanupSegments(segmentPaths);
    }

    const totalDuration = clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint), 0);
    console.log();
    console.log(chalk.green(`✓ Exported successfully`));
    console.log(chalk.dim(`  Output    ${absOutput} (${formatFileSize(finalSize)})`));
    console.log(chalk.dim(`  Duration  ${formatDuration(totalDuration)}${clips.length > 1 ? `  (${clips.length} clips)` : ""}`));
    console.log();
  });

// ── repl ──────────────────────────────────────────────────────────────────────

program
  .command("repl")
  .description("Launch the interactive REPL editor")
  .action(async () => {
    const { startRepl } = await import("../repl/index.js");
    startRepl();
  });

program.parse();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProject(): Promise<ProjectSession> {
  const ctx = await loadOrCreateProject();
  if (!ctx.ok) {
    console.error(chalk.red(`Error: ${ctx.error}`));
    process.exit(1);
  }
  if (!ctx.existed) {
    console.error(chalk.red("Error: No project found. Run `cutcli open <file>` first."));
    process.exit(1);
  }
  return ctx.session;
}

async function saveOrExit(session: ProjectSession): Promise<void> {
  const saved = await saveProjectToStandardPath(session);
  if (!saved.ok) {
    console.error(chalk.red(`Error saving project: ${saved.error}`));
    process.exit(1);
  }
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

async function cleanupSegments(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
}

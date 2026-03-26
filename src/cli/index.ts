#!/usr/bin/env node
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
import { addSource, trimClip } from "../project/mutations.js";
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

    // Probe the file
    const probe = await probeFile(absFile);
    if (!probe.ok) {
      console.error(chalk.red(`Error: ${probe.error}`));
      process.exit(1);
    }

    console.log();
    console.log(renderMediaInfo(probe.data));
    console.log();

    // Load or create project
    const ctx = await loadOrCreateProject();
    if (!ctx.ok) {
      console.error(chalk.red(`Error: ${ctx.error}`));
      process.exit(1);
    }

    // Add source
    const result = addSource(ctx.state, probe.data);
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    // Save
    const saved = await saveProjectToStandardPath(result.state);
    if (!saved.ok) {
      console.error(chalk.red(`Error saving project: ${saved.error}`));
      process.exit(1);
    }

    const statusMsg = ctx.existed
      ? `Added to project  ·  ${chalk.dim(projectFilePath())}  (${result.state.sources.length} sources, ${result.state.timeline.clips.length} clips)`
      : `Created project  ·  ${chalk.dim(projectFilePath())}`;
    console.log(chalk.green(statusMsg));
    console.log();
    console.log(renderTimeline(result.state, process.stdout.columns));
    console.log();
    console.log(renderClipList(result.state));
    console.log();
  });

// ── trim ──────────────────────────────────────────────────────────────────────

program
  .command("trim <index> <start> <end>")
  .description("Trim a clip in the project by 1-based index")
  .action(async (indexStr: string, startStr: string, endStr: string) => {
    const ctx = await loadOrCreateProject();
    if (!ctx.ok) {
      console.error(chalk.red(`Error: ${ctx.error}`));
      process.exit(1);
    }
    if (!ctx.existed) {
      console.error(chalk.red("Error: No project found. Run `cutcli open <file>` first."));
      process.exit(1);
    }

    const index = parseInt(indexStr, 10) - 1; // convert to 0-based
    const clips = ctx.state.timeline.clips;
    if (isNaN(index) || index < 0 || index >= clips.length) {
      console.error(chalk.red(`Error: Clip index ${indexStr} out of range (project has ${clips.length} clip${clips.length === 1 ? "" : "s"}).`));
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

    const clip = clips[index]!;
    const result = trimClip(ctx.state, clip.id, { inPoint, outPoint });
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    const saved = await saveProjectToStandardPath(result.state);
    if (!saved.ok) {
      console.error(chalk.red(`Error saving project: ${saved.error}`));
      process.exit(1);
    }

    const trimmedClip = result.state.timeline.clips[index]!;
    const duration = trimmedClip.outPoint - trimmedClip.inPoint;
    console.log();
    console.log(chalk.green(`Trimmed clip [${index + 1}] ${trimmedClip.label}`));
    console.log(chalk.dim(`  ${startStr} → ${endStr}  (${formatSeconds(duration)})`));
    console.log();
    console.log(renderTimeline(result.state, process.stdout.columns));
    console.log();
    console.log(renderClipList(result.state));
    console.log();
  });

// ── export ────────────────────────────────────────────────────────────────────

program
  .command("export <output>")
  .description("Export the project timeline to a video file")
  .action(async (output: string) => {
    const ctx = await loadOrCreateProject();
    if (!ctx.ok) {
      console.error(chalk.red(`Error: ${ctx.error}`));
      process.exit(1);
    }
    if (!ctx.existed) {
      console.error(chalk.red("Error: No project found. Run `cutcli open <file>` first."));
      process.exit(1);
    }

    const { state } = ctx;
    const clips = state.timeline.clips;

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

program.parse();

// ── Helpers ───────────────────────────────────────────────────────────────────

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

#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { probeFile } from "../media/probe.js";
import { renderMediaInfo, renderTrimSuccess } from "../display/media-info.js";
import { execute } from "../engine/engine.js";
import { parseTime } from "../utils/time.js";

const program = new Command();

program
  .name("cutcli")
  .description("AI-powered CLI video editor")
  .version("0.2.0");

program
  .command("open <file>")
  .description("Open a video file and display its metadata")
  .action(async (file: string) => {
    const result = await probeFile(file);
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }
    console.log();
    console.log(renderMediaInfo(result.data));
    console.log();
  });

program
  .command("trim <input>")
  .description("Trim a video to a time range")
  .requiredOption("-s, --start <time>", "Start time (e.g. 0:05, 30, 1:30:00)")
  .requiredOption("-e, --end <time>", "End time (e.g. 0:30, 90, 2:00:00)")
  .option("-o, --output <file>", "Output file path")
  .option("--verbose", "Show raw FFmpeg output on failure")
  .action(async (input: string, opts: { start: string; end: string; output?: string; verbose?: boolean }) => {
    // Parse time strings
    let start: number;
    let end: number;
    try {
      start = parseTime(opts.start);
      end = parseTime(opts.end);
    } catch (err: unknown) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }

    // Default output path: <name>_trimmed.<ext>
    const output = opts.output ?? defaultOutputPath(input);

    // Probe input to get duration for display
    const probe = await probeFile(input);
    if (!probe.ok) {
      console.error(chalk.red(`Error: ${probe.error}`));
      process.exit(1);
    }

    console.log();
    const result = await execute({ type: "trim", input, start, end, output });

    if (!result.ok) {
      console.error(chalk.red(`  ✗ Trim failed: ${result.error}`));
      console.log();
      process.exit(1);
    }

    console.log(renderTrimSuccess({
      inputName: probe.data.fileName,
      inputDuration: probe.data.duration,
      start,
      end,
      outputPath: result.outputPath,
      outputSize: result.outputSize,
    }));
    console.log();
  });

program.parse();

function defaultOutputPath(inputPath: string): string {
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  const dir = path.dirname(inputPath);
  return path.join(dir, `${base}_trimmed${ext}`);
}

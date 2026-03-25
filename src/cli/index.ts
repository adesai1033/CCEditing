#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { probeFile } from "../media/probe.js";
import { renderMediaInfo } from "../display/media-info.js";

const program = new Command();

program
  .name("cutcli")
  .description("AI-powered CLI video editor")
  .version("0.1.0");

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

program.parse();

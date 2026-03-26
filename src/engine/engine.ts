import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, access, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { EditOperation, TrimOperation, ConcatOperation } from "./types.js";
import { validateTrim } from "./validator.js";
import { buildArgs, buildConcatFileContent } from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

export type ExecutionResult =
  | { ok: true; outputPath: string; outputSize: number; durationUsed: number }
  | { ok: false; error: string; code: "VALIDATION" | "NO_FFMPEG" | "FFMPEG_FAILED" };

export async function execute(op: EditOperation): Promise<ExecutionResult> {
  // Validate
  const validation = await validateOperation(op);
  if (!validation.ok) {
    return { ok: false, error: validation.error, code: "VALIDATION" };
  }

  // For concat, write the list file and pass its path into buildArgs
  let concatListPath: string | undefined;
  if (op.type === "concat") {
    concatListPath = path.join(os.tmpdir(), `cutcli-concat-${Date.now()}.txt`);
    await writeFile(concatListPath, buildConcatFileContent(op.segments), "utf-8");
  }

  // Build args and run FFmpeg
  const args = buildArgs(op, concatListPath);
  try {
    await execFileAsync("ffmpeg", args);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === "ENOENT") {
      return {
        ok: false,
        error: "ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html",
        code: "NO_FFMPEG",
      };
    }
    const stderr = (error.stderr ?? String(error)).trim();
    const friendly = parseFfmpegError(stderr);
    if (concatListPath) await unlink(concatListPath).catch(() => {});
    return { ok: false, error: friendly, code: "FFMPEG_FAILED" };
  }

  if (concatListPath) await unlink(concatListPath).catch(() => {});

  // Read output file size
  const outputStat = await stat(op.output);
  return {
    ok: true,
    outputPath: op.output,
    outputSize: outputStat.size,
    durationUsed: validation.duration,
  };
}

async function validateOperation(op: EditOperation): Promise<{ ok: true; duration: number } | { ok: false; error: string }> {
  switch (op.type) {
    case "trim":
      return validateTrim(op as TrimOperation);
    case "concat": {
      const concatOp = op as ConcatOperation;
      for (const seg of concatOp.segments) {
        try {
          await access(seg, constants.F_OK);
        } catch {
          return { ok: false, error: `Segment file not found: ${seg}` };
        }
      }
      return { ok: true, duration: 0 };
    }
  }
}

function parseFfmpegError(stderr: string): string {
  // Surface the last meaningful error line from FFmpeg's stderr
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l: string) => l.startsWith("Error") || l.includes("Invalid") || l.includes("No such"));
  return errorLine ?? lines[lines.length - 1] ?? "FFmpeg failed with an unknown error";
}

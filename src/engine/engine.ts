import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, access, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { EditOperation, TrimOperation, ConcatOperation, JoinOperation, OverlayOperation } from "./types.js";
import { validateTrim } from "./validator.js";
import { buildArgs, buildConcatFileContent, type FrameSize, type JoinTarget } from "./ffmpeg.js";
import { probeFile } from "../media/probe.js";

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
  const args = buildArgs(op, concatListPath, validation.base);
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

async function validateOperation(op: EditOperation): Promise<{ ok: true; duration: number; base?: FrameSize | JoinTarget } | { ok: false; error: string }> {
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
    case "join": {
      const joinOp = op as JoinOperation;
      if (joinOp.segments.length === 0) return { ok: false, error: "No segments to join" };
      for (const seg of joinOp.segments) {
        try {
          await access(seg.path, constants.F_OK);
        } catch {
          return { ok: false, error: `Segment file not found: ${seg.path}` };
        }
      }
      const withAudio = joinOp.segments.filter((s) => s.hasAudio).length;
      if (withAudio > 0 && withAudio < joinOp.segments.length) {
        return { ok: false, error: "Transitions need every clip to have audio, or none of them to" };
      }
      // The first segment sets the frame size and rate everything else is
      // conformed to (xfade refuses mismatched inputs).
      const probe = await probeFile(joinOp.segments[0]!.path);
      if (!probe.ok) return { ok: false, error: probe.error };
      return {
        ok: true,
        duration: joinOp.segments.reduce((s, seg) => s + seg.duration, 0),
        base: { width: probe.data.width, height: probe.data.height, fps: probe.data.fps || 30 },
      };
    }
    case "overlay": {
      const ovOp = op as OverlayOperation;
      if (ovOp.layers.length === 0) return { ok: false, error: "No overlay layers to composite" };
      // The base's real dimensions drive pixel placement (export is full-res,
      // preview is downscaled — the fractional geometry is the same).
      const probe = await probeFile(ovOp.base);
      if (!probe.ok) return { ok: false, error: probe.error };
      for (const layer of ovOp.layers) {
        try {
          await access(layer.input, constants.F_OK);
        } catch {
          return { ok: false, error: `Overlay source not found: ${layer.input}` };
        }
        if (layer.outPoint <= layer.inPoint) return { ok: false, error: `Overlay range is empty (${layer.inPoint}s–${layer.outPoint}s)` };
      }
      return {
        ok: true,
        duration: probe.data.duration,
        base: { width: probe.data.width, height: probe.data.height },
      };
    }
  }
}

function parseFfmpegError(stderr: string): string {
  // Surface the last meaningful error line from FFmpeg's stderr
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l: string) => l.startsWith("Error") || l.includes("Invalid") || l.includes("No such"));
  return errorLine ?? lines[lines.length - 1] ?? "FFmpeg failed with an unknown error";
}

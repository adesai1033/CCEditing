import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { MediaInfo, FfprobeOutput, FfprobeStream } from "./types.js";

const execFileAsync = promisify(execFile);

export type ProbeResult =
  | { ok: true; data: MediaInfo }
  | { ok: false; error: string; code: "NOT_FOUND" | "NO_FFPROBE" | "PARSE_ERROR" | "PROBE_FAILED" };

export async function probeFile(filePath: string): Promise<ProbeResult> {
  // Check file exists
  try {
    await stat(filePath);
  } catch {
    return { ok: false, error: `File not found: ${filePath}`, code: "NOT_FOUND" };
  }

  // Run ffprobe
  let stdout: string;
  try {
    const result = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ]);
    stdout = result.stdout;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === "ENOENT") {
      return {
        ok: false,
        error: "ffprobe not found. Install FFmpeg: https://ffmpeg.org/download.html",
        code: "NO_FFPROBE",
      };
    }
    const stderr = error.stderr ?? String(error);
    return { ok: false, error: `ffprobe failed: ${stderr}`, code: "PROBE_FAILED" };
  }

  // Parse JSON
  let raw: FfprobeOutput;
  try {
    raw = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return { ok: false, error: "Failed to parse ffprobe output", code: "PARSE_ERROR" };
  }

  const info = normalizeProbeOutput(filePath, raw);
  if (!info) {
    return { ok: false, error: "No video stream found in file", code: "PARSE_ERROR" };
  }

  return { ok: true, data: info };
}

function parseFps(rateStr: string): number {
  const [num, den] = rateStr.split("/").map(Number);
  if (!den || den === 0) return num ?? 0;
  return Math.round((num / den) * 100) / 100;
}

function normalizeProbeOutput(filePath: string, raw: FfprobeOutput): MediaInfo | null {
  const videoStream = raw.streams.find((s: FfprobeStream) => s.codec_type === "video");
  if (!videoStream) return null;

  const audioStream = raw.streams.find((s: FfprobeStream) => s.codec_type === "audio") ?? null;
  const fmt = raw.format;

  const fpsStr = videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? "0/1";
  const fps = parseFps(fpsStr);

  const audioBitrateRaw = audioStream?.bit_rate ? parseInt(audioStream.bit_rate, 10) : null;

  return {
    filePath,
    fileName: path.basename(filePath),
    duration: parseFloat(fmt.duration),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps,
    videoCodec: videoStream.codec_name,
    audioCodec: audioStream?.codec_name ?? null,
    audioChannels: audioStream?.channels ?? null,
    audioBitrate: audioBitrateRaw !== null ? Math.round(audioBitrateRaw / 1000) : null,
    fileSize: parseInt(fmt.size, 10),
    bitrate: Math.round(parseInt(fmt.bit_rate, 10) / 1000),
    containerFormat: fmt.format_name,
  };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
const execFileAsync = promisify(execFile);
export async function probeFile(filePath) {
    // Check file exists
    try {
        await stat(filePath);
    }
    catch {
        return { ok: false, error: `File not found: ${filePath}`, code: "NOT_FOUND" };
    }
    // Run ffprobe
    let stdout;
    try {
        const result = await execFileAsync("ffprobe", [
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            filePath,
        ]);
        stdout = result.stdout;
    }
    catch (err) {
        const error = err;
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
    let raw;
    try {
        raw = JSON.parse(stdout);
    }
    catch {
        return { ok: false, error: "Failed to parse ffprobe output", code: "PARSE_ERROR" };
    }
    const info = normalizeProbeOutput(filePath, raw);
    if (!info) {
        return { ok: false, error: "No video stream found in file", code: "PARSE_ERROR" };
    }
    return { ok: true, data: info };
}
function parseFps(rateStr) {
    const [num, den] = rateStr.split("/").map(Number);
    if (!den || den === 0)
        return num ?? 0;
    return Math.round((num / den) * 100) / 100;
}
function normalizeProbeOutput(filePath, raw) {
    const videoStream = raw.streams.find((s) => s.codec_type === "video");
    if (!videoStream)
        return null;
    const audioStream = raw.streams.find((s) => s.codec_type === "audio") ?? null;
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
//# sourceMappingURL=probe.js.map
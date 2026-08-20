import type { MediaInfo } from "../media/types.js";
import { paint, glyphs, stripAnsi } from "../ui/theme.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  const totalSecs = Math.floor(seconds);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

export function formatResolution(width: number, height: number): string {
  const label = resolutionLabel(width, height);
  const base = `${width} × ${height}`;
  return label ? `${base} (${label})` : base;
}

export function resolutionLabel(width: number, height: number): string {
  const h = height;
  if (h >= 4320) return "8K";
  if (h >= 2160) return "4K";
  if (h >= 1080) return "FHD";
  if (h >= 720) return "HD";
  return "SD";
}

export function formatVideoCodec(codec: string): string {
  const map: Record<string, string> = {
    h264: "H.264 (AVC)",
    hevc: "H.265 (HEVC)",
    vp8: "VP8",
    vp9: "VP9",
    av1: "AV1",
    mpeg4: "MPEG-4",
    mpeg2video: "MPEG-2",
    prores: "Apple ProRes",
    dnxhd: "DNxHD",
  };
  return map[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function formatAudioCodec(codec: string): string {
  const map: Record<string, string> = {
    aac: "AAC",
    mp3: "MP3",
    ac3: "AC3",
    eac3: "E-AC3",
    flac: "FLAC",
    opus: "Opus",
    vorbis: "Vorbis",
    pcm_s16le: "PCM 16-bit",
    pcm_s24le: "PCM 24-bit",
  };
  return map[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function formatChannels(channels: number): string {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels}ch`;
}

export function formatAudio(info: MediaInfo): string {
  if (!info.audioCodec) return "No audio";
  const parts: string[] = [formatAudioCodec(info.audioCodec)];
  if (info.audioChannels !== null) parts.push(formatChannels(info.audioChannels));
  if (info.audioBitrate !== null) parts.push(`${info.audioBitrate} kbps`);
  return parts.join(" ");
}

export function formatContainer(formatName: string): string {
  // ffprobe may return comma-separated list like "mov,mp4,m4a,3gp,3g2,mj2"
  const primary = formatName.split(",")[0]?.trim().toUpperCase() ?? formatName.toUpperCase();
  const aliases: Record<string, string> = {
    MOV: "MOV / MP4",
    MATROSKA: "MKV",
    WEBM: "WebM",
    AVI: "AVI",
    FLV: "FLV",
  };
  return aliases[primary] ?? primary;
}

export function formatFps(fps: number): string {
  // Show as integer if it's a whole number, otherwise one decimal
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

// ── Trim result display ───────────────────────────────────────────────────────

export interface TrimResultDisplay {
  inputName: string;
  inputDuration: number;
  start: number;
  end: number;
  outputPath: string;
  outputSize: number;
}

export function renderTrimSuccess(r: TrimResultDisplay): string {
  const trimDuration = r.end - r.start;
  const range = `${formatTime(r.start)} → ${formatTime(r.end)} (${Math.round(trimDuration)}s)`;

  const rows: [string, string][] = [
    ["Input",  `${r.inputName} (${formatDuration(r.inputDuration)})`],
    ["Range",  range],
    ["Output", `${r.outputPath} (${formatFileSize(r.outputSize)})`],
  ];

  const labelWidth = Math.max(...rows.map(([l]) => l.length));

  const contentRows = rows.map(([label, value]) =>
    `${paint.muted(label.padEnd(labelWidth))}  ${paint.emphasis(value)}`
  );

  const innerWidth = Math.max(...contentRows.map((r) => stripAnsi(r).length)) + 2;
  const padRight = (stripped: string, raw: string) =>
    `  │ ${raw}${" ".repeat(Math.max(0, innerWidth - stripped.length))} │`;

  const title = `${glyphs.done} Trimmed successfully`;
  const lines = [
    `  ╭${"─".repeat(innerWidth + 2)}╮`,
    `  │ ${paint.successEmphasis(title)}${" ".repeat(Math.max(0, innerWidth - title.length))} │`,
    `  ├${"─".repeat(innerWidth + 2)}┤`,
    ...contentRows.map((r) => padRight(stripAnsi(r), r)),
    `  ╰${"─".repeat(innerWidth + 2)}╯`,
  ];

  return lines.join("\n");
}

function formatTime(seconds: number): string {
  const totalSecs = Math.floor(seconds);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Box renderer ──────────────────────────────────────────────────────────────

export function renderMediaInfo(info: MediaInfo): string {
  const rows: [string, string][] = [
    ["Duration", formatDuration(info.duration)],
    ["Resolution", formatResolution(info.width, info.height)],
    ["FPS", formatFps(info.fps)],
    ["Video", formatVideoCodec(info.videoCodec)],
    ["Audio", formatAudio(info)],
    ["Size", formatFileSize(info.fileSize)],
    ["Bitrate", formatBitrate(info.bitrate)],
    ["Container", formatContainer(info.containerFormat)],
  ];

  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const contentRows = rows.map(([label, value]) => {
    const paddedLabel = label.padEnd(labelWidth);
    return `${paint.muted(paddedLabel)}  ${paint.emphasis(value)}`;
  });

  // Measure box width: max of filename length and longest content row (stripped of ANSI)
  const innerWidth = Math.max(
    info.fileName.length,
    ...contentRows.map((r) => stripAnsi(r).length)
  ) + 2; // 2 = left/right padding

  const top    = `  ╭${"─".repeat(innerWidth + 2)}╮`;
  const bottom = `  ╰${"─".repeat(innerWidth + 2)}╯`;
  const sep    = `  ├${"─".repeat(innerWidth + 2)}┤`;

  const padRight = (stripped: string, raw: string): string => {
    const pad = innerWidth - stripped.length;
    return `  │ ${raw}${" ".repeat(Math.max(0, pad))} │`;
  };

  const titleLine = padRight(info.fileName, paint.heading(info.fileName));
  const contentLines = contentRows.map((r) => padRight(stripAnsi(r), r));

  return [top, titleLine, sep, ...contentLines, bottom].join("\n");
}

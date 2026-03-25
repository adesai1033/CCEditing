import chalk from "chalk";
import type { ProjectState, Clip } from "../project/types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLIP_COLORS = [
  chalk.cyan,
  chalk.yellow,
  chalk.magenta,
  chalk.green,
] as const;

const TIME_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

const LABEL_WIDTH = 6; // assumed chars per time marker label for spacing

// ── Helpers ───────────────────────────────────────────────────────────────────

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

function formatMarker(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m}m` : `${m}m${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function formatTotal(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clipDuration(clip: Clip): number {
  return clip.outPoint - clip.inPoint;
}

function truncateLabel(label: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "─";
  if (width === 2) return "─…";
  if (label.length <= width - 2) return label; // fits with padding
  if (width <= 3) return "…";
  return label.slice(0, width - 3) + "…";
}

/**
 * Assign character widths to clips proportionally.
 * Every clip gets at least 1 character. Extra space distributed to largest clips.
 */
function assignWidths(clips: Clip[], barWidth: number): number[] {
  const total = clips.reduce((sum, c) => sum + clipDuration(c), 0);
  if (total === 0 || clips.length === 0) return clips.map(() => 1);

  // Give each clip its proportional share, floored to at least 1
  const raw = clips.map((c) => Math.max(1, Math.floor((clipDuration(c) / total) * barWidth)));
  let used = raw.reduce((a, b) => a + b, 0);

  // Distribute any remaining chars to the clips with the most leftover fractional parts
  const fractions = clips.map((c, i) => ({
    i,
    frac: (clipDuration(c) / total) * barWidth - raw[i]!,
  }));
  fractions.sort((a, b) => b.frac - a.frac);

  let idx = 0;
  while (used < barWidth && idx < fractions.length) {
    raw[fractions[idx]!.i]!++;
    used++;
    idx++;
  }

  // If we overshoot (rounding edge case), trim from the largest
  while (used > barWidth) {
    const maxIdx = raw.indexOf(Math.max(...raw));
    if (raw[maxIdx]! > 1) { raw[maxIdx]!--; used--; }
    else break;
  }

  return raw;
}

/**
 * Choose a sensible time marker interval given total duration and available width.
 */
function chooseInterval(totalSeconds: number, barWidth: number): number {
  const maxMarkers = Math.floor(barWidth / LABEL_WIDTH);
  for (const interval of TIME_INTERVALS) {
    const count = Math.floor(totalSeconds / interval) + 1;
    if (count <= maxMarkers) return interval;
  }
  return TIME_INTERVALS[TIME_INTERVALS.length - 1]!;
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export function renderTimeline(state: ProjectState, terminalWidth?: number): string {
  const tWidth = Math.max(20, terminalWidth ?? process.stdout.columns ?? 80);

  // Outer box: "  │ " + content + " │" = 6 chars of overhead (2 indent + 1 border + 1 space + 1 space + 1 border)
  const innerWidth = tWidth - 6;
  const barWidth   = Math.max(4, innerWidth - 2); // 2 for inner padding each side

  const box = {
    top:    `  ┌${"─".repeat(innerWidth + 2)}┐`,
    bottom: `  └${"─".repeat(innerWidth + 2)}┘`,
    row: (content: string) => {
      const stripped = stripAnsi(content);
      const pad = Math.max(0, innerWidth - stripped.length);
      return `  │ ${content}${" ".repeat(pad)} │`;
    },
  };

  const clips = state.timeline.clips;

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (clips.length === 0) {
    return [
      box.top,
      box.row(chalk.dim("No clips on timeline")),
      box.bottom,
    ].join("\n");
  }

  const totalDuration = clips.reduce((sum, c) => sum + clipDuration(c), 0);

  // ── Empty state (zero-duration clips) ────────────────────────────────────────
  if (totalDuration === 0) {
    return [
      box.top,
      box.row(chalk.dim("No clips on timeline")),
      box.bottom,
    ].join("\n");
  }

  const widths = assignWidths(clips, barWidth);

  // ── Time ruler ───────────────────────────────────────────────────────────────
  const interval = chooseInterval(totalDuration, barWidth);

  // Build ruler as a fixed-width char array
  const rulerChars  = Array<string>(barWidth).fill(" ");
  const tickChars   = Array<string>(barWidth).fill(" ");

  // Position 0 always gets a marker
  const markerSeconds: number[] = [];
  for (let t = 0; t <= totalDuration; t += interval) {
    markerSeconds.push(t);
  }

  for (const t of markerSeconds) {
    const pos = Math.round((t / totalDuration) * (barWidth - 1));
    const label = formatMarker(t);
    // Place label starting at pos, clamped to bar
    const start = Math.min(pos, barWidth - label.length);
    for (let i = 0; i < label.length; i++) {
      if (start + i < barWidth) rulerChars[start + i] = label[i]!;
    }
    if (pos < barWidth) tickChars[pos] = "┬";
  }

  const rulerLine = chalk.dim(rulerChars.join(""));
  const tickLine  = chalk.dim(tickChars.join(""));

  // ── Clip bar ─────────────────────────────────────────────────────────────────
  let clipBar = "";
  clips.forEach((clip, idx) => {
    const w = widths[idx]!;
    const color = CLIP_COLORS[idx % CLIP_COLORS.length]!;
    const border = color("│");

    if (w === 1) {
      clipBar += border;
      return;
    }

    const interior = w - 1; // left border consumed, right border is next clip's left
    const label = truncateLabel(clip.label, interior - 1); // -1 for leading space
    const fill = "─".repeat(Math.max(0, interior - 1 - label.length));
    clipBar += border + color(` ${label}${fill}`);
  });
  // Close final clip
  const lastColor = CLIP_COLORS[(clips.length - 1) % CLIP_COLORS.length]!;
  clipBar += lastColor("│");

  // ── Bottom bar border ─────────────────────────────────────────────────────────
  const bottomBar = chalk.dim("└" + "─".repeat(barWidth - 1));

  // ── Summary line ──────────────────────────────────────────────────────────────
  const summary = chalk.dim(
    `Total: ${formatTotal(totalDuration)}  ·  ${clips.length} clip${clips.length === 1 ? "" : "s"}`
  );

  return [
    box.top,
    box.row(rulerLine),
    box.row(tickLine),
    box.row(clipBar),
    box.row(bottomBar),
    box.row(summary),
    box.bottom,
  ].join("\n");
}

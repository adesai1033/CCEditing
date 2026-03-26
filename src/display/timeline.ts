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

// ── Interfaces ────────────────────────────────────────────────────────────────

interface HasDuration {
  duration: number;
}

/**
 * A visual group represents 1+ consecutive clips merged together for display.
 * When clips.length <= barWidth, each clip is its own group (identical to
 * pre-grouping behavior). When clips.length > barWidth, consecutive clips are
 * merged so the bar never exceeds barWidth segments.
 */
interface VisualGroup {
  clips: Clip[];
  totalDuration: number;
  duration: number;      // === totalDuration; satisfies HasDuration
  label: string;         // clip.label if 1 clip, else `${n} clips`
  colorIndex: number;    // original timeline index of the first clip in group
}

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
 * Merge consecutive clips into at most maxGroups visual groups, proportional
 * to duration. When clips.length <= maxGroups, each clip is its own group.
 */
function groupClips(clips: Clip[], maxGroups: number): VisualGroup[] {
  if (maxGroups <= 0) {
    // Degenerate case — return a single group of everything
    const total = clips.reduce((sum, c) => sum + clipDuration(c), 0);
    return [{ clips, totalDuration: total, duration: total, label: `${clips.length} clips`, colorIndex: 0 }];
  }

  const totalDuration = clips.reduce((sum, c) => sum + clipDuration(c), 0);
  const targetDuration = totalDuration / maxGroups;

  const makeGroup = (clipsSlice: Clip[], colorIndex: number): VisualGroup => {
    const dur = clipsSlice.reduce((sum, c) => sum + clipDuration(c), 0);
    return {
      clips: clipsSlice,
      totalDuration: dur,
      duration: dur,
      label: clipsSlice.length === 1 ? clipsSlice[0]!.label : `${clipsSlice.length} clips`,
      colorIndex,
    };
  };

  const groups: VisualGroup[] = [];
  let currentClips: Clip[] = [];
  let currentDuration = 0;
  let groupColorIndex = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    currentClips.push(clip);
    currentDuration += clipDuration(clip);

    // Seal when we've hit the target — but always leave room for a final group
    if (currentDuration >= targetDuration && groups.length < maxGroups - 1) {
      groups.push(makeGroup(currentClips, groupColorIndex));
      currentClips = [];
      currentDuration = 0;
      groupColorIndex = i + 1;
    }
  }

  // Flush remaining clips into the final group
  if (currentClips.length > 0) {
    groups.push(makeGroup(currentClips, groupColorIndex));
  }

  return groups;
}

/**
 * Assign character widths to items proportionally.
 * Every item gets at least 1 character. Extra space distributed by largest
 * fractional remainder.
 */
function assignWidths(items: HasDuration[], barWidth: number): number[] {
  const total = items.reduce((sum, c) => sum + c.duration, 0);
  if (total === 0 || items.length === 0) return items.map(() => 1);

  // Give each item its proportional share, floored to at least 1
  const raw = items.map((c) => Math.max(1, Math.floor((c.duration / total) * barWidth)));
  let used = raw.reduce((a, b) => a + b, 0);

  // Distribute remaining chars to items with the largest fractional remainders
  const fractions = items.map((c, i) => ({
    i,
    frac: (c.duration / total) * barWidth - raw[i]!,
  }));
  fractions.sort((a, b) => b.frac - a.frac);

  let idx = 0;
  while (used < barWidth && idx < fractions.length) {
    raw[fractions[idx]!.i]!++;
    used++;
    idx++;
  }

  // If we overshoot, trim from largest items (never below 1)
  let trimIdx = 0;
  const bySize = raw.map((w, i) => ({ i, w })).sort((a, b) => b.w - a.w);
  while (used > barWidth) {
    const candidate = bySize[trimIdx % bySize.length]!;
    if (candidate.w > 1) { raw[candidate.i]!--; candidate.w--; used--; }
    trimIdx++;
    if (trimIdx > barWidth * 2) break; // safety valve
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

  // Outer box: "  │ " + content + " │" = 6 chars of overhead
  const innerWidth = tWidth - 6;
  const barWidth   = Math.max(4, innerWidth - 2);

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
    return [box.top, box.row(chalk.dim("No clips on timeline")), box.bottom].join("\n");
  }

  const totalDuration = clips.reduce((sum, c) => sum + clipDuration(c), 0);

  if (totalDuration === 0) {
    return [box.top, box.row(chalk.dim("No clips on timeline")), box.bottom].join("\n");
  }

  // ── Group clips so bar never exceeds barWidth segments ───────────────────────
  const groups = groupClips(clips, barWidth);
  const widths = assignWidths(groups, barWidth);

  // ── Time ruler ───────────────────────────────────────────────────────────────
  const interval = chooseInterval(totalDuration, barWidth);

  const rulerChars = Array<string>(barWidth).fill(" ");
  const tickChars  = Array<string>(barWidth).fill(" ");

  const markerSeconds: number[] = [];
  for (let t = 0; t <= totalDuration; t += interval) {
    markerSeconds.push(t);
  }

  let nextFreePos = 0;
  for (const t of markerSeconds) {
    const pos = Math.round((t / totalDuration) * (barWidth - 1));
    const label = formatMarker(t);
    const start = Math.min(pos, barWidth - label.length);
    if (pos < barWidth) tickChars[pos] = "┬";
    if (start < nextFreePos) continue;
    for (let i = 0; i < label.length; i++) {
      if (start + i < barWidth) rulerChars[start + i] = label[i]!;
    }
    nextFreePos = start + label.length + 1;
  }

  const rulerLine = chalk.dim(rulerChars.join(""));
  const tickLine  = chalk.dim(tickChars.join(""));

  // ── Clip bar ─────────────────────────────────────────────────────────────────
  let clipBar = "";
  groups.forEach((group, idx) => {
    const w = widths[idx]!;
    const color = CLIP_COLORS[group.colorIndex % CLIP_COLORS.length]!;
    const border = color("│");

    if (w === 1) {
      clipBar += border;
      return;
    }

    const interior = w - 1;
    const label = truncateLabel(group.label, interior - 1);
    const fill = "─".repeat(Math.max(0, interior - 1 - label.length));
    clipBar += border + color(` ${label}${fill}`);
  });
  // Close final group
  const lastGroup = groups[groups.length - 1]!;
  clipBar += CLIP_COLORS[lastGroup.colorIndex % CLIP_COLORS.length]!("│");

  // ── Bottom bar (width matches clip bar: barWidth + 1) ────────────────────────
  const bottomBar = chalk.dim("└" + "─".repeat(barWidth));

  // ── Summary (always shows true clip count, not group count) ──────────────────
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

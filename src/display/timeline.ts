import type { ProjectState, Clip } from "../project/types.js";
import { clipsInOrder, layoutTimeline } from "../project/types.js";
import { paint, clipPaint, glyphs, stripAnsi } from "../ui/theme.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const TIME_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

const LABEL_WIDTH = 6; // assumed chars per time marker label for spacing

// ── Interfaces ────────────────────────────────────────────────────────────────

interface HasDuration {
  duration: number;
}

/**
 * Defines the visible window of the timeline.
 * startTime = seconds from the start of the timeline where the view begins.
 * viewDuration = how many seconds are visible (lower = more zoomed in).
 * Exported so the REPL can manage and pass viewport state to renderTimeline.
 */
export interface ViewportState {
  startTime: number;
  viewDuration: number;
}

/**
 * A visual group represents 1+ consecutive clips merged together for display.
 * When clips.length <= barWidth, each clip is its own group.
 * When clips.length > barWidth, consecutive clips are merged proportionally.
 */
interface VisualGroup {
  clips: Clip[];
  totalDuration: number;
  duration: number;      // === totalDuration; satisfies HasDuration
  label: string;         // clip.label if 1 clip, else `${n} clips`
  colorIndex: number;    // original timeline index of the first clip in group
  clippedLeft: boolean;  // this group extends past the left viewport edge
  clippedRight: boolean; // this group extends past the right viewport edge
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMarker(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return sec === 0 ? `${m}m` : `${m}m${sec}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function formatTotal(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function truncateLabel(label: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "─";
  if (width === 2) return "─…";
  if (label.length <= width - 2) return label;
  if (width <= 3) return "…";
  return label.slice(0, width - 3) + "…";
}

/**
 * Each clip's span of the bar: from its timeline start to the next clip's
 * start (crossfaded neighbours overlap, and the overlap is drawn as part of
 * the earlier clip so spans tile the bar exactly). `transitionIn` marks a
 * boundary that is a transition rather than a cut.
 */
interface ClipSpan { start: number; end: number; transitionIn: boolean }

function computeClipSpans(timeline: Parameters<typeof layoutTimeline>[0]): { spans: ClipSpan[]; total: number } {
  const layout = layoutTimeline(timeline);
  const spans = layout.clips.map((p, i) => {
    const next = layout.clips[i + 1];
    const prev = layout.clips[i - 1];
    return { start: p.start, end: next ? next.start : p.end, transitionIn: prev?.transitionOut !== null && prev !== undefined };
  });
  return { spans, total: layout.duration };
}

/**
 * Determine what portion of a clip is visible within [vStart, vEnd].
 */
function clipViewportSlice(
  clipStart: number,
  clipEnd: number,
  vStart: number,
  vEnd: number,
): { visible: boolean; effectiveDuration: number; clippedLeft: boolean; clippedRight: boolean } {
  if (clipEnd <= vStart || clipStart >= vEnd) {
    return { visible: false, effectiveDuration: 0, clippedLeft: false, clippedRight: false };
  }
  const visibleStart = Math.max(clipStart, vStart);
  const visibleEnd   = Math.min(clipEnd, vEnd);
  return {
    visible: true,
    effectiveDuration: visibleEnd - visibleStart,
    clippedLeft:  clipStart < vStart,
    clippedRight: clipEnd   > vEnd,
  };
}

/**
 * Build visual groups from clips filtered to the given viewport.
 * Handles both the visibility filtering and the too-many-clips merging.
 */
function buildViewportGroups(
  clips: Clip[],
  spans: ClipSpan[],
  vStart: number,
  vEnd: number,
  barWidth: number,
): { groups: VisualGroup[]; offScreenLeft: number; offScreenRight: number } {
  // --- Build one candidate group per visible clip ---
  const candidates: VisualGroup[] = [];
  let offScreenLeft  = 0;
  let offScreenRight = 0;
  let firstVisibleIdx = -1;
  let lastVisibleIdx  = -1;

  for (let i = 0; i < clips.length; i++) {
    const clip  = clips[i]!;
    const start = spans[i]!.start;
    const end   = spans[i]!.end;
    const slice = clipViewportSlice(start, end, vStart, vEnd);

    if (!slice.visible) {
      if (end <= vStart) offScreenLeft++;
      else               offScreenRight++;
      continue;
    }

    if (firstVisibleIdx === -1) firstVisibleIdx = i;
    lastVisibleIdx = i;

    let label = clip.label;
    if (slice.clippedLeft)  label = `${glyphs.clippedLeft} ${label}`;
    if (slice.clippedRight) label = `${label} ${glyphs.clippedRight}`;

    candidates.push({
      clips: [clip],
      totalDuration: slice.effectiveDuration,
      duration: slice.effectiveDuration,
      label,
      colorIndex: i,
      clippedLeft:  slice.clippedLeft,
      clippedRight: slice.clippedRight,
    });
  }

  if (candidates.length === 0) {
    return { groups: [], offScreenLeft, offScreenRight };
  }

  // --- Merge if too many candidates for the bar ---
  if (candidates.length <= barWidth) {
    return { groups: candidates, offScreenLeft, offScreenRight };
  }

  // Merge consecutive candidates into at most barWidth groups
  const totalVisibleDuration = candidates.reduce((sum, g) => sum + g.duration, 0);
  const targetDuration = totalVisibleDuration / barWidth;

  const groups: VisualGroup[] = [];
  let batch: VisualGroup[] = [];
  let batchDuration = 0;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]!;
    batch.push(cand);
    batchDuration += cand.duration;

    if (batchDuration >= targetDuration && groups.length < barWidth - 1) {
      const dur = batch.reduce((s, g) => s + g.duration, 0);
      groups.push({
        clips: batch.flatMap((g) => g.clips),
        totalDuration: dur,
        duration: dur,
        label: batch.length === 1 ? batch[0]!.label : `${batch.length} clips`,
        colorIndex: batch[0]!.colorIndex,
        clippedLeft:  batch[0]!.clippedLeft,
        clippedRight: batch[batch.length - 1]!.clippedRight,
      });
      batch = [];
      batchDuration = 0;
    }
  }

  if (batch.length > 0) {
    const dur = batch.reduce((s, g) => s + g.duration, 0);
    groups.push({
      clips: batch.flatMap((g) => g.clips),
      totalDuration: dur,
      duration: dur,
      label: batch.length === 1 ? batch[0]!.label : `${batch.length} clips`,
      colorIndex: batch[0]!.colorIndex,
      clippedLeft:  batch[0]!.clippedLeft,
      clippedRight: batch[batch.length - 1]!.clippedRight,
    });
  }

  return { groups, offScreenLeft, offScreenRight };
}

/**
 * Assign character widths to items proportionally.
 * Every item gets at least 1 character. Extra space distributed by largest
 * fractional remainder.
 */
function assignWidths(items: HasDuration[], barWidth: number): number[] {
  const total = items.reduce((sum, c) => sum + c.duration, 0);
  if (total === 0 || items.length === 0) return items.map(() => 1);

  const raw = items.map((c) => Math.max(1, Math.floor((c.duration / total) * barWidth)));
  let used = raw.reduce((a, b) => a + b, 0);

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

  let trimIdx = 0;
  const bySize = raw.map((w, i) => ({ i, w })).sort((a, b) => b.w - a.w);
  while (used > barWidth) {
    const candidate = bySize[trimIdx % bySize.length]!;
    if (candidate.w > 1) { raw[candidate.i]!--; candidate.w--; used--; }
    trimIdx++;
    if (trimIdx > barWidth * 2) break;
  }

  return raw;
}

/**
 * Choose a sensible time marker interval for the visible duration.
 */
function chooseInterval(visibleSeconds: number, barWidth: number): number {
  const maxMarkers = Math.floor(barWidth / LABEL_WIDTH);
  for (const interval of TIME_INTERVALS) {
    const count = Math.floor(visibleSeconds / interval) + 1;
    if (count <= maxMarkers) return interval;
  }
  return TIME_INTERVALS[TIME_INTERVALS.length - 1]!;
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export function renderTimeline(
  state: ProjectState,
  terminalWidth?: number,
  viewport?: ViewportState,
): string {
  const tWidth = Math.max(20, terminalWidth ?? process.stdout.columns ?? 80);

  const innerWidth = tWidth - 6;
  const barWidth   = Math.max(4, innerWidth - 2);

  const box = {
    top:    `  ╭${"─".repeat(innerWidth + 2)}╮`,
    bottom: `  ╰${"─".repeat(innerWidth + 2)}╯`,
    row: (content: string) => {
      const stripped = stripAnsi(content);
      const pad = Math.max(0, innerWidth - stripped.length);
      return `  │ ${content}${" ".repeat(pad)} │`;
    },
  };

  const clips = clipsInOrder(state.timeline);

  if (clips.length === 0) {
    return [box.top, box.row(paint.muted("No clips on timeline")), box.bottom].join("\n");
  }

  const { spans, total: totalDuration } = computeClipSpans(state.timeline);

  if (totalDuration === 0) {
    return [box.top, box.row(paint.muted("No clips on timeline")), box.bottom].join("\n");
  }

  // Resolve viewport — default covers the full timeline
  const vStart    = viewport?.startTime   ?? 0;
  const vDuration = viewport?.viewDuration ?? totalDuration;
  const vEnd      = vStart + vDuration;

  // Build groups visible within the viewport
  const { groups, offScreenLeft, offScreenRight } = buildViewportGroups(
    clips, spans, vStart, vEnd, barWidth,
  );

  if (groups.length === 0) {
    const msg = `No clips in this view  ${glyphs.clippedLeft} ${offScreenLeft}  ${glyphs.clippedRight} ${offScreenRight}`;
    return [box.top, box.row(paint.muted(msg)), box.bottom].join("\n");
  }

  const widths = assignWidths(groups, barWidth);

  // ── Time ruler (relative to viewport) ────────────────────────────────────────
  const interval = chooseInterval(vDuration, barWidth);

  const rulerChars = Array<string>(barWidth).fill(" ");
  const tickChars  = Array<string>(barWidth).fill(" ");

  // Generate markers at interval boundaries within [vStart, vEnd]
  const firstMarker = Math.ceil(vStart / interval) * interval;
  const markerTimes: number[] = [];
  for (let t = firstMarker; t <= vEnd + interval * 0.01; t += interval) {
    if (t >= vStart - interval * 0.01) markerTimes.push(t);
  }
  // Always include the start of the viewport
  if (markerTimes.length === 0 || markerTimes[0]! > vStart + interval * 0.01) {
    markerTimes.unshift(vStart);
  }

  let nextFreePos = 0;
  for (const t of markerTimes) {
    const pos = Math.round(((t - vStart) / vDuration) * (barWidth - 1));
    const label = formatMarker(t);
    const start = Math.min(pos, barWidth - label.length);
    if (pos >= 0 && pos < barWidth) tickChars[pos] = "┬";
    if (start < nextFreePos || start < 0) continue;
    for (let i = 0; i < label.length; i++) {
      if (start + i < barWidth) rulerChars[start + i] = label[i]!;
    }
    nextFreePos = start + label.length + 1;
  }

  const rulerLine = paint.muted(rulerChars.join(""));
  const tickLine  = paint.muted(tickChars.join(""));

  // ── Clip bar ──────────────────────────────────────────────────────────────────
  let clipBar = "";
  groups.forEach((group, idx) => {
    const w     = widths[idx]!;
    const color = clipPaint(group.colorIndex);
    // A boundary that is a transition (not a cut) gets its own glyph.
    const border = color(idx > 0 && spans[group.colorIndex]?.transitionIn && !group.clippedLeft ? glyphs.transition : "│");

    if (w === 1) {
      clipBar += border;
      return;
    }

    const interior = w - 1;
    const label = truncateLabel(group.label, interior - 1);
    const fill  = "─".repeat(Math.max(0, interior - 1 - label.length));
    clipBar += border + color(` ${label}${fill}`);
  });
  const lastGroup = groups[groups.length - 1]!;
  clipBar += clipPaint(lastGroup.colorIndex)("│");

  // ── Bottom bar ────────────────────────────────────────────────────────────────
  const bottomBar = paint.muted("└" + "─".repeat(barWidth));

  // ── Summary ───────────────────────────────────────────────────────────────────
  let summary = `Total: ${formatTotal(totalDuration)}  ${glyphs.bullet}  ${clips.length} clip${clips.length === 1 ? "" : "s"}`;
  if (offScreenLeft > 0)  summary += `  ${glyphs.bullet}  ${glyphs.clippedLeft} ${offScreenLeft}`;
  if (offScreenRight > 0) summary += `  ${glyphs.clippedRight} ${offScreenRight}`;
  // At extreme narrow widths the summary is the one row that can outgrow the
  // box — truncate (plain text, pre-styling) rather than overflow the frame.
  if (summary.length > innerWidth) summary = summary.slice(0, innerWidth - 1) + glyphs.ellipsis;

  return [
    box.top,
    box.row(rulerLine),
    box.row(tickLine),
    box.row(clipBar),
    box.row(bottomBar),
    box.row(paint.muted(summary)),
    box.bottom,
  ].join("\n");
}

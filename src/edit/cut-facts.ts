import type { ProjectState } from "../project/types.js";
import { layoutTimeline } from "../project/types.js";

/**
 * Measured facts about a cut's sound — what a viewer will hear, in the cut's
 * own time. Not a judgment: these are handed to the reviewer and the director
 * so their judgment ("is this tight enough for what the client asked?") rests
 * on measurements rather than on noticing a quiet stretch by watching.
 *
 * Built from each main-track source's cached silence detection (the same
 * −50 dB measurement speech_ranges uses), mapped through the cut.
 */

export const CUT_SILENCE = { thresholdDb: -50, minDuration: 0.5 } as const;

export interface CutSilence {
  start: number;        // cut seconds
  end: number;
  /** Where it comes from: one part per main-track piece it spans (it can run across a cut). */
  parts: Array<{ source: string; start: number; end: number }>;
}

export interface CutFacts {
  duration: number;
  /** Silent stretches of at least `minReportSeconds`, in cut time. */
  silences: CutSilence[];
  /** Seconds of silence before the first sound, and after the last. */
  leadIn: number;
  tail: number;
  /** Main-track sources with no silence measurement (facts are partial). */
  unmeasured: string[];
}

export function measureCut(state: ProjectState, minReportSeconds = 1.5): CutFacts {
  const layout = layoutTimeline(state.timeline);
  const byId = new Map(state.sources.map((s) => [s.id, s]));
  const pieces: CutSilence[] = [];
  const unmeasured = new Set<string>();

  for (const p of layout.clips) {
    const src = byId.get(p.clip.sourceId);
    if (!src) continue;
    const entry = src.analyses.silences?.find(
      (e) => e.thresholdDb === CUT_SILENCE.thresholdDb && e.minDuration === CUT_SILENCE.minDuration,
    );
    if (!entry) { if (src.audioCodec) unmeasured.add(src.fileName); continue; }
    for (const s of entry.silences) {
      const a = Math.max(s.start, p.clip.inPoint);
      const b = Math.min(s.end, p.clip.outPoint);
      if (b - a <= 0.01) continue;
      pieces.push({
        start: p.start + (a - p.clip.inPoint),
        end: p.start + (b - p.clip.inPoint),
        parts: [{ source: src.fileName, start: a, end: b }],
      });
    }
  }

  // Silence that runs across a cut is one stretch to a listener.
  pieces.sort((x, y) => x.start - y.start);
  const merged: CutSilence[] = [];
  for (const s of pieces) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < 0.05) {
      last.end = Math.max(last.end, s.end);
      last.parts.push(...s.parts);
    } else {
      merged.push({ ...s, parts: [...s.parts] });
    }
  }

  const leadIn = merged[0] && merged[0].start < 0.05 ? merged[0].end : 0;
  const lastSilence = merged[merged.length - 1];
  const tail = lastSilence && lastSilence.end > layout.duration - 0.05 ? layout.duration - lastSilence.start : 0;
  return {
    duration: layout.duration,
    silences: merged.filter((s) => s.end - s.start >= minReportSeconds),
    leadIn,
    tail,
    unmeasured: [...unmeasured],
  };
}

const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** The facts as plain lines, for the reviewer brief and the director. */
export function describeCutFacts(f: CutFacts): string[] {
  const lines = [`Length: ${clock(f.duration)} (${f.duration.toFixed(1)} s).`];
  if (f.leadIn > 0) lines.push(`Before the first sound: ${f.leadIn.toFixed(1)} s of silence.`);
  if (f.tail > 0) lines.push(`After the last sound: ${f.tail.toFixed(1)} s of silence.`);
  if (f.silences.length > 0) {
    lines.push("Silent stretches (cut time → source time):");
    for (const s of f.silences) {
      const where = s.parts.map((p) => `${p.source} ${p.start.toFixed(2)}–${p.end.toFixed(2)} s`).join(" + ");
      lines.push(`  ${clock(s.start)}–${clock(s.end)} (${(s.end - s.start).toFixed(1)} s) → ${where}`);
    }
  } else {
    lines.push("No silent stretches of 1.5 s or more.");
  }
  if (f.unmeasured.length > 0) lines.push(`(Not measured: ${f.unmeasured.join(", ")}.)`);
  return lines;
}

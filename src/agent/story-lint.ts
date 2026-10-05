import type { ProjectState, TranscriptSegment } from "../project/types.js";
import { layoutTimeline } from "../project/types.js";

/**
 * Deterministic story check, run on the would-be timeline before a plan
 * reaches the critic or the user.
 *
 * It catches one specific, measured failure: the edit lets a DIALOGUE source
 * stop while its conversation is still going, and hands the rest of the
 * video to another source's own sound. In three runs of the same product-video
 * prompt the director read the whole call ("Your ride is booked … Have a good
 * day") and still ended it at the user's last cue, because the prompt said
 * "cut to the computer use part" — guidance in the system prompt did not move
 * it, and the critic (seeing a truncated transcript) approved. Quoting the
 * dropped lines back, once, is concrete enough to act on and leaves the
 * director free to re-propose if stopping there was intended.
 */

export interface StoryIssue {
  sourceId: string;
  fileName: string;
  /** Where the dialogue source's last kept range ends (source seconds). */
  stopsAt: number;
  /** Sources that play after it on the main track, with their own sound. */
  followedBy: string[];
  /** Spoken lines after `stopsAt` that the plan drops. */
  droppedLines: TranscriptSegment[];
  message: string;
}

/** A source counts as dialogue when its transcript has at least this many lines. */
const MIN_DIALOGUE_LINES = 5;
/** Ignore a tail of fewer lines / less speech than this (a stray "bye"). */
const MIN_DROPPED_LINES = 2;
const MIN_DROPPED_SPEECH_SECONDS = 3;
/** Quote every dropped line up to this many: eliding the middle hid the
 *  story's actual resolution ("Your ride is booked…") behind "… 10 more …"
 *  while showing only filler, and the director dismissed the check as filler. */
const MAX_QUOTED_LINES = 24;

export function lintStory(state: ProjectState): StoryIssue[] {
  const placed = layoutTimeline(state.timeline).clips;
  if (placed.length < 2) return [];
  const sourceById = new Map(state.sources.map((s) => [s.id, s]));
  const issues: StoryIssue[] = [];

  // Only the main dialogue source — the one with the most spoken lines. A
  // second camera's mic picks up the same conversation as room bleed; checking
  // it too produced a false alarm that discredited the real one.
  const onMainTrack = [...new Set(placed.map((p) => p.clip.sourceId))];
  const spoken = onMainTrack
    .map((id) => {
      const t = sourceById.get(id)?.analyses.transcript;
      return { id, lines: t && t.hasAudio ? dedupe(t.segments) : [] };
    })
    .filter((x) => x.lines.length >= MIN_DIALOGUE_LINES)
    .sort((a, b) => b.lines.length - a.lines.length);
  for (const { id: sourceId, lines } of spoken.slice(0, 1)) {
    const source = sourceById.get(sourceId)!;

    // Where this source's last appearance ends, and what follows it.
    let lastIdx = -1;
    placed.forEach((p, i) => { if (p.clip.sourceId === sourceId) lastIdx = i; });
    const after = placed.slice(lastIdx + 1).filter((p) => p.clip.sourceId !== sourceId);
    if (after.length === 0) continue;   // it plays to the end of the video

    const stopsAt = Math.max(...placed.filter((p) => p.clip.sourceId === sourceId).map((p) => p.clip.outPoint));
    const dropped = lines.filter((l) => l.start >= stopsAt - 0.05);
    const speech = dropped.reduce((t, l) => t + (l.end - l.start), 0);
    if (dropped.length < MIN_DROPPED_LINES || speech < MIN_DROPPED_SPEECH_SECONDS) continue;

    const followedBy = [...new Set(after.map((p) => sourceById.get(p.clip.sourceId)?.fileName ?? p.clip.sourceId))];
    issues.push({
      sourceId,
      fileName: source.fileName,
      stopsAt,
      followedBy,
      droppedLines: dropped,
      message: describe(source.fileName, stopsAt, followedBy, dropped),
    });
  }
  return issues;
}

/** Collapse consecutive repeats (transcription stutter: "Bye. Bye. Bye."). */
function dedupe(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.text.trim().toLowerCase() === s.text.trim().toLowerCase()) continue;
    out.push(s);
  }
  return out;
}

function describe(file: string, stopsAt: number, followedBy: string[], dropped: TranscriptSegment[]): string {
  const q = (l: TranscriptSegment) => `${l.start.toFixed(1)}s "${l.text.trim()}"`;
  const shown = dropped.slice(0, MAX_QUOTED_LINES).map(q);
  const more = dropped.length > MAX_QUOTED_LINES ? `; … and ${dropped.length - MAX_QUOTED_LINES} more` : "";
  const others = followedBy.join(", ");
  return (
    `${file}'s dialogue stops at ${stopsAt.toFixed(1)}s and ${others} then play${followedBy.length === 1 ? "s" : ""} with ` +
    `${followedBy.length === 1 ? "its" : "their"} own sound, but ${file} keeps talking after that. Every line this plan drops: ` +
    `${shown.join("; ")}${more}. ` +
    `Read them for the story's outcome, not just the filler: if any of them resolve what the video is about, the video ` +
    `should end with them. A user instruction to "cut to" or "switch to" ${others} switches the PICTURE — it does not ` +
    `require ending this dialogue. To keep both: tighten ${file} with keepRanges to the lines worth keeping (drop filler ` +
    `and repeats), keep it playing to the end, and show ${others} as cutaways over those lines (addOverlay with fit ` +
    `"contain"/"cover", anchored with atSource on the line each excerpt illustrates).`
  );
}

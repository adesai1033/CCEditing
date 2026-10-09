import type { ProjectState } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { executeDetectSilence } from "./detect_silence.js";

/**
 * `speech_ranges` — where a source is audibly saying something, measured from
 * the audio (silence detection at −50 dB, sensitive enough to keep a quiet
 * phone-speaker line the transcription missed), with the transcript lines
 * that fall in each stretch. A measurement to choose `keep` from — not a rule
 * about what to keep.
 */

export interface SpeechRangesInput {
  sourceId: string;
  start?: number;
  end?: number;
}

export interface SpeechRange {
  start: number;
  end: number;
  lines: string[];
}

export interface SpeechRangesOutput {
  sourceId: string;
  duration: number;
  ranges: SpeechRange[];
  note: string;
}

const THRESHOLD_DB = -50;
const MIN_SILENCE = 0.5;

export async function executeSpeechRanges(state: ProjectState, input: SpeechRangesInput): Promise<ToolResult<SpeechRangesOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };
  if (!source.audioCodec) return { ok: false, error: `${source.fileName} has no audio track.` };

  const silence = await executeDetectSilence(state, { sourceId: source.id, thresholdDb: THRESHOLD_DB, minDuration: MIN_SILENCE });
  if (!silence.ok) return { ok: false, error: silence.error };
  const silences = silence.result.silences;

  // Sound = the complement of measured silence.
  const sound: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) sound.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (source.duration > cursor) sound.push({ start: cursor, end: source.duration });

  const lines = source.analyses.transcript?.segments ?? [];
  const lo = input.start ?? 0;
  const hi = input.end ?? source.duration;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const ranges = sound
    .filter((r) => r.end > lo && r.start < hi)
    .map((r) => ({
      start: r2(r.start),
      end: r2(r.end),
      lines: lines.filter((l) => (l.start + l.end) / 2 >= r.start - 0.2 && (l.start + l.end) / 2 <= r.end + 0.2).map((l) => l.text.trim()),
    }));

  return {
    ok: true,
    result: {
      sourceId: source.id,
      duration: source.duration,
      ranges,
      note: lines.length === 0
        ? "No transcript cached yet — call transcribe_audio to see what is said in each range."
        : "Ranges with no lines are sound the transcription didn't capture (it may still be speech — check before cutting it).",
    },
    ...(silence.stateUpdate ? { stateUpdate: silence.stateUpdate } : {}),
  };
}

const schema: ToolSchema = {
  name: "speech_ranges",
  description:
    "Where a source audibly has something going on (speech, sound), measured from its audio, with the " +
    "transcript lines inside each stretch. Use it to choose what to keep of a dialogue: the gaps between " +
    "ranges are measured silence. Optional start/end limit the window.",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string" },
      start: { type: "number" },
      end: { type: "number" },
    },
    required: ["sourceId"],
  },
};

export const speechRangesTool: Tool<SpeechRangesInput, SpeechRangesOutput> = { execute: executeSpeechRanges, schema };

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectState, SourceFile } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MIN_DURATION = 0.5;
const DEFAULT_THRESHOLD_DB = -35;

export interface DetectSilenceInput {
  sourceId: string;
  minDuration?: number;
  thresholdDb?: number;
}

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

export interface DetectSilenceOutput {
  sourceId: string;
  silences: SilenceRange[];
  minDuration: number;
  thresholdDb: number;
  hasAudio: boolean;
  cached: boolean;
  note?: string;
}

type FfmpegRunner = (input: string, thresholdDb: number, minDuration: number) => Promise<string>;

async function runFfmpeg(input: string, thresholdDb: number, minDuration: number): Promise<string> {
  const args = [
    "-i", input,
    "-af", `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
    "-f", "null",
    "-",
  ];
  try {
    const { stderr } = await execFileAsync("ffmpeg", args);
    return stderr;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error("ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html");
    }
    if (e.stderr) return e.stderr;
    throw new Error(`ffmpeg silence detection failed: ${String(err)}`);
  }
}

/**
 * Parse `silencedetect`'s stderr into ranges.
 *
 * ffmpeg emits `silence_start: N` and a later `silence_end: N | silence_duration: N`.
 * A silence still running at EOF gets a start with NO matching end — closing it
 * at `duration` matters, because trailing dead air is exactly what "cut the
 * silence at the end" is asking about, and dropping it makes the tool silently
 * useless for that request.
 *
 * Exposed for testing.
 */
export function parseSilences(stderr: string, duration: number): SilenceRange[] {
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  const out: SilenceRange[] = [];
  let open: number | null = null;
  let m: RegExpExecArray | null;

  while ((m = re.exec(stderr)) !== null) {
    const kind = m[1]!;
    const t = parseFloat(m[2]!);
    if (kind === "start") {
      open = t;
    } else if (open !== null) {
      // ffmpeg can report a tiny negative start; clamp to the timeline.
      const start = Math.max(0, open);
      if (t > start) out.push({ start, end: t, duration: round(t - start) });
      open = null;
    }
  }

  if (open !== null) {
    const start = Math.max(0, open);
    if (duration > start) out.push({ start, end: duration, duration: round(duration - start) });
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export async function executeDetectSilence(
  state: ProjectState,
  input: DetectSilenceInput,
  runner: FfmpegRunner = runFfmpeg,
): Promise<ToolResult<DetectSilenceOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  const minDuration = input.minDuration ?? DEFAULT_MIN_DURATION;
  const thresholdDb = input.thresholdDb ?? DEFAULT_THRESHOLD_DB;

  if (minDuration <= 0) return { ok: false, error: `minDuration must be greater than 0 (got ${minDuration})` };
  if (thresholdDb > 0) return { ok: false, error: `thresholdDb is a dB level below zero, e.g. -35 (got ${thresholdDb})` };

  const base = { sourceId: source.id, minDuration, thresholdDb };

  if (source.audioCodec === null) {
    return {
      ok: true,
      result: {
        ...base,
        silences: [],
        hasAudio: false,
        cached: false,
        note: `${source.fileName} has no audio track, so it has no detectable silence.`,
      },
    };
  }

  // Params are part of the cache key — a -35dB result must not answer a -50dB
  // request, so entries accumulate instead of overwriting.
  const hit = source.analyses.silences?.find(
    (e) => e.thresholdDb === thresholdDb && e.minDuration === minDuration,
  );
  if (hit) {
    return { ok: true, result: { ...base, silences: hit.silences, hasAudio: true, cached: true } };
  }

  let stderr: string;
  try {
    stderr = await runner(source.filePath, thresholdDb, minDuration);
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }

  const silences = parseSilences(stderr, source.duration);

  const updatedSource: SourceFile = {
    ...source,
    analyses: {
      ...source.analyses,
      silences: [
        ...(source.analyses.silences ?? []),
        { thresholdDb, minDuration, silences, detectedAt: new Date().toISOString() },
      ],
    },
  };
  const stateUpdate: ProjectState = {
    ...state,
    sources: state.sources.map((s) => (s.id === updatedSource.id ? updatedSource : s)),
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    result: {
      ...base,
      silences,
      hasAudio: true,
      cached: false,
      ...(silences.length === 0
        ? {
            note:
              `No silence found at ${thresholdDb}dB over ${minDuration}s. If the user expects a pause here, ` +
              "loosen the threshold (e.g. -50) or shorten minDuration and try again.",
          }
        : {}),
    },
    stateUpdate,
  };
}

const schema: ToolSchema = {
  name: "detect_silence",
  description:
    "Find pauses, dead air, and gaps in a source's audio using ffmpeg. Fast and free — " +
    "prefer it over transcribe_audio when the request is about PAUSES rather than words " +
    "(\"cut the dead air\", \"trim the long gap at the start\"). Returns silence ranges in " +
    "seconds, which make excellent cut points. If the first pass finds nothing useful, " +
    "loosen thresholdDb (more negative = stricter about what counts as silent) or " +
    "minDuration. Cached per (source, thresholdDb, minDuration).",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video." },
      minDuration: {
        type: "number",
        description: "Shortest gap to report, in seconds. Default 0.5.",
      },
      thresholdDb: {
        type: "number",
        description:
          "Level below which audio counts as silent, in dB (negative). Default -35. " +
          "Use -50 for quiet room tone, -25 to catch softer pauses.",
      },
    },
    required: ["sourceId"],
  },
};

export const detectSilence: Tool<DetectSilenceInput, DetectSilenceOutput> = {
  execute: (state, input) => executeDetectSilence(state, input),
  schema,
};

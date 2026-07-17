import type { ProjectState, SourceFile, TranscriptSegment } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import {
  realBackend as defaultBackend,
  WHISPER_MODEL,
  type TranscriptionBackend,
} from "../backends/transcription.js";

/**
 * Hard cap on segments in a single tool result. The full transcript lives in
 * the cache; only a slice ever reaches the agent's context, and that slice is
 * re-sent on every subsequent turn of the loop — so an uncapped result does
 * not just bloat one message, it compounds.
 */
export const MAX_SEGMENTS = 40;

/** Segments of context returned on either side of a query match. */
const CONTEXT_SEGMENTS = 1;

/** How many segments an overview samples. Enough to orient, not to read. */
const OVERVIEW_SAMPLE = 3;

export interface TranscribeAudioInput {
  sourceId: string;
  start?: number;
  end?: number;
  query?: string;
  force?: boolean;
}

export interface TranscribeAudioOutput {
  sourceId: string;
  segments: TranscriptSegment[];
  totalSegments: number;
  transcriptDuration: number;
  truncated: boolean;
  hasAudio: boolean;
  cached: boolean;
  /** Present when the agent should do something differently (narrow, or give up). */
  note?: string;
}

/**
 * Window mode includes any segment that OVERLAPS [start, end) — a segment
 * straddling the boundary is returned, not dropped. Rationale: the agent is
 * usually looking for the speech boundary nearest a time, and silently hiding
 * the segment that spans it is how a cut lands mid-word.
 */
export function selectWindow(segments: TranscriptSegment[], start: number, end: number): TranscriptSegment[] {
  return segments.filter((s) => s.end > start && s.start < end);
}

/**
 * Query mode is deliberately dumb: case-insensitive substring over segment
 * text, plus a segment of context each side. The agent does the semantic work;
 * the tool only retrieves. Matches are merged so overlapping context windows
 * don't return the same segment twice.
 */
export function selectQuery(segments: TranscriptSegment[], query: string): TranscriptSegment[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const keep = new Set<number>();
  segments.forEach((s, i) => {
    if (!s.text.toLowerCase().includes(needle)) return;
    for (let j = i - CONTEXT_SEGMENTS; j <= i + CONTEXT_SEGMENTS; j++) {
      if (j >= 0 && j < segments.length) keep.add(j);
    }
  });

  return [...keep].sort((a, b) => a - b).map((i) => segments[i]!);
}

export async function executeTranscribeAudio(
  state: ProjectState,
  input: TranscribeAudioInput,
  backend: TranscriptionBackend = defaultBackend,
): Promise<ToolResult<TranscribeAudioOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  if (input.start !== undefined && input.end !== undefined && input.end <= input.start) {
    return {
      ok: false,
      error: `Invalid window: end (${input.end}) must be greater than start (${input.start})`,
    };
  }

  const cachedEntry = input.force ? undefined : source.analyses.transcript;

  let segments: TranscriptSegment[];
  let duration: number;
  let hasAudio: boolean;
  let stateUpdate: ProjectState | undefined;

  if (cachedEntry) {
    ({ segments, duration, hasAudio } = cachedEntry);
  } else {
    // Cheap pre-check: the probe already told us there is no audio stream, so
    // don't spin up ffmpeg and an upload to rediscover that.
    if (source.audioCodec === null) {
      segments = [];
      duration = 0;
      hasAudio = false;
    } else {
      try {
        const r = await backend.transcribe(source.filePath, source.duration);
        segments = r.segments;
        duration = r.duration;
        hasAudio = r.hasAudio;
      } catch (err: unknown) {
        return { ok: false, error: `Transcription failed: ${(err as Error).message}` };
      }
    }
    stateUpdate = writeCache(state, source, { segments, duration, hasAudio });
  }

  const base = {
    sourceId: source.id,
    totalSegments: segments.length,
    transcriptDuration: duration,
    hasAudio,
    cached: Boolean(cachedEntry),
  };

  if (!hasAudio) {
    return {
      ok: true,
      result: {
        ...base,
        segments: [],
        truncated: false,
        note: `${source.fileName} has no audio track — there is nothing to transcribe. Tell the user, and use the picture tools instead.`,
      },
      ...(stateUpdate ? { stateUpdate } : {}),
    };
  }

  const selected = select(segments, input);
  const isOverview = input.query === undefined && input.start === undefined && input.end === undefined;
  const capped = selected.slice(0, isOverview ? OVERVIEW_SAMPLE : MAX_SEGMENTS);
  const truncated = capped.length < selected.length;
  const note = noteFor(input, segments, selected, truncated, isOverview);

  return {
    ok: true,
    result: {
      ...base,
      segments: capped,
      truncated,
      ...(note ? { note } : {}),
    },
    ...(stateUpdate ? { stateUpdate } : {}),
  };
}

/**
 * The note is how the tool talks the agent out of drowning itself: it fires on
 * the two paths where the returned segments are NOT the whole answer, and says
 * what to do instead.
 */
function noteFor(
  input: TranscribeAudioInput,
  all: TranscriptSegment[],
  selected: TranscriptSegment[],
  truncated: boolean,
  isOverview: boolean,
): string | undefined {
  if (isOverview) {
    // A transcript at or under the sample size was returned in full, so there
    // is nothing to narrow — nagging here would only buy a wasted second call.
    if (all.length <= OVERVIEW_SAMPLE) return undefined;
    return (
      `Overview only — showing ${OVERVIEW_SAMPLE} of ${all.length} segments, not the transcript. ` +
      "Narrow with `query` to search for what was said, or `start`/`end` to read a window."
    );
  }
  if (truncated) {
    return (
      `Truncated: ${selected.length} segments matched, showing the first ${MAX_SEGMENTS}. ` +
      "Narrow the window or use a more specific query."
    );
  }
  if (input.query !== undefined && selected.length === 0) {
    return `No segment matched "${input.query}". The words may be phrased differently — try another term, or read a window with start/end.`;
  }
  return undefined;
}

function select(segments: TranscriptSegment[], input: TranscribeAudioInput): TranscriptSegment[] {
  if (input.query !== undefined) {
    const hits = selectQuery(segments, input.query);
    // A query plus a window means "find X, but only in here".
    if (input.start !== undefined || input.end !== undefined) {
      return selectWindow(hits, input.start ?? 0, input.end ?? Infinity);
    }
    return hits;
  }
  if (input.start !== undefined || input.end !== undefined) {
    return selectWindow(segments, input.start ?? 0, input.end ?? Infinity);
  }
  return segments;
}

function writeCache(
  state: ProjectState,
  source: SourceFile,
  r: { segments: TranscriptSegment[]; duration: number; hasAudio: boolean },
): ProjectState {
  const updatedSource: SourceFile = {
    ...source,
    analyses: {
      ...source.analyses,
      transcript: {
        segments: r.segments,
        duration: r.duration,
        hasAudio: r.hasAudio,
        model: WHISPER_MODEL,
        transcribedAt: new Date().toISOString(),
      },
    },
  };
  return {
    ...state,
    sources: state.sources.map((s) => (s.id === updatedSource.id ? updatedSource : s)),
    updatedAt: new Date().toISOString(),
  };
}

const schema: ToolSchema = {
  name: "transcribe_audio",
  description:
    "Read what is SPOKEN in a source video, with timestamps. Use `query` to search " +
    "the transcript for what was said (e.g. \"price\"), or `start`/`end` to read a " +
    "specific time window. Every returned segment carries start/end in seconds, so " +
    "you can build trim/split operations directly from them. Do NOT request the whole " +
    "transcript: calling with neither `query` nor a window returns only a short " +
    "overview and asks you to narrow. Transcription is slow and costs money on first " +
    "call, then cached per source.",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video." },
      start: { type: "number", description: "Optional window start in seconds. Segments overlapping the window are returned." },
      end: { type: "number", description: "Optional window end in seconds." },
      query: {
        type: "string",
        description:
          "Optional case-insensitive text search over the transcript. Returns matching " +
          "segments plus one segment of context each side. Prefer this over reading a " +
          "wide window.",
      },
      force: { type: "boolean", description: "Re-transcribe, ignoring the cache. Default false. Rarely needed." },
    },
    required: ["sourceId"],
  },
};

export const transcribeAudio: Tool<TranscribeAudioInput, TranscribeAudioOutput> = {
  execute: (state, input) => executeTranscribeAudio(state, input),
  schema,
};

import type { ProjectState, SourceFile, VisualBeat } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { mapVisualBeats, DESCRIBE_MODEL } from "../backends/gemini.js";

/**
 * `map_visual_beats` — a time-coded map of what is VISIBLE across a whole
 * source, in one call: [{start, end, description}, …] covering it end to end,
 * a new beat at every meaningful change of picture, quoting on-screen text.
 *
 * This is the perception primitive for story edits. To show the right part of
 * a screen recording while the dialogue says "your ride is booked, Alvaro is
 * coming in a Prius", the agent needs to know WHERE in the recording the
 * driver card is — without a describe_segment guess-and-check per window.
 * Cached per source; `start`/`end` slice the returned beats.
 */

export interface MapVisualBeatsInput {
  sourceId: string;
  start?: number;
  end?: number;
  force?: boolean;
}

export interface MapVisualBeatsOutput {
  sourceId: string;
  duration: number;
  beats: VisualBeat[];
  totalBeats: number;
  cached: boolean;
}

export interface BeatsBackend {
  mapVisualBeats: (filePath: string, durationSec: number) => Promise<VisualBeat[]>;
}

const realBeatsBackend: BeatsBackend = { mapVisualBeats };

export async function executeMapVisualBeats(
  state: ProjectState,
  input: MapVisualBeatsInput,
  backend: BeatsBackend = realBeatsBackend,
): Promise<ToolResult<MapVisualBeatsOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  let beats = input.force ? undefined : source.analyses.visualBeats?.beats;
  let stateUpdate: ProjectState | undefined;
  const cached = beats !== undefined;

  if (!beats) {
    try {
      beats = await backend.mapVisualBeats(source.filePath, source.duration);
    } catch (err: unknown) {
      return { ok: false, error: `Mapping visual beats failed: ${(err as Error).message}` };
    }
    if (beats.length === 0) {
      return { ok: false, error: `No visual beats came back for ${source.fileName}; try describe_segment on specific windows.` };
    }
    const updated: SourceFile = {
      ...source,
      analyses: {
        ...source.analyses,
        visualBeats: { beats, model: DESCRIBE_MODEL, generatedAt: new Date().toISOString() },
      },
    };
    stateUpdate = {
      ...state,
      sources: state.sources.map((s) => (s.id === updated.id ? updated : s)),
      updatedAt: new Date().toISOString(),
    };
  }

  // A window returns the beats that OVERLAP it, so a beat straddling the
  // boundary is not silently dropped.
  const from = input.start ?? 0;
  const to = input.end ?? Infinity;
  const selected = beats.filter((b) => b.end > from && b.start < to);

  return {
    ok: true,
    result: { sourceId: source.id, duration: source.duration, beats: selected, totalBeats: beats.length, cached },
    ...(stateUpdate ? { stateUpdate } : {}),
  };
}

const schema: ToolSchema = {
  name: "map_visual_beats",
  description:
    "Time-coded map of what is VISIBLE across a whole source video, in one call: consecutive beats " +
    "{start, end, description} covering it end to end, a new beat whenever the picture meaningfully " +
    "changes (new page, UI state, angle, action), quoting key on-screen text. Use it on screen " +
    "recordings and B-roll before choosing cutaway excerpts, so each excerpt shows what the dialogue is " +
    "saying at that moment. Cached per source; optional start/end return only the beats in that window. " +
    "Beat boundaries are approximate (about a second) — verify a tight cut with describe_segment.",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video." },
      start: { type: "number", description: "Optional: only beats overlapping this window (seconds)." },
      end: { type: "number", description: "Optional window end (seconds)." },
      force: { type: "boolean", description: "Re-map, ignoring the cache. Rarely needed." },
    },
    required: ["sourceId"],
  },
};

export const mapVisualBeatsTool: Tool<MapVisualBeatsInput, MapVisualBeatsOutput> = {
  execute: (state, input) => executeMapVisualBeats(state, input),
  schema,
};

import type { ProjectState, SourceFile } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { realBackend as defaultBackend, DESCRIBE_MODEL, type GeminiBackend } from "../backends/gemini.js";

export interface DescribeSegmentInput {
  sourceId: string;
  start: number;   // seconds
  end: number;     // seconds
}

export interface DescribeSegmentOutput {
  description: string;
  model: string;
  start: number;
  end: number;
  cached: boolean;
}

export async function executeDescribeSegment(
  state: ProjectState,
  input: DescribeSegmentInput,
  backend: GeminiBackend = defaultBackend,
): Promise<ToolResult<DescribeSegmentOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  if (input.end <= input.start) {
    return { ok: false, error: `Invalid segment: end (${input.end}) must be greater than start (${input.start})` };
  }
  if (input.start < 0 || input.end > source.duration) {
    return {
      ok: false,
      error: `Segment ${input.start}-${input.end}s is outside the source duration (0-${source.duration}s)`,
    };
  }

  // Cache hit: exact (start, end) match
  const cached = source.analyses.segmentDescriptions?.find(
    (e) => e.start === input.start && e.end === input.end,
  );
  if (cached) {
    return {
      ok: true,
      result: {
        description: cached.text,
        model: cached.model,
        start: cached.start,
        end: cached.end,
        cached: true,
      },
    };
  }

  let text: string;
  try {
    text = await backend.describeVideoSegment(source.filePath, input.start, input.end);
  } catch (err: unknown) {
    return { ok: false, error: `Gemini segment description failed: ${(err as Error).message}` };
  }

  const entry = {
    start: input.start,
    end: input.end,
    text,
    model: DESCRIBE_MODEL,
    generatedAt: new Date().toISOString(),
  };

  const updatedSource: SourceFile = {
    ...source,
    analyses: {
      ...source.analyses,
      segmentDescriptions: [...(source.analyses.segmentDescriptions ?? []), entry],
    },
  };

  const stateUpdate: ProjectState = {
    ...state,
    sources: state.sources.map((s) => (s.id === updatedSource.id ? updatedSource : s)),
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    result: { description: text, model: DESCRIBE_MODEL, start: input.start, end: input.end, cached: false },
    stateUpdate,
  };
}

const schema: ToolSchema = {
  name: "describe_segment",
  description:
    "Generate a 2-3 sentence description of a SPECIFIC time window of a source " +
    "video (start–end seconds), not the whole source. Use this AFTER find_visual_moment " +
    "returns candidate timestamps to actually understand what's in each window — " +
    "essential when ranking multiple candidates or describing a heavily-trimmed " +
    "clip in a narrative. Cached per (sourceId, start, end) exact match.",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video." },
      start: { type: "number", description: "Window start in seconds (inclusive)." },
      end: { type: "number", description: "Window end in seconds (exclusive)." },
    },
    required: ["sourceId", "start", "end"],
  },
};

export const describeSegment: Tool<DescribeSegmentInput, DescribeSegmentOutput> = {
  execute: (state, input) => executeDescribeSegment(state, input),
  schema,
};

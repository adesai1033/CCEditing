import type { ProjectState, SourceFile } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { realBackend as defaultBackend, DESCRIBE_MODEL, type GeminiBackend } from "../backends/gemini.js";

export interface DescribeClipInput {
  sourceId: string;
}

export interface DescribeClipOutput {
  description: string;
  model: string;
  cached: boolean;
}

export async function executeDescribeClip(
  state: ProjectState,
  input: DescribeClipInput,
  backend: GeminiBackend = defaultBackend,
): Promise<ToolResult<DescribeClipOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  // Cache hit
  if (source.analyses.description) {
    return {
      ok: true,
      result: {
        description: source.analyses.description.text,
        model: source.analyses.description.model,
        cached: true,
      },
    };
  }

  let text: string;
  try {
    text = await backend.describeVideo(source.filePath);
  } catch (err: unknown) {
    return { ok: false, error: `Gemini description failed: ${(err as Error).message}` };
  }

  const updatedSource: SourceFile = {
    ...source,
    analyses: {
      ...source.analyses,
      description: {
        text,
        model: DESCRIBE_MODEL,
        generatedAt: new Date().toISOString(),
      },
    },
  };

  const stateUpdate: ProjectState = {
    ...state,
    sources: state.sources.map((s) => (s.id === updatedSource.id ? updatedSource : s)),
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    result: { description: text, model: DESCRIBE_MODEL, cached: false },
    stateUpdate,
  };
}

const schema: ToolSchema = {
  name: "describe_clip",
  description:
    "Generate a 2-3 sentence content description of the WHOLE source video " +
    "(not the trimmed clip range). Use this when planning a narrative — call " +
    "it on each source you need to understand. Results are cached per source.",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video to describe." },
    },
    required: ["sourceId"],
  },
};

export const describeClip: Tool<DescribeClipInput, DescribeClipOutput> = {
  execute: (state, input) => executeDescribeClip(state, input),
  schema,
};

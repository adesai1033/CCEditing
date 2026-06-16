import type { ProjectState, SourceFile } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { realBackend as defaultBackend, type TwelveLabsBackend } from "../backends/twelvelabs.js";

export interface FindVisualMomentInput {
  sourceId: string;
  query: string;
}

export interface FindVisualMomentOutput {
  hits: Array<{ start: number; end: number; confidence: number }>;
}

/**
 * The execute function takes an optional backend for test injection.
 * In production, callers use `findVisualMoment.execute(state, input)`
 * which uses the real TwelveLabs backend.
 */
export async function executeFindVisualMoment(
  state: ProjectState,
  input: FindVisualMomentInput,
  backend: TwelveLabsBackend = defaultBackend,
): Promise<ToolResult<FindVisualMomentOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  // Cache hit: exact-match query against the cached moments list
  const cached = source.analyses.moments?.find((m) => m.query === input.query);
  if (cached) {
    return { ok: true, result: { hits: cached.hits } };
  }

  // Auto-index if not yet indexed
  let updatedSource = source;
  let stateUpdate: ProjectState | undefined;

  if (!source.analyses.twelveLabs || source.analyses.twelveLabs.status !== "indexed") {
    try {
      const { indexId, videoId } = await backend.indexVideo(source.filePath);
      updatedSource = {
        ...source,
        analyses: {
          ...source.analyses,
          twelveLabs: {
            indexId,
            videoId,
            status: "indexed",
            indexedAt: new Date().toISOString(),
          },
        },
      };
      stateUpdate = replaceSource(state, updatedSource);
    } catch (err: unknown) {
      return { ok: false, error: `TwelveLabs indexing failed: ${(err as Error).message}` };
    }
  }

  // Search
  const tl = updatedSource.analyses.twelveLabs!;
  let hits: Array<{ start: number; end: number; confidence: number }>;
  try {
    hits = await backend.searchMoments(tl.indexId, tl.videoId, input.query);
  } catch (err: unknown) {
    return { ok: false, error: `TwelveLabs search failed: ${(err as Error).message}` };
  }

  // Append to moment cache
  const newMoment = {
    query: input.query,
    hits,
    retrievedAt: new Date().toISOString(),
  };
  const cachedSource: SourceFile = {
    ...updatedSource,
    analyses: {
      ...updatedSource.analyses,
      moments: [...(updatedSource.analyses.moments ?? []), newMoment],
    },
  };
  stateUpdate = replaceSource(stateUpdate ?? state, cachedSource);

  return { ok: true, result: { hits }, stateUpdate };
}

function replaceSource(state: ProjectState, updated: SourceFile): ProjectState {
  return {
    ...state,
    sources: state.sources.map((s) => (s.id === updated.id ? updated : s)),
    updatedAt: new Date().toISOString(),
  };
}

const schema: ToolSchema = {
  name: "find_visual_moment",
  description:
    "Search inside a source video for visual moments matching a natural-language " +
    "description. Returns timestamp ranges (seconds) with confidence scores. " +
    "Use this to locate specific events ('the car crossing the finish line', " +
    "'the summit shot') so you can trim or split around them. " +
    "First call against a source triggers cloud indexing and may take 30s-2min; " +
    "subsequent calls are fast.",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video to search within." },
      query: { type: "string", description: "Natural-language description of the moment to find." },
    },
    required: ["sourceId", "query"],
  },
};

export const findVisualMoment: Tool<FindVisualMomentInput, FindVisualMomentOutput> = {
  execute: (state, input) => executeFindVisualMoment(state, input),
  schema,
};

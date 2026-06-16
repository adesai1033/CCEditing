import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectState, SourceFile } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_THRESHOLD = 0.4;

export interface DetectScenesInput {
  sourceId: string;
  threshold?: number;
}

export interface DetectScenesOutput {
  boundaries: number[];
  threshold: number;
  cached: boolean;
}

type FfmpegRunner = (input: string, threshold: number) => Promise<string>;

// Real runner: invoke ffmpeg with the scene filter and capture stderr (which
// is where showinfo writes its `pts_time:...` lines).
async function runFfmpeg(input: string, threshold: number): Promise<string> {
  const args = [
    "-i", input,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
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
    // Even on non-zero exit, stderr may contain useful info. ffmpeg often
    // exits successfully here, so most cases hit the success path above.
    if (e.stderr) return e.stderr;
    throw new Error(`ffmpeg scene detection failed: ${String(err)}`);
  }
}

/**
 * Parses `pts_time:<number>` occurrences from ffmpeg's showinfo stderr.
 * Exposed for testing.
 */
export function parseSceneBoundaries(stderr: string): number[] {
  const re = /pts_time:(\d+(?:\.\d+)?)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    out.push(parseFloat(m[1]!));
  }
  return out;
}

export async function executeDetectScenes(
  state: ProjectState,
  input: DetectScenesInput,
  runner: FfmpegRunner = runFfmpeg,
): Promise<ToolResult<DetectScenesOutput>> {
  const source = state.sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: `Source not found: ${input.sourceId}` };

  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  // Cache hit only if threshold matches
  if (source.analyses.scenes && source.analyses.scenes.threshold === threshold) {
    return {
      ok: true,
      result: {
        boundaries: source.analyses.scenes.boundaries,
        threshold,
        cached: true,
      },
    };
  }

  let stderr: string;
  try {
    stderr = await runner(source.filePath, threshold);
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
  const boundaries = parseSceneBoundaries(stderr);

  const updatedSource: SourceFile = {
    ...source,
    analyses: {
      ...source.analyses,
      scenes: {
        threshold,
        boundaries,
        detectedAt: new Date().toISOString(),
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
    result: { boundaries, threshold, cached: false },
    stateUpdate,
  };
}

const schema: ToolSchema = {
  name: "detect_scenes",
  description:
    "Detect shot/scene boundaries in a source video using ffmpeg's scene filter. " +
    "Returns an array of timestamps (seconds) where shot cuts occur. Useful for " +
    "deciding where to split a clip without specifying an exact time. Default " +
    "threshold is 0.4 (range 0-1; higher = fewer, more confident cuts).",
  input_schema: {
    type: "object",
    properties: {
      sourceId: { type: "string", description: "UUID of the source video." },
      threshold: {
        type: "number",
        description: "Scene-change sensitivity, 0-1. Default 0.4.",
      },
    },
    required: ["sourceId"],
  },
};

export const detectScenes: Tool<DetectScenesInput, DetectScenesOutput> = {
  execute: (state, input) => executeDetectScenes(state, input),
  schema,
};

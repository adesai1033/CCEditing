import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectState, SourceFile } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { makeProxy, withDecodeSlot, INDEX_PROXY } from "../../media/proxy.js";

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

/**
 * Runs scene detection and returns ffmpeg-showinfo-style text (`pts_time:N`
 * per boundary, in SOURCE seconds). Tests inject a fake; `duration` lets the
 * real runner split the work.
 */
type FfmpegRunner = (input: string, threshold: number, duration?: number) => Promise<string>;

/** Height frames are scaled to before comparison. Scene changes survive easily. */
const SCENE_ANALYSIS_HEIGHT = 360;
/** Below this length a source is analysed in one pass. */
const SCENE_MIN_CHUNK_SECONDS = 20;
const SCENE_CONCURRENCY = 4;
/** Each chunk after the first starts this much early so a cut on a chunk
 *  boundary still has its previous frame to compare against. */
const SCENE_CHUNK_OVERLAP = 1;

/**
 * Args for one chunk. Video only (-an): decoding audio is wasted work here.
 * Frames are hardware-decoded where available and downscaled BEFORE the scene
 * filter — on a 4K/60fps HEVC phone video that alone took detection from 129s
 * to 40s; the parallel chunks cut it further.
 */
export function buildSceneArgs(
  input: string,
  threshold: number,
  window: { start: number; duration: number } | null,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    "-nostdin", "-hide_banner",
    ...(platform === "darwin" ? ["-hwaccel", "videotoolbox"] : []),
    ...(window ? ["-ss", String(window.start), "-t", String(window.duration)] : []),
    "-i", input,
    "-an", "-sn", "-dn",
    "-vf", `scale=-2:${SCENE_ANALYSIS_HEIGHT},select='gt(scene,${threshold})',showinfo`,
    "-f", "null",
    "-",
  ];
}

/** Chunk windows covering [0, duration), each but the first reaching back by the overlap. */
export function planSceneChunks(duration: number): Array<{ start: number; duration: number }> {
  const n = Math.max(1, Math.min(SCENE_CONCURRENCY, Math.floor(duration / SCENE_MIN_CHUNK_SECONDS)));
  const len = Math.ceil(duration / n);
  const out: Array<{ start: number; duration: number }> = [];
  for (let i = 0; i < n; i++) {
    const nominal = i * len;
    if (nominal >= duration) break;
    const start = i === 0 ? 0 : nominal - SCENE_CHUNK_OVERLAP;
    out.push({ start, duration: Math.min(duration, nominal + len) - start });
  }
  return out;
}

/** Sort and drop boundaries within 0.1s of each other (the overlap reports some twice). */
export function mergeBoundaries(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) if (out.length === 0 || t - out[out.length - 1]! > 0.1) out.push(t);
  return out;
}

async function runChunk(args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
    return stderr;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error("ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html");
    }
    // ffmpeg often still produced usable showinfo output.
    if (e.stderr) return e.stderr;
    throw new Error(`ffmpeg scene detection failed: ${String(err)}`);
  }
}

// Real runner. Preferred path: scan the source's cached 720p master proxy
// (media/proxy.ts) — same timestamps as the source, and decoding it takes
// seconds where a 4K/60fps original takes minutes. The master is usually
// already built by background indexing. If it can't be made, fall back to
// scanning the original in parallel chunks.
async function runFfmpeg(input: string, threshold: number, duration?: number): Promise<string> {
  try {
    const master = await makeProxy(input, INDEX_PROXY);
    return await withDecodeSlot(() => runChunk(buildSceneArgs(master.path, threshold, null)));
  } catch {
    return runOriginal(input, threshold, duration);
  }
}

// Fallback: split long sources into chunks analysed in parallel. With input
// seeking each chunk's pts restart at 0, so offsets are added back.
async function runOriginal(input: string, threshold: number, duration?: number): Promise<string> {
  if (!duration || duration < SCENE_MIN_CHUNK_SECONDS * 2) {
    return runChunk(buildSceneArgs(input, threshold, null));
  }
  const chunks = planSceneChunks(duration);
  const outputs = await Promise.all(chunks.map((c) => withDecodeSlot(() => runChunk(buildSceneArgs(input, threshold, c)))));
  const all = outputs.flatMap((text, i) => parseSceneBoundaries(text).map((t) => t + chunks[i]!.start));
  return mergeBoundaries(all).map((t) => `pts_time:${t.toFixed(6)}`).join("\n");
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
    stderr = await runner(source.filePath, threshold, source.duration);
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

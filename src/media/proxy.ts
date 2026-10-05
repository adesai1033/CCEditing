import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runFfmpeg, type FfmpegRunner } from "../engine/preview.js";
import { buildConcatFileContent } from "../engine/ffmpeg.js";
import { probeFile } from "./probe.js";

/**
 * Analysis proxies: small, low-resolution copies of a source (or one window
 * of it) made locally before anything is uploaded to a perception API.
 *
 * Why: Gemini samples ~1 frame/s at low resolution and TwelveLabs indexes at
 * well under 4K, so uploading a 1.5 GB 4K/60fps HEVC original sends ~1000×
 * more bytes than the model ever looks at (measured: 1.5 GB → 1.3 MB for a
 * 143 s phone video at 480p/2fps). The bottleneck moves from the network to
 * local decode, which is then parallelized: the window is split into
 * whole-second chunks transcoded concurrently and stream-copied together.
 * Whole-second boundaries keep every chunk an exact multiple of the output
 * frame interval, so stitched timestamps line up with the source — search
 * results from an indexed proxy are valid source times.
 *
 * Proxies are cached in the temp dir keyed on (source identity, window,
 * spec), so repeated calls on the same source/window reuse them across runs.
 *
 * One expensive decode per source: INDEX_PROXY (720p, ≤30fps, same timestamps
 * as the source) is the MASTER. Every other proxy — a description copy, a
 * window for one segment — is cut from the master rather than the original,
 * and scene detection reads it too. Decoding a 4K/60fps HEVC original is the
 * whole cost; decoding an 8 MB 720p master is seconds. Measured on a survey of
 * three phone videos: 24 concurrent original-file decodes made each scout's
 * first round 3–9× slower than the same tools alone. Heavy decodes also share
 * a machine-wide slot limit (withDecodeSlot) so parallel scouts queue instead
 * of thrashing one hardware decoder.
 */

export interface ProxySpec {
  /** Short-side cap in pixels (never upscales). */
  shortSide: number;
  /** Frame-rate cap (never raises the source's rate). */
  fps: number;
  crf: number;
  audioBitrate: string;
}

/** For Gemini descriptions: it samples ~1 fps at low resolution anyway. */
export const DESCRIBE_PROXY: ProxySpec = { shortSide: 480, fps: 2, crf: 30, audioBitrate: "64k" };

/** For TwelveLabs indexing: enough resolution and motion for visual search. */
export const INDEX_PROXY: ProxySpec = { shortSide: 720, fps: 30, crf: 28, audioBitrate: "96k" };

/** Bumping this invalidates every cached proxy. */
const PROXY_VERSION = 2;
const MAX_CACHED_PROXIES = 64;
/** Below this, a window is transcoded in one pass (spawn overhead dominates). */
const MIN_CHUNK_SECONDS = 15;
/** Measured on Apple silicon: 4 workers saturate the hardware HEVC decoder. */
export const DEFAULT_PROXY_CONCURRENCY = 4;

// ── Machine-wide decode slots ─────────────────────────────────────────────────

let decodeLimit = DEFAULT_PROXY_CONCURRENCY;
let decodeActive = 0;
const decodeWaiters: Array<() => void> = [];

/** Run `fn` holding one of the shared heavy-decode slots. */
export async function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (decodeActive >= decodeLimit) {
    await new Promise<void>((resolve) => decodeWaiters.push(resolve));
  }
  decodeActive += 1;
  try {
    return await fn();
  } finally {
    decodeActive -= 1;
    decodeWaiters.shift()?.();
  }
}

/** Test seam: change the slot count (returns the previous value). */
export function setDecodeSlots(n: number): number {
  const prev = decodeLimit;
  decodeLimit = Math.max(1, n);
  return prev;
}

export interface ProxyOptions {
  /** Window of the source in seconds; omit for the whole file. */
  start?: number;
  end?: number;
  concurrency?: number;
  signal?: AbortSignal;
  /** Injected for tests. */
  ffmpeg?: FfmpegRunner;
  probe?: (file: string) => Promise<{ duration: number; fps: number } | null>;
  cacheDir?: string;
  platform?: NodeJS.Platform;
  /** Cut from the original even when a master could be used (tests / fallback). */
  fromOriginal?: boolean;
}

export interface ProxyResult {
  path: string;
  bytes: number;
  cached: boolean;
  chunks: number;
}

export interface ChunkWindow { start: number; duration: number }

/**
 * Split [start, end) into at most `concurrency` chunks of whole-second length
 * (the last takes the remainder). Short windows stay a single chunk.
 */
export function planProxyChunks(start: number, end: number, concurrency: number): ChunkWindow[] {
  const len = end - start;
  const n = Math.max(1, Math.min(concurrency, Math.floor(len / MIN_CHUNK_SECONDS)));
  if (n === 1) return [{ start, duration: len }];
  const chunkLen = Math.ceil(len / n);
  const out: ChunkWindow[] = [];
  for (let s = 0; s < len - 1e-6; s += chunkLen) {
    out.push({ start: start + s, duration: Math.min(chunkLen, len - s) });
  }
  return out;
}

const num = (n: number): string => Number(n.toFixed(3)).toString();

/**
 * FFmpeg args for one proxy chunk. Input seeking (-ss before -i) is fast and
 * lands on the exact time after decoding forward from the prior keyframe.
 * The scale expression caps the SHORT side so portrait phone footage is not
 * squeezed to a sliver; commas are escaped for the filter parser.
 */
export function buildProxyArgs(
  input: string,
  window: ChunkWindow,
  spec: ProxySpec,
  sourceFps: number,
  output: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const fps = sourceFps > 0 ? Math.min(spec.fps, sourceFps) : spec.fps;
  const s = spec.shortSide;
  const scale =
    `scale=w='if(gt(iw\\,ih)\\,-2\\,min(${s}\\,iw))':h='if(gt(iw\\,ih)\\,min(${s}\\,ih)\\,-2)'`;
  return [
    // Hardware decode where available; ffmpeg falls back to software itself.
    ...(platform === "darwin" ? ["-hwaccel", "videotoolbox"] : []),
    "-ss", num(window.start),
    "-t", num(window.duration),
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", `fps=${num(fps)},${scale}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(spec.crf),
    "-c:a", "aac", "-b:a", spec.audioBitrate, "-ac", "1",
    "-y", output,
  ];
}

const inFlight = new Map<string, Promise<ProxyResult>>();

/**
 * Make (or reuse) a proxy of `input`. Concurrent requests for the same proxy
 * share one transcode. Partial output never lands in the cache: chunks are
 * written to a scratch dir and the final file is renamed into place.
 */
export async function makeProxy(input: string, spec: ProxySpec, opts: ProxyOptions = {}): Promise<ProxyResult> {
  const cacheDir = opts.cacheDir ?? path.join(os.tmpdir(), "cutcli-proxies");
  const srcStat = await stat(input);
  const key = createHash("sha1").update(JSON.stringify({
    input, size: srcStat.size, mtimeMs: srcStat.mtimeMs,
    start: opts.start ?? null, end: opts.end ?? null, spec, v: PROXY_VERSION,
  })).digest("hex");
  const outPath = path.join(cacheDir, `${key}.mp4`);

  const existing = await stat(outPath).catch(() => null);
  if (existing) {
    await utimes(outPath, new Date(), new Date()).catch(() => {});
    return { path: outPath, bytes: existing.size, cached: true, chunks: 0 };
  }

  const pending = inFlight.get(outPath);
  if (pending) return pending;
  const job = buildProxy(input, spec, opts, cacheDir, key, outPath).finally(() => inFlight.delete(outPath));
  inFlight.set(outPath, job);
  return job;
}

async function buildProxy(
  input: string,
  spec: ProxySpec,
  opts: ProxyOptions,
  cacheDir: string,
  key: string,
  outPath: string,
): Promise<ProxyResult> {
  const ffmpeg = opts.ffmpeg ?? runFfmpeg;
  const probe = opts.probe ?? defaultProbe;
  await mkdir(cacheDir, { recursive: true });

  const info = await probe(input);
  if (!info) throw new Error(`Could not read ${path.basename(input)} to make an upload proxy`);
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(info.duration, opts.end ?? info.duration);
  if (end <= start) throw new Error(`Empty window ${start}s–${end}s for ${path.basename(input)}`);

  // Derived proxies read the master, not the original (see header). The master
  // has the source's timestamps, so the same window applies unchanged.
  let readFrom = input;
  let readFps = info.fps;
  let concurrency = opts.concurrency ?? DEFAULT_PROXY_CONCURRENCY;
  if (!isMaster(spec) && !opts.fromOriginal) {
    const master = await makeProxy(input, INDEX_PROXY, {
      ...opts, start: undefined, end: undefined,
    });
    readFrom = master.path;
    readFps = Math.min(info.fps || INDEX_PROXY.fps, INDEX_PROXY.fps);
    concurrency = 1;   // a small file: one pass beats spawning chunks
  }

  const chunks = planProxyChunks(start, end, concurrency);
  const workDir = path.join(cacheDir, `${key}.work-${process.pid}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const tmpOut = path.join(workDir, "proxy.mp4");

  try {
    if (chunks.length === 1) {
      const r = await withDecodeSlot(() => ffmpeg(buildProxyArgs(readFrom, chunks[0]!, spec, readFps, tmpOut, opts.platform), { signal: opts.signal }));
      if (!r.ok) throw new Error(`Making an upload proxy of ${path.basename(input)} failed: ${r.error}`);
    } else {
      const chunkPaths = chunks.map((_, i) => path.join(workDir, `c${String(i).padStart(3, "0")}.mp4`));
      // Abort the siblings as soon as one chunk fails.
      const local = new AbortController();
      const onAbort = () => local.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const results = await Promise.all(chunks.map(async (c, i) => {
          const r = await withDecodeSlot(() => ffmpeg(buildProxyArgs(readFrom, c, spec, readFps, chunkPaths[i]!, opts.platform), { signal: local.signal }));
          if (!r.ok) local.abort();
          return r;
        }));
        const failed = results.find((r) => !r.ok && r.code !== "ABORTED") ?? results.find((r) => !r.ok);
        if (failed && !failed.ok) throw new Error(`Making an upload proxy of ${path.basename(input)} failed: ${failed.error}`);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const listPath = path.join(workDir, "list.txt");
      await writeFile(listPath, buildConcatFileContent(chunkPaths), "utf-8");
      const joined = await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", tmpOut], { signal: opts.signal });
      if (!joined.ok) throw new Error(`Joining the upload proxy of ${path.basename(input)} failed: ${joined.error}`);
    }
    await rename(tmpOut, outPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  await evictOldProxies(cacheDir, outPath);
  const bytes = (await stat(outPath)).size;
  return { path: outPath, bytes, cached: false, chunks: chunks.length };
}

function isMaster(spec: ProxySpec): boolean {
  return spec.shortSide === INDEX_PROXY.shortSide && spec.fps === INDEX_PROXY.fps &&
    spec.crf === INDEX_PROXY.crf && spec.audioBitrate === INDEX_PROXY.audioBitrate;
}

async function defaultProbe(file: string): Promise<{ duration: number; fps: number } | null> {
  const r = await probeFile(file);
  return r.ok ? { duration: r.data.duration, fps: r.data.fps } : null;
}

async function evictOldProxies(cacheDir: string, keep: string): Promise<void> {
  let names: string[];
  try { names = (await readdir(cacheDir)).filter((n) => n.endsWith(".mp4")); } catch { return; }
  if (names.length <= MAX_CACHED_PROXIES) return;
  const entries = (await Promise.all(names.map(async (n) => {
    const p = path.join(cacheDir, n);
    try { return { p, mtimeMs: (await stat(p)).mtimeMs }; } catch { return null; }
  }))).filter((e): e is { p: string; mtimeMs: number } => e !== null && e.p !== keep);
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  await Promise.all(entries.slice(0, names.length - MAX_CACHED_PROXIES).map((e) => rm(e.p, { force: true })));
}

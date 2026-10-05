import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TrimOperation, OverlayLayer, JoinSegment } from "./types.js";
import type { Transition } from "../project/types.js";
import { buildTrimArgs, buildConcatFileContent, buildOverlayArgs, buildJoinArgs, joinNeedsFilter, formatsMatch, type EncodeSettings, type JoinTarget } from "./ffmpeg.js";
import { probeFile } from "../media/probe.js";

/**
 * Preview rendering (3H): the human-side counterpart to describe_segment.
 * Renders a timeline (real or scratch) to a temp file the system player can
 * show, fast enough to be a foreground action.
 *
 * Two invariants:
 *  - Speed over fidelity, never over accuracy (decision 2). Preview reuses the
 *    SAME frame-accurate output-seeking trim from Slice 2 via buildTrimArgs;
 *    only the encoder quality knobs differ. Audio is always kept (decision 3).
 *  - Nothing here touches project state (decision 9). The segment cache is a
 *    temp-dir artifact keyed on (source identity, in/out, settings), bounded
 *    by LRU, and removed on process exit.
 */

// The one tunable knob set (decision 2). `version` participates in the cache
// key, so bumping it invalidates stale segments when these change.
export const PREVIEW_SETTINGS = {
  maxHeight: 480,
  crf: 28,
  preset: "ultrafast",
  audioBitrate: "96k",
  version: 1,
} as const;

const PREVIEW_ENCODE: EncodeSettings = {
  crf: PREVIEW_SETTINGS.crf,
  preset: PREVIEW_SETTINGS.preset,
  maxHeight: PREVIEW_SETTINGS.maxHeight,
  audioBitrate: PREVIEW_SETTINGS.audioBitrate,
};

// LRU bound on cached segment renders (decision 7).
export const MAX_PREVIEW_CACHE_SEGMENTS = 48;

/**
 * Edge effects carried by a segment into the join. Absent on a plain cut
 * timeline; present on EVERY segment once any clip has an effect, because the
 * filter join must know each segment's audio presence.
 */
export interface SegmentEffects {
  fadeIn?: number;
  fadeOut?: number;
  transitionOut?: Transition | null;
  hasAudio?: boolean;   // default true
}

/** One contiguous piece of a source, in source seconds. */
export interface PreviewSegment {
  input: string;   // source file path
  start: number;
  end: number;
  effects?: SegmentEffects;
}

/** Trim args for one preview segment — same builder as export, preview knobs. */
export function buildPreviewTrimArgs(seg: PreviewSegment, output: string): string[] {
  const op: TrimOperation = { type: "trim", input: seg.input, start: seg.start, end: seg.end, output };
  return buildTrimArgs(op, PREVIEW_ENCODE);
}

// ── FFmpeg runner with progress + abort (decision 6) ─────────────────────────

export type FfmpegRunResult =
  | { ok: true }
  | { ok: false; code: "NO_FFMPEG" | "FFMPEG_FAILED" | "ABORTED"; error: string };

export type FfmpegRunner = (
  args: string[],
  opts?: { signal?: AbortSignal; onOutTime?: (seconds: number) => void },
) => Promise<FfmpegRunResult>;

/**
 * Spawn-based FFmpeg execution. `-progress pipe:1` streams out_time ticks for
 * the progress callback; an aborted signal SIGKILLs the child and resolves
 * ABORTED once it has actually exited — no zombie, no dangling writer on the
 * output file the caller is about to unlink.
 */
export const runFfmpeg: FfmpegRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ ok: false, code: "ABORTED", error: "cancelled" });
      return;
    }

    const child = spawn("ffmpeg", ["-nostdin", "-loglevel", "error", "-progress", "pipe:1", ...args]);
    let stderr = "";
    let stdoutBuf = "";
    let settled = false;
    const finish = (r: FfmpegRunResult) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        // ffmpeg quirk: out_time_ms is ALSO microseconds; both forms are µs.
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) opts.onOutTime?.(Number(m[1]) / 1_000_000);
      }
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ENOENT"
        ? { ok: false, code: "NO_FFMPEG", error: "ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html" }
        : { ok: false, code: "FFMPEG_FAILED", error: String(err) });
    });
    child.on("close", (code, signal) => {
      if (opts.signal?.aborted || signal) return finish({ ok: false, code: "ABORTED", error: "cancelled" });
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, code: "FFMPEG_FAILED", error: lastErrorLine(stderr) });
    });
  });

function lastErrorLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "FFmpeg failed with an unknown error";
}

// ── Work dir (temp, cleaned on exit) ──────────────────────────────────────────

let defaultWorkDir: string | null = null;

function ensureDefaultWorkDir(): string {
  if (!defaultWorkDir) {
    defaultWorkDir = path.join(os.tmpdir(), `cutcli-preview-${process.pid}`);
    // Exit hooks must be sync; best-effort removal of segments + outputs.
    process.on("exit", () => {
      try { rmSync(defaultWorkDir!, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }
  return defaultWorkDir;
}

let outputCounter = 0;

// ── Render ────────────────────────────────────────────────────────────────────

export interface RenderPreviewOpts {
  /** Overall render progress, 0–100. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /**
   * Overlay layers to composite over the joined segments, `at` relative to
   * the rendered file's t=0 (see engine/layers.ts). Not cached: the layer
   * geometry is cheap to re-run and depends on the whole base.
   */
  overlays?: OverlayLayer[];
  /** Injected for tests. Defaults to ffprobe (frame size, fps, audio of a rendered file). */
  probe?: (file: string) => Promise<(JoinTarget & { hasAudio?: boolean }) | null>;
  /** Injected for tests. Defaults to the real spawn-based runner. */
  ffmpeg?: FfmpegRunner;
  /** Injected for tests. Defaults to a per-process temp dir removed on exit. */
  workDir?: string;
}

export type RenderPreviewResult =
  | { ok: true; path: string; cachedSegments: number; renderedSegments: number }
  | { ok: false; code: "ABORTED" | "NO_FFMPEG" | "FFMPEG_FAILED" | "EMPTY" | "MISSING_SOURCE"; error: string };

/**
 * Render an ordered list of segments to one playable temp file: per-segment
 * frame-accurate trims at preview quality (cached, decision 7), then the same
 * concat-demuxer stream-copy join /export uses. The output is a fresh file per
 * call so cache eviction can never pull a file out from under a playing player.
 */
export async function renderPreviewFromSegments(
  segments: PreviewSegment[],
  opts: RenderPreviewOpts = {},
): Promise<RenderPreviewResult> {
  if (segments.length === 0) return { ok: false, code: "EMPTY", error: "Nothing to preview." };
  const ffmpeg = opts.ffmpeg ?? runFfmpeg;
  const workDir = opts.workDir ?? ensureDefaultWorkDir();
  const cacheDir = path.join(workDir, "segments");
  await mkdir(cacheDir, { recursive: true });

  const overlays = opts.overlays ?? [];
  const totalDuration = segments.reduce((s, seg) => s + (seg.end - seg.start), 0);

  // The join: a stream copy on a plain cut timeline, a re-encoding filter
  // pass once any segment carries a transition or fade.
  const joinSegments: JoinSegment[] = segments.map((seg) => ({
    path: "",   // filled in once the segment is rendered
    duration: seg.end - seg.start,
    hasAudio: seg.effects?.hasAudio ?? true,
    fadeIn: seg.effects?.fadeIn,
    fadeOut: seg.effects?.fadeOut,
    transitionOut: seg.effects?.transitionOut ?? null,
  }));
  let filterJoin = joinNeedsFilter(joinSegments);
  if (filterJoin) {
    const withAudio = joinSegments.filter((j) => j.hasAudio).length;
    if (withAudio > 0 && withAudio < joinSegments.length) {
      return { ok: false, code: "FFMPEG_FAILED", error: "Transitions need every clip to have audio, or none of them to." };
    }
  }

  // Progress is split across stages by cost: segment renders, the join (a
  // sliver when it is a stream copy, a full re-encode with transitions), and
  // the overlay compositing pass when there is one.
  const weights = { segments: 1, join: filterJoin ? 1 : 0.05, overlays: overlays.length > 0 ? 1 : 0 };
  const totalWeight = weights.segments + weights.join + weights.overlays;
  const stage = (before: number, w: number) => ({
    from: Math.round((before / totalWeight) * 100),
    span: Math.round((w / totalWeight) * 100),
  });
  const segStage = stage(0, weights.segments);
  const joinStage = stage(weights.segments, weights.join);
  const ovStage = stage(weights.segments + weights.join, weights.overlays);
  const report = (st: { from: number; span: number }, fraction: number) => {
    opts.onProgress?.(Math.min(99, st.from + Math.round(Math.max(0, Math.min(1, fraction)) * st.span)));
  };
  const emit = (doneDur: number, currentDur: number) => {
    if (!opts.onProgress || totalDuration <= 0) return;
    report(segStage, (doneDur + currentDur) / totalDuration);
  };
  emit(0, 0);

  // ── Per-segment renders, cache-keyed on source identity + range + settings ──
  const segmentPaths: string[] = [];
  let cachedSegments = 0;
  let renderedSegments = 0;
  let doneDuration = 0;

  for (const seg of segments) {
    let srcStat;
    try {
      srcStat = await stat(seg.input);
    } catch {
      return { ok: false, code: "MISSING_SOURCE", error: `Source file not found: ${seg.input}` };
    }
    const key = createHash("sha1")
      .update(JSON.stringify({
        input: seg.input, size: srcStat.size, mtimeMs: srcStat.mtimeMs,
        start: seg.start, end: seg.end, settings: PREVIEW_SETTINGS,
      }))
      .digest("hex");
    const segPath = path.join(cacheDir, `${key}.mp4`);

    const cached = await stat(segPath).then(() => true).catch(() => false);
    if (cached) {
      cachedSegments += 1;
      // Touch for LRU recency so a hot segment isn't the eviction victim.
      await utimes(segPath, new Date(), new Date()).catch(() => {});
    } else {
      const r = await ffmpeg(buildPreviewTrimArgs(seg, segPath), {
        signal: opts.signal,
        onOutTime: (sec) => emit(doneDuration, Math.min(sec, seg.end - seg.start)),
      });
      if (!r.ok) {
        await unlink(segPath).catch(() => {});   // partial render never poisons the cache
        return r;
      }
      renderedSegments += 1;
    }
    segmentPaths.push(segPath);
    doneDuration += seg.end - seg.start;
    emit(doneDuration, 0);
  }

  await evictLru(cacheDir, new Set(segmentPaths));

  // ── Join into a fresh output file ─────────────────────────────────────────
  const probe = opts.probe ?? defaultProbe;
  const outPath = path.join(workDir, `preview-${Date.now()}-${outputCounter++}.mp4`);

  // Segments from mixed sources can't be stream-copied together (formatsMatch).
  // Probing the small rendered segments is cheap; when they differ, conform
  // them through the filter join. A segment that can't be probed leaves the
  // decision alone.
  if (!filterJoin && segmentPaths.length > 1) {
    const infos = await Promise.all(segmentPaths.map((p) => probe(p)));
    if (infos.every((i) => i !== null) && !formatsMatch(infos as JoinTarget[])) {
      filterJoin = true;
      infos.forEach((info, i) => { if (info!.hasAudio !== undefined) joinSegments[i]!.hasAudio = info!.hasAudio; });
      const withAudio = joinSegments.filter((j) => j.hasAudio).length;
      if (withAudio > 0 && withAudio < joinSegments.length) {
        return { ok: false, code: "FFMPEG_FAILED", error: "These clips mix sources with and without audio, which can't be joined yet." };
      }
    }
  }

  let joined: FfmpegRunResult;
  if (filterJoin) {
    // xfade/concat need conformed inputs: the first segment sets the target.
    const target = await probe(segmentPaths[0]!);
    if (!target) return { ok: false, code: "FFMPEG_FAILED", error: "Could not read the rendered segment's dimensions." };
    joinSegments.forEach((j, i) => { j.path = segmentPaths[i]!; });
    const joinedDuration = joinSegments.reduce((s, j, i) =>
      s + j.duration - (i < joinSegments.length - 1 ? Math.min(j.transitionOut?.duration ?? 0, j.duration) : 0), 0);
    joined = await ffmpeg(
      buildJoinArgs({ type: "join", segments: joinSegments, output: outPath }, target, PREVIEW_ENCODE),
      { signal: opts.signal, onOutTime: (sec) => report(joinStage, joinedDuration > 0 ? sec / joinedDuration : 1) },
    );
  } else {
    const listPath = path.join(workDir, `concat-${Date.now()}-${outputCounter}.txt`);
    await writeFile(listPath, buildConcatFileContent(segmentPaths), "utf-8");
    joined = await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", outPath], {
      signal: opts.signal,
    });
    await unlink(listPath).catch(() => {});
  }
  if (!joined.ok) {
    await unlink(outPath).catch(() => {});
    return joined;
  }

  if (overlays.length === 0) {
    opts.onProgress?.(100);
    return { ok: true, path: outPath, cachedSegments, renderedSegments };
  }

  // ── Compositing pass over the joined base ─────────────────────────────────
  // Pixel placement needs the base's real (downscaled) dimensions.
  const base = await probe(outPath);
  if (!base) {
    await unlink(outPath).catch(() => {});
    return { ok: false, code: "FFMPEG_FAILED", error: "Could not read the rendered preview's dimensions." };
  }
  const composedPath = path.join(workDir, `preview-${Date.now()}-${outputCounter++}-ov.mp4`);
  const composed = await ffmpeg(
    buildOverlayArgs({ type: "overlay", base: outPath, layers: overlays, output: composedPath }, base, PREVIEW_ENCODE),
    {
      signal: opts.signal,
      onOutTime: (sec) => report(ovStage, totalDuration > 0 ? sec / totalDuration : 1),
    },
  );
  await unlink(outPath).catch(() => {});
  if (!composed.ok) {
    await unlink(composedPath).catch(() => {});
    return composed;
  }

  opts.onProgress?.(100);
  return { ok: true, path: composedPath, cachedSegments, renderedSegments };
}

async function defaultProbe(file: string): Promise<(JoinTarget & { hasAudio: boolean }) | null> {
  const r = await probeFile(file);
  return r.ok ? { width: r.data.width, height: r.data.height, fps: r.data.fps || 30, hasAudio: r.data.audioCodec != null } : null;
}

/** Drop the oldest cached segments beyond the bound; never the ones in use. */
async function evictLru(cacheDir: string, inUse: Set<string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  const entries = (await Promise.all(names.map(async (n) => {
    const p = path.join(cacheDir, n);
    try { return { p, mtimeMs: (await stat(p)).mtimeMs }; } catch { return null; }
  }))).filter((e): e is { p: string; mtimeMs: number } => e !== null && !inUse.has(e.p));

  const excess = names.length - MAX_PREVIEW_CACHE_SEGMENTS;
  if (excess <= 0) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  await Promise.all(entries.slice(0, excess).map((e) => rm(e.p, { force: true })));
}

// ── Player launch (decision 4) ────────────────────────────────────────────────

export interface PlayerLaunch {
  launched: boolean;
  note?: string;
}

/**
 * Launch the OS default handler for the file, detached and non-blocking — we
 * never wait on a player process. Any failure (unknown platform, missing
 * launcher) resolves { launched: false } so the caller can print the path
 * instead; it never throws and never hangs.
 */
export async function openInPlayer(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
): Promise<PlayerLaunch> {
  const launcher =
    platform === "darwin" ? { bin: "open", args: [filePath] } :
    platform === "win32"  ? { bin: "cmd", args: ["/c", "start", "", filePath] } :
    platform === "linux"  ? { bin: "xdg-open", args: [filePath] } :
    null;
  if (!launcher) return { launched: false, note: `no known player launcher for platform "${platform}"` };

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (r: PlayerLaunch) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = spawnFn(launcher.bin, launcher.args, { stdio: "ignore", detached: true });
      child.once("error", (err) => finish({ launched: false, note: String(err) }));
      child.once("spawn", () => { child.unref(); finish({ launched: true }); });
    } catch (err: unknown) {
      finish({ launched: false, note: String(err) });
    }
  });
}

// ── In-terminal playback (--term) ─────────────────────────────────────────────

export type TerminalPlayback =
  | { ok: true }
  | { ok: false; code: "NO_TIMG" | "ABORTED" | "TIMG_FAILED"; error: string };

export interface PlayInTerminalOpts {
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the real spawn. */
  spawnFn?: typeof spawn;
  /** Injected for tests. Defaults to process.stdout. */
  stdout?: { write: (s: string) => unknown };
  /** Injected for tests. Defaults to the terminal's size, read by timg itself. */
  args?: string[];
}

export const TIMG_INSTALL_HINT =
  "timg not found. Install it for in-terminal playback: brew install timg (macOS) or see https://timg.sh/";

// The alternate screen buffer (DECSET 1049) gives timg a blank canvas and hands
// the REPL's frame back untouched when playback ends. Cursor stays hidden on the
// way out because Ink hides it for the life of the app; timg restores it.
const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l\x1b[?25l";

/**
 * Play a rendered preview inline with timg (https://timg.sh/), blocking until
 * playback ends. timg inherits stdout so it can size itself to the terminal;
 * stdin is detached so the REPL keeps the keyboard, and an aborted signal
 * (Ctrl-C / q in the REPL) SIGTERMs the child. Resolves ABORTED only once the
 * child has actually exited, and always leaves the alternate screen — a
 * playback failure must never strand the user on a blank buffer.
 */
export async function playInTerminal(
  filePath: string,
  opts: PlayInTerminalOpts = {},
): Promise<TerminalPlayback> {
  if (opts.signal?.aborted) return { ok: false, code: "ABORTED", error: "cancelled" };
  const spawnFn = opts.spawnFn ?? spawn;
  const stdout = opts.stdout ?? process.stdout;
  // Pinned half-block pixelation (-ph) and a fixed background (-b) keep timg
  // from probing the terminal for graphics protocols / colours — those probes
  // are answered on stdin, which the REPL (not timg) is reading.
  const args = opts.args ?? ["-ph", "-bblack", "--center", "--loops=1", filePath];

  stdout.write(ENTER_ALT_SCREEN);
  try {
    return await new Promise<TerminalPlayback>((resolve) => {
      let settled = false;
      const finish = (r: TerminalPlayback) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
      try {
        child = spawnFn("timg", args, { stdio: ["ignore", "inherit", "pipe"] });
      } catch (err: unknown) {
        finish({ ok: false, code: "TIMG_FAILED", error: String(err) });
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(err.code === "ENOENT"
          ? { ok: false, code: "NO_TIMG", error: TIMG_INSTALL_HINT }
          : { ok: false, code: "TIMG_FAILED", error: String(err) });
      });
      child.on("close", (code, signal) => {
        if (opts.signal?.aborted || signal) return finish({ ok: false, code: "ABORTED", error: "cancelled" });
        if (code === 0) return finish({ ok: true });
        const detail = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
        finish({ ok: false, code: "TIMG_FAILED", error: detail ?? `timg exited with code ${code}` });
      });
    });
  } finally {
    stdout.write(LEAVE_ALT_SCREEN);
  }
}

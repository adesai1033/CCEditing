import { execFile } from "node:child_process";
import { memoized } from "../prefetch.js";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import OpenAI from "openai";
import type { TranscriptSegment } from "../../project/types.js";

const execFileAsync = promisify(execFile);

/**
 * Whisper, not an LLM. Every operation in this product is a time range, so
 * timestamps are the load-bearing output — and an LLM estimates them, while
 * Whisper derives them by aligning audio (cross-attention DTW). Measured on
 * real footage: Gemini returned 1.5s / 1.8s / 2.1s across three runs for the
 * same word; whisper-1 at temperature 0 is deterministic.
 *
 * whisper-1 (not gpt-4o-transcribe) specifically, because it is the model that
 * exposes word-level `timestamp_granularities`.
 */
export const WHISPER_MODEL = "whisper-1";

/** Whisper's hard upload limit. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Sources longer than this are transcribed in chunks. Each chunk's timestamps
 * come back relative to the chunk, and are offset back onto the source
 * timeline during stitching. Getting that offset wrong silently corrupts every
 * downstream cut point, so the arithmetic is isolated in `stitchChunk` and
 * tested directly.
 *
 * 600s is bounded safely under Whisper's 25MB cap: the extraction below pins
 * 16kHz/mono/s16, so raw is 32KB/s and FLAC (lossless, never meaningfully
 * larger than raw) tops out at ~18.3MB for a chunk. Measured on real footage:
 * ~10.8MB. If you raise this, redo that arithmetic.
 */
export const CHUNK_SECONDS = 600;

let cachedClient: OpenAI | null = null;

function openai(): OpenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Get one at https://platform.openai.com/api-keys and add it to .env before transcribing.",
    );
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  duration: number;
  hasAudio: boolean;
}

export interface ChunkPlan {
  index: number;
  start: number;      // seconds into the source
  duration: number;   // seconds
}

/**
 * Split a source duration into chunk windows. Always returns at least one
 * chunk so a short source takes the same code path as a long one — the seam
 * logic is never bypassed in the common case and then wrong when it matters.
 */
export function planChunks(duration: number, chunkSeconds: number = CHUNK_SECONDS): ChunkPlan[] {
  if (!(duration > 0)) return [{ index: 0, start: 0, duration: 0 }];
  const out: ChunkPlan[] = [];
  for (let start = 0, i = 0; start < duration; start += chunkSeconds, i++) {
    out.push({ index: i, start, duration: Math.min(chunkSeconds, duration - start) });
  }
  return out;
}

/**
 * Offset a chunk's chunk-relative segments back onto the source timeline, and
 * drop anything the model hallucinated past the chunk's own length (models
 * occasionally invent trailing segments; letting them through would produce
 * overlapping, non-monotonic timestamps at the seam).
 */
export function stitchChunk(chunk: ChunkPlan, segments: TranscriptSegment[]): TranscriptSegment[] {
  const limit = chunk.start + chunk.duration;
  return segments
    .map((s) => ({
      start: ms(chunk.start + s.start),
      end: ms(chunk.start + s.end),
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0 && s.end > s.start && s.start < limit + 0.001)
    .map((s) => ({ ...s, end: ms(Math.min(s.end, limit)) }));
}

/**
 * Round to milliseconds. Whisper returns float32 noise (1.0800000429153442)
 * which would otherwise be written verbatim into the project file. 1ms is far
 * finer than a frame at any sane fps, so this costs no real precision.
 */
const ms = (n: number) => Math.round(n * 1000) / 1000;

// ── Deps seam ─────────────────────────────────────────────────────────────────

export interface TranscriptionDeps {
  /** Extract a window of the audio track to `outPath`. Rejects if no audio. */
  extractAudio(src: string, outPath: string, start: number, duration: number): Promise<void>;
  /** Transcribe one extracted audio file. Timestamps are chunk-relative. */
  transcribeChunk(audioPath: string): Promise<TranscriptSegment[]>;
  /** Returns true when the container has an audio stream. */
  hasAudioTrack(src: string): Promise<boolean>;
}

async function hasAudioTrack(src: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      src,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract audio only — never upload the video. FLAC at 16kHz/mono/s16: the
 * encoder is built into ffmpeg (no external lib to be missing), it is lossless
 * at a fraction of the video's size, and 16kHz mono is all speech recognition
 * uses.
 *
 * `-sample_fmt s16` is load-bearing, not decoration. Without it ffmpeg decodes
 * AAC to float and the FLAC encoder promotes to 24-bit, producing ~1.5x the
 * bytes (measured: 524KB vs 285KB for the same 15s) for zero ASR benefit — and
 * pushing chunk size toward Whisper's 25MB cap for no reason.
 */
async function extractAudio(src: string, outPath: string, start: number, duration: number): Promise<void> {
  const args = [
    "-ss", String(start),
    "-t", String(duration),
    "-i", src,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-sample_fmt", "s16",
    "-c:a", "flac",
    "-y", outPath,
  ];
  try {
    await execFileAsync("ffmpeg", args);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error("ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html");
    }
    throw new Error(`Audio extraction failed: ${e.stderr?.trim() ?? String(err)}`);
  }
}

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Replace each segment's boundaries with the span of the words it contains.
 *
 * Whisper's segment timestamps are decoder-driven and drift; its word
 * timestamps are DTW-aligned to the audio and are the more accurate signal.
 * Tightening to [first word start, last word end] pulls the boundary onto
 * actual speech onset/offset rather than the decoder's padded guess — which is
 * the whole reason for taking word granularity.
 *
 * A segment whose words can't be located is left untouched rather than dropped:
 * a slightly loose boundary is a far better failure than a missing line.
 *
 * Exposed for testing.
 */
export function tightenWithWords(segments: TranscriptSegment[], words: WhisperWord[]): TranscriptSegment[] {
  if (words.length === 0) return segments;
  const EPS = 0.02;
  return segments.map((seg) => {
    const inside = words.filter((w) => w.start >= seg.start - EPS && w.end <= seg.end + EPS);
    if (inside.length === 0) return seg;
    return { ...seg, start: inside[0]!.start, end: inside.at(-1)!.end };
  });
}

async function transcribeChunk(audioPath: string): Promise<TranscriptSegment[]> {
  const { size } = await stat(audioPath);
  if (size > MAX_UPLOAD_BYTES) {
    // Unreachable with CHUNK_SECONDS=600 given the bound documented above; a
    // loud error beats a confusing 413 if that ever stops being true.
    throw new Error(
      `Audio chunk is ${(size / 1048576).toFixed(1)}MB, over Whisper's 25MB limit. Lower CHUNK_SECONDS.`,
    );
  }

  const r = await openai().audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: WHISPER_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
    // Deterministic decoding: the same audio must yield the same cut points on
    // every run, or an edit is not reproducible.
    temperature: 0,
  });

  const segments = (r.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  return tightenWithWords(segments, (r.words ?? []) as WhisperWord[]);
}

export const realDeps: TranscriptionDeps = { extractAudio, transcribeChunk, hasAudioTrack };

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Transcribe a source end to end: probe for audio, extract each chunk's audio,
 * transcribe it, and stitch chunk-relative timestamps back onto the source
 * timeline. Returns normalized seconds regardless of backend shape — the tool
 * and the agent never see backend-shaped data.
 *
 * A source with no audio track is a normal outcome, not an error: it comes back
 * as `{ hasAudio: false, segments: [] }` for the tool to surface as a plain
 * answer.
 */
export async function transcribe(
  filePath: string,
  duration: number,
  deps: TranscriptionDeps = realDeps,
): Promise<TranscriptionResult> {
  if (!(await deps.hasAudioTrack(filePath))) {
    return { segments: [], duration: 0, hasAudio: false };
  }

  const chunks = planChunks(duration);
  const dir = await mkdtemp(path.join(tmpdir(), "cutcli-audio-"));
  const segments: TranscriptSegment[] = [];

  try {
    for (const chunk of chunks) {
      const out = path.join(dir, `chunk-${chunk.index}.flac`);
      await deps.extractAudio(filePath, out, chunk.start, chunk.duration);
      const raw = await deps.transcribeChunk(out);
      segments.push(...stitchChunk(chunk, raw));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  segments.sort((a, b) => a.start - b.start);
  return { segments, duration, hasAudio: true };
}

/** The production backend: memoized per file, so a transcript started in the
 *  background at /open (agent/prefetch.ts) is reused rather than redone. */
export const realBackend = {
  transcribe: (filePath: string, duration: number) =>
    memoized("transcript", filePath, () => transcribe(filePath, duration)),
};
export type TranscriptionBackend = { transcribe: (filePath: string, duration: number) => Promise<TranscriptionResult> };

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "@google/genai";
import { geminiClient, DESCRIBE_MODEL } from "./gemini.js";
import type { TranscriptSegment } from "../../project/types.js";

const execFileAsync = promisify(execFile);

/**
 * Transcription runs on the same Gemini model as description. Aliased rather
 * than re-declared so there is exactly one place a stale model id can hide —
 * a duplicated literal here is how gemini-2.5-flash rotted unnoticed.
 */
export const TRANSCRIBE_MODEL = DESCRIBE_MODEL;

/**
 * Sources longer than this are transcribed in chunks. Each chunk's timestamps
 * come back relative to the chunk, and are offset back onto the source
 * timeline during stitching. Getting that offset wrong silently corrupts every
 * downstream cut point, so the arithmetic is isolated in `stitchChunk` and
 * tested directly.
 */
export const CHUNK_SECONDS = 600;

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
      start: chunk.start + s.start,
      end: chunk.start + s.end,
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0 && s.end > s.start && s.start < limit + 0.001)
    .map((s) => ({ ...s, end: Math.min(s.end, limit) }));
}

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
 * Extract audio only — never upload the video. FLAC at 16kHz mono: the encoder
 * is built into ffmpeg (no external lib to be missing), it is lossless at a
 * fraction of the video's size, and 16kHz is all speech recognition uses.
 */
async function extractAudio(src: string, outPath: string, start: number, duration: number): Promise<void> {
  const args = [
    "-ss", String(start),
    "-t", String(duration),
    "-i", src,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
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

const SEGMENT_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      start: { type: Type.NUMBER, description: "Segment start in seconds from the beginning of THIS audio file." },
      end: { type: Type.NUMBER, description: "Segment end in seconds from the beginning of THIS audio file." },
      text: { type: Type.STRING, description: "Verbatim transcribed speech for this segment." },
    },
    required: ["start", "end", "text"],
  },
};

async function transcribeChunk(audioPath: string): Promise<TranscriptSegment[]> {
  const g = geminiClient();

  const file = await g.files.upload({ file: audioPath, config: { mimeType: "audio/flac" } });
  let active = file;
  for (let i = 0; i < 60 && active.state !== "ACTIVE"; i++) {
    if (active.state === "FAILED") throw new Error(`Gemini Files API failed to process ${audioPath}`);
    await new Promise((r) => setTimeout(r, 1000));
    active = await g.files.get({ name: active.name! });
  }
  if (active.state !== "ACTIVE") throw new Error(`Gemini Files API timed out processing ${audioPath}`);

  const response = await g.models.generateContent({
    model: TRANSCRIBE_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { mimeType: active.mimeType!, fileUri: active.uri! } },
          {
            text:
              "Transcribe this audio verbatim, split into natural sentence- or phrase-level " +
              "segments. Every segment MUST carry accurate start and end times in seconds, " +
              "measured from the beginning of this audio file. Do not merge the whole audio " +
              "into one segment — a cut placed from a coarse segment lands mid-sentence. " +
              "Transcribe only what is actually spoken: no commentary, no summarising, no " +
              "guessing at inaudible words. Return [] if there is no speech.",
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json", responseSchema: SEGMENT_SCHEMA },
  });

  const raw = response.text;
  if (!raw || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON transcript for ${audioPath}: ${raw.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((s): s is TranscriptSegment =>
      typeof s === "object" && s !== null &&
      typeof (s as TranscriptSegment).start === "number" &&
      typeof (s as TranscriptSegment).end === "number" &&
      typeof (s as TranscriptSegment).text === "string")
    .map((s) => ({ start: s.start, end: s.end, text: s.text }));
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

export const realBackend = { transcribe };
export type TranscriptionBackend = typeof realBackend;

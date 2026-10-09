import { GoogleGenAI, MediaResolution, type File as GeminiFile } from "@google/genai";
import { stat } from "node:fs/promises";
import path from "node:path";
import { makeProxy, DESCRIBE_PROXY, INDEX_PROXY } from "../../media/proxy.js";
import type { VisualBeat } from "../../project/types.js";

export const DESCRIBE_MODEL = "gemini-3.5-flash";

let cachedAi: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  if (cachedAi) return cachedAi;
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey and export it before running this command.",
    );
  }
  cachedAi = new GoogleGenAI({ apiKey });
  return cachedAi;
}

// ── Timeouts ──────────────────────────────────────────────────────────────────
//
// Without these a stalled request leaves the agent's tool spinner running
// forever: the SDK has no default deadline on uploads or generation. Each
// stage fails with a clear error instead, which the tool returns to the agent.

/** Model generation on an already-processed file. */
export const GENERATE_TIMEOUT_MS = 3 * 60_000;
/** Server-side processing after upload (polled once a second). */
export const PROCESSING_TIMEOUT_MS = 2 * 60_000;

/**
 * Upload deadline scaled to the file: a 2-minute floor plus time for the
 * bytes at a conservative 250 KB/s, so a large source on a slow uplink is
 * not cut off while a stalled small upload still fails promptly.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 2 * 60_000 + Math.ceil(bytes / (250 * 1024)) * 1000;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Start a backup request if the first hasn't answered by then. */
export const HEDGE_AFTER_MS = 30_000;
const MAX_ATTEMPTS = 3;

/**
 * Run `attempt` with hedging: Gemini's latency on an identical request was
 * measured anywhere from 4s to over 180s, so a slow call is usually a slow
 * replica, not a hard request. If no attempt has finished after
 * `hedgeAfterMs`, a fresh one starts in parallel (up to `maxAttempts`); the
 * first success wins and the stragglers are aborted. An attempt that FAILS
 * outright starts the next one immediately. The whole thing is bounded by
 * `deadlineMs`.
 */
export async function hedged<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  opts: { hedgeAfterMs?: number; maxAttempts?: number; retryDelayMs?: number; deadlineMs: number; timeoutMessage: string },
): Promise<T> {
  const hedgeAfter = opts.hedgeAfterMs ?? HEDGE_AFTER_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const controllers: AbortController[] = [];

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let running = 0;
    let lastError: unknown;
    let hedgeTimer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void, winner?: AbortController) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadline);
      for (const c of controllers) if (c !== winner) c.abort();
      fn();
    };
    const deadline = setTimeout(() => finish(() => reject(new Error(opts.timeoutMessage))), opts.deadlineMs);

    const launch = () => {
      if (settled || controllers.length >= maxAttempts) return;
      const c = new AbortController();
      controllers.push(c);
      running += 1;
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(launch, hedgeAfter);
      attempt(c.signal).then(
        (v) => finish(() => resolve(v), c),
        (err: unknown) => {
          running -= 1;
          if (settled) return;
          lastError = err;
          if (controllers.length < maxAttempts) {
            // An overloaded service needs a moment; a slow replica doesn't.
            if (isTransient(err)) {
              clearTimeout(hedgeTimer);
              hedgeTimer = setTimeout(launch, opts.retryDelayMs ?? 2000 * controllers.length);
            } else {
              launch();
            }
          } else if (running === 0) {
            finish(() => reject(lastError));
          }
        },
      );
    };
    launch();
  });
}

/**
 * Errors worth retrying: overload, rate limiting, and dropped connections.
 * Anything else (bad key, bad request) fails at once.
 */
export function isTransient(err: unknown): boolean {
  const text = `${(err as { message?: string } | null)?.message ?? err}`;
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(text);
}

/** Retry `fn` on transient errors with backoff (2s, 4s, …). */
export async function retryTransient<T>(fn: () => Promise<T>, opts: { attempts?: number; baseDelayMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, base * 2 ** (i - 1)));
    }
  }
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

/** Upload a video to the Files API and wait for it to become ACTIVE, with deadlines. */
async function uploadAndWait(g: GoogleGenAI, filePath: string, displayName = path.basename(filePath)): Promise<GeminiFile> {
  const name = displayName;
  const { size } = await stat(filePath);
  const uploadMs = uploadTimeoutMs(size);
  let active = await withTimeout(
    retryTransient(() => g.files.upload({ file: filePath, config: { mimeType: "video/mp4" } })),
    uploadMs,
    `Uploading ${name} (${mb(size)}) to Gemini took longer than ${Math.round(uploadMs / 1000)}s`,
  );

  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (active.state !== "ACTIVE") {
    if (active.state === "FAILED") throw new Error(`Gemini Files API failed to process ${name}`);
    if (Date.now() >= deadline) {
      throw new Error(`Gemini took longer than ${PROCESSING_TIMEOUT_MS / 1000}s to process ${name} after upload`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    const fileName = active.name!;
    active = await withTimeout(retryTransient(() => g.files.get({ name: fileName })), 30_000, `Gemini stopped responding while processing ${name}`);
  }
  return active;
}

/**
 * Upload a local video file via the Files API and prompt Gemini for a
 * 2–3 sentence content description. Returns plain text.
 */
export async function describeVideo(filePath: string): Promise<string> {
  const g = ai();

  // Upload a small proxy, never the original (see media/proxy.ts).
  const proxy = await makeProxy(filePath, DESCRIBE_PROXY);
  const active = await uploadAndWait(g, proxy.path, path.basename(filePath));

  const response = await hedged((signal) => g.models.generateContent({
    model: DESCRIBE_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { mimeType: active.mimeType!, fileUri: active.uri! } },
          {
            text:
              "Describe what happens in this video in 2-3 sentences. " +
              "Focus on concrete actions, subjects, and setting — the kind of " +
              "description an editor would use to decide whether to include " +
              "this clip in a narrative. Do not speculate about emotions or " +
              "off-screen context.",
          },
        ],
      },
    ],
    config: { abortSignal: signal },
  }), {
    deadlineMs: GENERATE_TIMEOUT_MS,
    timeoutMessage: `Gemini took longer than ${GENERATE_TIMEOUT_MS / 1000}s to describe ${path.basename(filePath)} (${MAX_ATTEMPTS} parallel attempts)`,
  });

  const text = response.text;
  if (!text || text.trim().length === 0) {
    throw new Error(`Gemini returned an empty description for ${filePath}`);
  }
  return text.trim();
}

/**
 * Describe a specific time window of a video using Gemini's videoMetadata
 * offset feature — the model only analyzes frames inside [startSec, endSec].
 * Use this AFTER find_visual_moment locates a candidate window so the agent
 * can reason about what's actually there.
 */
export async function describeVideoSegment(
  filePath: string,
  startSec: number,
  endSec: number,
): Promise<string> {
  if (endSec <= startSec) {
    throw new Error(`Invalid segment: end (${endSec}) must be greater than start (${startSec})`);
  }
  const g = ai();

  // Only the requested window is cut, downscaled, and uploaded — a few
  // hundred KB instead of the whole source.
  const proxy = await makeProxy(filePath, DESCRIBE_PROXY, { start: startSec, end: endSec });
  const active = await uploadAndWait(g, proxy.path, path.basename(filePath));

  const response = await hedged((signal) => g.models.generateContent({
    model: DESCRIBE_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { mimeType: active.mimeType!, fileUri: active.uri! } },
          {
            text:
              `This clip is the window ${startSec}s–${endSec}s of a longer source video. ` +
              "Describe what happens in it in 2-3 sentences. Focus on concrete actions, " +
              "subjects, and setting — the kind of description an editor would use to " +
              "decide whether to include this exact window in a narrative. If you say " +
              `when something happens, give SOURCE time: the clip's own time plus ${startSec}s.`,
          },
        ],
      },
    ],
    config: { abortSignal: signal },
  }), {
    deadlineMs: GENERATE_TIMEOUT_MS,
    timeoutMessage: `Gemini took longer than ${GENERATE_TIMEOUT_MS / 1000}s to describe ${path.basename(filePath)} (${MAX_ATTEMPTS} parallel attempts)`,
  });

  const text = response.text;
  if (!text || text.trim().length === 0) {
    throw new Error(`Gemini returned an empty description for segment ${startSec}-${endSec}s of ${filePath}`);
  }
  return text.trim();
}

/** Upper bound on beats per source, so a long video can't flood the agent. */
export const MAX_VISUAL_BEATS = 60;

/**
 * A dense, time-coded map of what is VISIBLE across a whole source: one beat
 * per meaningful change of picture (a new page, a new UI state, an action),
 * with the on-screen text that identifies it (names, prices, plate numbers).
 * The substrate for story edits: it lets the agent pick the excerpt of a
 * screen recording or B-roll that shows what the dialogue is saying at that
 * moment, without a describe_segment round trip per guess.
 *
 * Reads the 720p master proxy (not the 480p description copy) at high media
 * resolution — screen recordings are only useful if their text is legible.
 */
export async function mapVisualBeats(filePath: string, durationSec: number): Promise<VisualBeat[]> {
  const g = ai();
  const proxy = await makeProxy(filePath, INDEX_PROXY);
  const active = await uploadAndWait(g, proxy.path, path.basename(filePath));
  const prompt =
    `This video is ${durationSec.toFixed(1)} seconds long. Break the WHOLE video into consecutive beats ` +
    "that together cover it from 0 to the end. Start a new beat whenever what is on screen meaningfully " +
    "changes: a different app, page, screen or camera angle, a new UI state, a dialog or notification, a " +
    "new action. Beats are usually 2 to 15 seconds; never more than " + MAX_VISUAL_BEATS + " beats. For each beat " +
    "give start and end in SECONDS (numbers, not MM:SS) and a one-sentence description of exactly what is " +
    "visible — name the app or page and quote the key on-screen text (names, prices, plate numbers, " +
    "headings, button labels). Describe only what is visible; do not guess intent.";

  const response = await hedged((signal) => g.models.generateContent({
    model: DESCRIBE_MODEL,
    contents: [{ role: "user", parts: [
      { fileData: { mimeType: active.mimeType!, fileUri: active.uri! } },
      { text: prompt },
    ] }],
    config: {
      abortSignal: signal,
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          beats: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "number" },
                end: { type: "number" },
                description: { type: "string" },
              },
              required: ["start", "end", "description"],
            },
          },
        },
        required: ["beats"],
      },
    },
  }), {
    deadlineMs: GENERATE_TIMEOUT_MS,
    timeoutMessage: `Gemini took longer than ${GENERATE_TIMEOUT_MS / 1000}s to map ${path.basename(filePath)} (${MAX_ATTEMPTS} parallel attempts)`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text ?? "");
  } catch {
    throw new Error(`Gemini returned an unreadable beat map for ${path.basename(filePath)}`);
  }
  return normalizeBeats((parsed as { beats?: unknown })?.beats, durationSec);
}

/**
 * Clean a model's beat list: drop malformed entries, clamp to the source,
 * sort, cut overlaps at the later beat's start, and cap the count.
 */
export function normalizeBeats(raw: unknown, durationSec: number): VisualBeat[] {
  if (!Array.isArray(raw)) return [];
  const beats = raw
    .filter((b): b is VisualBeat =>
      typeof b === "object" && b !== null &&
      typeof (b as VisualBeat).start === "number" && typeof (b as VisualBeat).end === "number" &&
      typeof (b as VisualBeat).description === "string" && (b as VisualBeat).description.trim().length > 0)
    .map((b) => ({
      start: Math.max(0, Math.min(durationSec, b.start)),
      end: Math.max(0, Math.min(durationSec, b.end)),
      description: b.description.trim(),
    }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < beats.length - 1; i++) {
    if (beats[i]!.end > beats[i + 1]!.start) beats[i]!.end = beats[i + 1]!.start;
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return beats
    .filter((b) => b.end > b.start)
    .slice(0, MAX_VISUAL_BEATS)
    .map((b) => ({ start: r3(b.start), end: r3(b.end), description: b.description }));
}

// ── Watching a cut ────────────────────────────────────────────────────────────

export interface CutNote {
  /** Where in the cut (seconds). */
  time: number;
  severity: "major" | "minor";
  issue: string;
}

export interface CutReview {
  verdict: "approve" | "revise";
  notes: CutNote[];
}

/**
 * Watch a rendered cut, as an editor reviewing a rough cut would, and return
 * timestamped notes. `brief` carries the request and the intended shot list;
 * judgment is the model's — no criteria are scored here.
 */
export async function reviewCut(filePath: string, brief: string): Promise<CutReview> {
  const g = ai();
  const active = await uploadAndWait(g, filePath, "draft cut");
  const response = await hedged((signal) => g.models.generateContent({
    model: DESCRIBE_MODEL,
    contents: [{ role: "user", parts: [
      { fileData: { mimeType: active.mimeType!, fileUri: active.uri! } },
      { text: brief },
    ] }],
    config: {
      abortSignal: signal,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approve", "revise"] },
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                time: { type: "number" },
                severity: { type: "string", enum: ["major", "minor"] },
                issue: { type: "string" },
              },
              required: ["time", "severity", "issue"],
            },
          },
        },
        required: ["verdict", "notes"],
      },
    },
  }), {
    deadlineMs: GENERATE_TIMEOUT_MS,
    timeoutMessage: `Gemini took longer than ${GENERATE_TIMEOUT_MS / 1000}s to review the draft (${MAX_ATTEMPTS} parallel attempts)`,
  });
  return parseCutReview(response.text ?? "");
}

/** Parse and sanity-check a review; anything malformed degrades to no notes. */
export function parseCutReview(text: string): CutReview {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { verdict: "approve", notes: [] }; }
  const r = raw as { verdict?: unknown; notes?: unknown };
  const notes: CutNote[] = Array.isArray(r.notes)
    ? r.notes
        .filter((n): n is CutNote =>
          typeof n === "object" && n !== null &&
          typeof (n as CutNote).time === "number" && typeof (n as CutNote).issue === "string" &&
          ((n as CutNote).severity === "major" || (n as CutNote).severity === "minor"))
        .map((n) => ({ time: Math.max(0, n.time), severity: n.severity, issue: n.issue.trim() }))
        .sort((a, b) => a.time - b.time)
    : [];
  const verdict = r.verdict === "revise" && notes.some((n) => n.severity === "major") ? "revise" : "approve";
  return { verdict, notes };
}

export const realBackend = { describeVideo, describeVideoSegment };
export type GeminiBackend = typeof realBackend;

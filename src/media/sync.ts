import { spawn } from "node:child_process";

/**
 * Audio sync: are these sources recordings of the same moment, and how far
 * apart in time?
 *
 * Several cameras/screens recording one live event (a phone call filmed from
 * the couch and from the son's desk, plus a screen recording of the computer
 * agent) all pick up the event's sound. Correlating their loudness envelopes
 * finds the lag at which they line up — the basis of a multicam edit, where
 * any angle can be shown at "the same moment" without guessing from content.
 *
 * Measured on the product-video footage (±60 s search, 10 ms frames):
 * son = call + 1.93 s (r 0.66), screen = son + 1.14 s (r 0.57), and the
 * direct call→screen estimate, + 3.07 s, agrees with the chain to 0.01 s.
 *
 * Nothing here is a threshold on the edit: confidence is reported as evidence
 * (peak, margin over the next-best lag, transcript agreement, consistency
 * through a third source) for the agent and the user to weigh.
 */

export const ENVELOPE_RATE = 100;          // frames per second (10 ms)
const SAMPLE_RATE = 8000;
const HOP = SAMPLE_RATE / ENVELOPE_RATE;

export interface SyncPair {
  /** b time = a time + offset (seconds). */
  offset: number;
  /** Pearson correlation of the envelopes at that lag (−1..1). */
  r: number;
  /** r minus the best correlation at a lag ≥ 0.5 s away. */
  margin: number;
}

/** Log-energy envelope of a mono 16-bit PCM buffer, one value per 10 ms. */
export function envelopeFromPcm(samples: Int16Array): Float64Array {
  const n = Math.floor(samples.length / HOP);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < HOP; j++) {
      const v = samples[i * HOP + j]! / 32768;
      acc += v * v;
    }
    e[i] = Math.log10(acc / HOP + 1e-9);
  }
  return e;
}

/** Decode a file's first audio track to mono 8 kHz PCM and return its envelope. */
export function audioEnvelope(filePath: string): Promise<Float64Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-i", filePath,
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Could not read audio from ${filePath}: ${stderr.trim().split("\n").pop() ?? code}`));
      const buf = Buffer.concat(chunks);
      resolve(envelopeFromPcm(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))));
    });
  });
}

/** Pearson correlation of a[t+L] and b[t] over their overlap; null if the overlap is short. */
function correlationAt(a: Float64Array, b: Float64Array, L: number, minOverlap: number): number | null {
  const t0 = Math.max(0, -L);
  const t1 = Math.min(b.length, a.length - L);
  const n = t1 - t0;
  if (n < minOverlap) return null;
  let sa = 0, sb = 0;
  for (let t = t0; t < t1; t++) { sa += a[t + L]!; sb += b[t]!; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let t = t0; t < t1; t++) {
    const x = a[t + L]! - ma;
    const y = b[t]! - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/**
 * The lag at which b best lines up with a, as `b time = a time + offset`.
 * Each lag's correlation is computed over the overlap only, so a lag that
 * slides one recording mostly past the other can't win on a tiny overlap.
 */
export function alignEnvelopes(
  a: Float64Array,
  b: Float64Array,
  opts: { maxLagSeconds?: number; minOverlapSeconds?: number } = {},
): SyncPair | null {
  const maxLag = Math.round((opts.maxLagSeconds ?? 60) * ENVELOPE_RATE);
  const minOverlap = Math.round((opts.minOverlapSeconds ?? 30) * ENVELOPE_RATE);
  const scores: Array<{ L: number; r: number }> = [];
  for (let L = -maxLag; L <= maxLag; L++) {
    const r = correlationAt(a, b, L, minOverlap);
    if (r !== null) scores.push({ L, r });
  }
  if (scores.length === 0) return null;
  let best = scores[0]!;
  for (const s of scores) if (s.r > best.r) best = s;
  const away = Math.round(0.5 * ENVELOPE_RATE);
  let runnerUp = -1;
  for (const s of scores) if (Math.abs(s.L - best.L) >= away && s.r > runnerUp) runnerUp = s.r;
  return { offset: -best.L / ENVELOPE_RATE, r: best.r, margin: best.r - Math.max(runnerUp, 0) };
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export interface SyncInput {
  id: string;
  fileName: string;
  envelope: Float64Array | null;            // null = no audio
  transcript?: Array<{ start: number; text: string }>;
}

export interface SyncedSource {
  /** source time = reference time + offset. */
  offset: number;
  r: number;
  margin: number;
  /** Transcript lines that agree with the offset (same words, consistent timing). */
  transcriptAgreement: number;
  /** Plain-language evidence for the agent and the user. */
  evidence: string;
}

export interface SyncGroup {
  referenceSourceId: string;
  offsets: Record<string, SyncedSource>;    // includes the reference (offset 0)
  /** Sources with audio that did not line up with the group. */
  unsynced: Array<{ id: string; reason: string }>;
  measuredAt: string;
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);

/**
 * Lines of `b` that say what a line of `a` says at a time consistent with the
 * offset (within 1.5 s), counted. Independent of the audio envelopes, so it is
 * real corroboration when two microphones transcribed the same conversation.
 */
export function transcriptAgreement(
  a: Array<{ start: number; text: string }>,
  b: Array<{ start: number; text: string }>,
  offset: number,
): number {
  let agree = 0;
  for (const la of a) {
    const wa = new Set(words(la.text));
    if (wa.size < 3) continue;
    const hit = b.some((lb) => {
      if (Math.abs(lb.start - (la.start + offset)) > 1.5) return false;
      const wb = words(lb.text);
      const shared = wb.filter((w) => wa.has(w)).length;
      return shared >= Math.min(3, wa.size) || shared / wa.size >= 0.6;
    });
    if (hit) agree++;
  }
  return agree;
}

/**
 * Measure every audio source against the reference (the source carrying the
 * conversation) and, where a third source exists, check each offset against
 * the chain through it. A source joins the group only on positive evidence:
 * a clear correlation peak, or agreement through another synced source.
 * Weak, unconfirmed alignment is reported as unsynced rather than guessed.
 */
export function groupSources(
  reference: SyncInput,
  others: SyncInput[],
  opts: { maxLagSeconds?: number } = {},
): SyncGroup {
  const offsets: Record<string, SyncedSource> = {
    [reference.id]: { offset: 0, r: 1, margin: 1, transcriptAgreement: 0, evidence: "reference" },
  };
  const unsynced: SyncGroup["unsynced"] = [];
  if (!reference.envelope) {
    return { referenceSourceId: reference.id, offsets, unsynced: others.map((o) => ({ id: o.id, reason: "the reference has no audio" })), measuredAt: new Date().toISOString() };
  }

  const direct = new Map<string, SyncPair>();
  for (const o of others) {
    if (!o.envelope) { unsynced.push({ id: o.id, reason: "no audio track" }); continue; }
    const p = alignEnvelopes(reference.envelope, o.envelope, opts);
    if (p) direct.set(o.id, p);
    else unsynced.push({ id: o.id, reason: "recordings don't overlap enough to compare" });
  }

  const audible = others.filter((o) => direct.has(o.id));
  for (const o of audible) {
    const p = direct.get(o.id)!;
    // Corroboration through each other source: ref→x→o should equal ref→o.
    const chains: string[] = [];
    let chainAgrees = 0;
    for (const x of audible) {
      if (x.id === o.id) continue;
      const px = direct.get(x.id)!;
      const xo = alignEnvelopes(x.envelope!, o.envelope!, opts);
      if (!xo) continue;
      const via = px.offset + xo.offset;
      const delta = Math.abs(via - p.offset);
      if (delta <= 0.1 && xo.margin > 0.1) {
        chainAgrees++;
        chains.push(`via ${x.fileName}: ${px.offset.toFixed(2)} + ${xo.offset.toFixed(2)} = ${via.toFixed(2)} s (r ${xo.r.toFixed(2)})`);
      }
    }
    const agreement = reference.transcript && o.transcript ? transcriptAgreement(reference.transcript, o.transcript, p.offset) : 0;
    const strongPeak = p.r >= 0.3 && p.margin >= 0.15;
    if (strongPeak || chainAgrees > 0 || agreement >= 2) {
      const parts = [`audio peak r ${p.r.toFixed(2)} (margin ${p.margin.toFixed(2)} over the next-best lag)`];
      if (chains.length > 0) parts.push(`confirmed ${chains.join("; ")}`);
      if (agreement > 0) parts.push(`${agreement} transcript line${agreement === 1 ? "" : "s"} agree`);
      offsets[o.id] = { offset: Math.round(p.offset * 100) / 100, r: p.r, margin: p.margin, transcriptAgreement: agreement, evidence: parts.join("; ") };
    } else {
      unsynced.push({ id: o.id, reason: `no clear alignment (best r ${p.r.toFixed(2)}, margin ${p.margin.toFixed(2)}, no confirmation)` });
    }
  }
  return { referenceSourceId: reference.id, offsets, unsynced, measuredAt: new Date().toISOString() };
}

import type { ChatProvider, ContentBlock, NeutralMessage } from "../agent/providers/types.js";

/**
 * History compaction (3E-8): the conversation-length context wall.
 *
 * The design rests on one architectural fact: since 3E-5 the system prompt
 * carries a FRESH timeline snapshot every turn, so history is never the
 * agent's source of truth about the timeline — it exists for INTENT
 * continuity (what was asked, decided, rejected). Old perception payloads in
 * history are therefore redundant at best and actively misleading at worst
 * (a scout contribution describing clip 3 pre-trim contradicts the current
 * snapshot). Compaction is aggressive on tool results, conservative on user
 * intent — that asymmetry is the whole design.
 *
 * Tiers, most-redundant-first (decision 8):
 *   (a) elide tool results outside the recent window → one-line markers,
 *       tool_use/tool_result pairing kept structurally intact;
 *   (b) drop reasoning blocks from older turns;
 *   (c) summarize the oldest exchanges into a terse digest, via the
 *       ChatProvider seam (decision 12), with a mechanical fallback so a
 *       provider failure never blocks;
 *   and always: the most recent KEEP_RECENT_TURNS turns stay verbatim.
 *
 * This module also owns THE context estimator (decision 11): the auto-compact
 * trigger uses it, /compact reports through it, and the 3J context gauge —
 * not yet built — must consume it rather than growing a second one.
 */

// ── Constants (named, tunable) ────────────────────────────────────────────────

/** Assumed model context window for the estimate. */
export const CONTEXT_WINDOW_TOKENS = 200_000;
/** Auto-compact when estimated HISTORY tokens cross this fraction of the window. */
export const AUTO_COMPACT_FRACTION = 0.4;
export const AUTO_COMPACT_THRESHOLD_TOKENS = Math.floor(CONTEXT_WINDOW_TOKENS * AUTO_COMPACT_FRACTION);
/** Compaction aims below this after running (half the trigger). */
export const COMPACT_TARGET_TOKENS = Math.floor(AUTO_COMPACT_THRESHOLD_TOKENS / 2);
/** The most recent turns are never touched by any tier (decision 9). */
export const KEEP_RECENT_TURNS = 3;

/** Pairing-preserving stand-in for an elided tool result (decision 8a). */
export const ELIDED_TOOL_RESULT =
  "[elided: stale perception result — the system snapshot carries current timeline state]";

// ── The one estimator ─────────────────────────────────────────────────────────

/**
 * Estimated token footprint of a neutral history. Heuristic (~4 chars/token
 * over the serialized content plus per-message overhead) — the same number
 * the auto-compact trigger, /compact, and the future 3J gauge all read.
 */
export function estimateHistoryTokens(messages: NeutralMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += 16; // role + envelope overhead
    for (const b of m.content) chars += JSON.stringify(b)?.length ?? 0;
  }
  return Math.ceil(chars / 4);
}

export function shouldAutoCompact(messages: NeutralMessage[]): boolean {
  return estimateHistoryTokens(messages) > AUTO_COMPACT_THRESHOLD_TOKENS;
}

// ── Turn segmentation ─────────────────────────────────────────────────────────
//
// A "turn" starts at a GENUINE user message (user text, not a tool_result
// envelope) and runs to just before the next one. Cutting only at turn
// boundaries is what keeps tool_use↔tool_result pairs together.

function isGenuineUserMessage(m: NeutralMessage): boolean {
  return m.role === "user" && !m.content.some((b) => b.type === "tool_result");
}

export function splitTurns(messages: NeutralMessage[]): NeutralMessage[][] {
  const turns: NeutralMessage[][] = [];
  let current: NeutralMessage[] = [];
  for (const m of messages) {
    if (isGenuineUserMessage(m) && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function joinTurns(turns: NeutralMessage[][]): NeutralMessage[] {
  return turns.flat();
}

// ── Tier (a): tool-result eviction ────────────────────────────────────────────

function elideToolResultsInMessage(m: NeutralMessage): NeutralMessage {
  if (!m.content.some((b) => b.type === "tool_result")) return m;
  return {
    ...m,
    content: m.content.map((b) =>
      b.type === "tool_result" ? { ...b, content: ELIDED_TOOL_RESULT } : b,
    ),
  };
}

/** Elide tool results in every turn except the most recent `keepRecentTurns`. */
export function evictToolResults(messages: NeutralMessage[], keepRecentTurns: number): NeutralMessage[] {
  const turns = splitTurns(messages);
  const cutoff = Math.max(0, turns.length - keepRecentTurns);
  return joinTurns(
    turns.map((turn, i) => (i < cutoff ? turn.map(elideToolResultsInMessage) : turn)),
  );
}

/** Elide EVERY tool result — used on resume, where all history is old (decision 7). */
export function evictAllToolResults(messages: NeutralMessage[]): NeutralMessage[] {
  return messages.map(elideToolResultsInMessage);
}

// ── Tier (b): reasoning-block removal ─────────────────────────────────────────

/** Drop reasoning blocks everywhere; drop messages left empty by it. */
export function stripReasoningBlocks(messages: NeutralMessage[]): NeutralMessage[] {
  return messages
    .map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "reasoning") }))
    .filter((m) => m.content.length > 0);
}

function dropReasoningFromOldTurns(messages: NeutralMessage[], keepRecentTurns: number): NeutralMessage[] {
  const turns = splitTurns(messages);
  const cutoff = Math.max(0, turns.length - keepRecentTurns);
  return joinTurns(
    turns.map((turn, i) => (i < cutoff ? stripReasoningBlocks(turn) : turn)),
  );
}

// ── Tier (c): summarization through the seam ──────────────────────────────────

const SUMMARY_MAX_TOKENS = 1000;

function textOf(m: NeutralMessage): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Mechanical fallback digest: the user's own words, verbatim — never blocks. */
function mechanicalDigest(oldTurns: NeutralMessage[][]): string {
  const requests = oldTurns
    .map((turn) => textOf(turn[0]!))
    .filter((t) => t.trim().length > 0)
    .map((t) => `- ${t}`);
  return `Earlier requests this session:\n${requests.join("\n")}`;
}

async function summarizeTurns(
  oldTurns: NeutralMessage[][],
  getProvider: (() => ChatProvider) | undefined,
): Promise<string> {
  if (!getProvider) return mechanicalDigest(oldTurns);
  try {
    const provider = getProvider();
    const transcript = oldTurns
      .map((turn) =>
        turn
          .filter((m) => textOf(m).trim().length > 0)
          .map((m) => `${m.role}: ${textOf(m)}`)
          .join("\n"),
      )
      .join("\n---\n");
    const response = await provider.send({
      system:
        "Summarize this video-editing session transcript into a terse factual digest for the editing agent's memory: " +
        "what the user requested, what was decided, what was applied or rejected and why. " +
        "Short bullet lines. No prose, no commentary, no markdown emphasis.",
      messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
      tools: [],
      maxTokens: SUMMARY_MAX_TOKENS,
      reasoning: { enabled: false },
      // History maintenance is the director's own bookkeeping for /cost purposes.
      role: "director",
    });
    const text = response.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : mechanicalDigest(oldTurns);
  } catch {
    return mechanicalDigest(oldTurns);
  }
}

// ── Structural validity (decision 9 — non-negotiable) ─────────────────────────

/**
 * Every tool_use must be answered by matching tool_result blocks in the
 * immediately following user message, and tool_results must only answer the
 * immediately preceding assistant message. A dangling pair is an API error.
 */
export function validateHistoryStructure(messages: NeutralMessage[]):
  | { ok: true }
  | { ok: false; error: string } {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const toolUses = m.content.filter((b) => b.type === "tool_use");
    if (m.role === "assistant" && toolUses.length > 0) {
      const next = messages[i + 1];
      if (!next || next.role !== "user") {
        return { ok: false, error: `assistant tool_use at index ${i} has no following user message` };
      }
      const resultIds = new Set(
        next.content.filter((b) => b.type === "tool_result").map((b) => (b as { toolUseId: string }).toolUseId),
      );
      for (const tu of toolUses) {
        if (!resultIds.has((tu as { id: string }).id)) {
          return { ok: false, error: `tool_use ${(tu as { id: string }).id} at index ${i} has no matching tool_result` };
        }
      }
    }
    if (m.role === "user" && m.content.some((b) => b.type === "tool_result")) {
      const prev = messages[i - 1];
      if (!prev || prev.role !== "assistant" || !prev.content.some((b) => b.type === "tool_use")) {
        return { ok: false, error: `tool_result at index ${i} does not follow an assistant tool_use` };
      }
    }
  }
  return { ok: true };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface CompactDeps {
  /** Lazily built — only tier (c) needs a provider, and its failure falls
   *  back to the mechanical digest. */
  getProvider?: () => ChatProvider;
  /** Compact until at or below this estimate. Default COMPACT_TARGET_TOKENS. */
  targetTokens?: number;
  keepRecentTurns?: number;
}

export interface CompactResult {
  messages: NeutralMessage[];
  tiersApplied: Array<"tool-results" | "reasoning" | "summarize">;
  beforeTokens: number;
  afterTokens: number;
  compactedTurns: number;
}

/**
 * Tiered compaction. Applies tiers in order until the estimate is at or
 * below target; the most recent turns are never touched by any tier. If the
 * result would be structurally invalid (it cannot be, by construction — this
 * is a belt-and-braces check), the original history is returned untouched.
 */
export async function compactHistory(
  messages: NeutralMessage[],
  deps: CompactDeps = {},
): Promise<CompactResult> {
  const target = deps.targetTokens ?? COMPACT_TARGET_TOKENS;
  const keep = deps.keepRecentTurns ?? KEEP_RECENT_TURNS;
  const beforeTokens = estimateHistoryTokens(messages);
  const totalTurns = splitTurns(messages).length;
  const tiersApplied: CompactResult["tiersApplied"] = [];

  let out = messages;

  // (a) stale perception goes first — a correctness improvement, not just size.
  out = evictToolResults(out, keep);
  tiersApplied.push("tool-results");

  // (b) old reasoning next.
  if (estimateHistoryTokens(out) > target) {
    out = dropReasoningFromOldTurns(out, keep);
    tiersApplied.push("reasoning");
  }

  // (c) summarize the oldest exchanges last — user intent is the final thing
  // to give up verbatim (decision 10).
  if (estimateHistoryTokens(out) > target) {
    const turns = splitTurns(out);
    const cutoff = Math.max(0, turns.length - keep);
    if (cutoff > 0) {
      const oldTurns = turns.slice(0, cutoff);
      const digest = await summarizeTurns(oldTurns, deps.getProvider);
      const digestMessage: NeutralMessage = {
        role: "user",
        content: [{
          type: "text",
          text: `[compacted digest of ${cutoff} earlier turn${cutoff === 1 ? "" : "s"}]\n${digest}`,
        }],
      };
      out = [digestMessage, ...joinTurns(turns.slice(cutoff))];
      tiersApplied.push("summarize");
    }
  }

  // Structural validity is non-negotiable: on any violation, refuse to compact.
  if (!validateHistoryStructure(out).ok) {
    return { messages, tiersApplied: [], beforeTokens, afterTokens: beforeTokens, compactedTurns: 0 };
  }

  return {
    messages: out,
    tiersApplied,
    beforeTokens,
    afterTokens: estimateHistoryTokens(out),
    compactedTurns: Math.max(0, totalTurns - keep),
  };
}

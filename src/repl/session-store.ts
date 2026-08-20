import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import type { ContentBlock, NeutralMessage } from "../agent/providers/types.js";
import { evictAllToolResults, stripReasoningBlocks } from "./compaction.js";

/**
 * Conversation persistence (3E-8). The conversation lives in a SIDECAR file,
 * not `.cutcli.json`: project state is small, structured, and precious;
 * conversation is large, churns every turn, and is convenience data. A crash
 * mid-save must never be able to corrupt the project file (decision 1) — and
 * the sidecar itself is written atomically (temp + rename, decision 2) so an
 * interrupted save leaves the previous file intact.
 *
 * The persisted shape is NEUTRAL (3E-2.4): no vendor types on disk, which is
 * what lets the format survive a provider change. But reasoning blocks are
 * model-bound — an Anthropic thinking payload cannot replay to another
 * provider or model — so the file records which provider/model produced it,
 * and a mismatched load strips reasoning while keeping text and tool
 * exchanges (decision 5).
 *
 * Load-time hygiene (decision 7): tool results in a resumed history describe
 * footage as it WAS. The agent's system snapshot is current by construction,
 * so every loaded tool result is elided to a marker — stale perception must
 * not contradict the fresh snapshot.
 */

export const SESSION_FILE_VERSION = 1;

export interface ProviderInfo {
  provider: string;
  model: string;
}

interface PersistedSession {
  version: number;
  provider: string;
  model: string;
  savedAt: string;
  messages: NeutralMessage[];
}

/** The canonical sidecar location: `.cutcli-session.json` beside the project file. */
export function sessionFilePath(): string {
  return path.join(process.cwd(), ".cutcli-session.json");
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Persist the conversation. Atomic: serialize first (a failure here touches
 * nothing), write to a temp file, then rename over the target.
 */
export async function saveSession(
  messages: NeutralMessage[],
  info: ProviderInfo,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const payload: PersistedSession = {
      version: SESSION_FILE_VERSION,
      provider: info.provider,
      model: info.model,
      savedAt: new Date().toISOString(),
      messages,
    };
    const json = JSON.stringify(payload);
    const target = sessionFilePath();
    const tmp = `${target}.tmp`;
    await writeFile(tmp, json, "utf-8");
    await rename(tmp, target);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

export type LoadResult =
  | {
      ok: true;
      messages: NeutralMessage[];
      savedAt: string;
      /** True when reasoning blocks were dropped due to a provider/model change. */
      strippedReasoning: boolean;
    }
  | { ok: false; reason: "missing" | "corrupt"; error?: string };

/**
 * Load and sanitize the persisted conversation. Never throws: a corrupt or
 * unreadable file reports `corrupt` so the caller can start fresh with a
 * clear message (decision 6) — conversation is convenience, never a blocker.
 */
export async function loadSession(current: ProviderInfo): Promise<LoadResult> {
  const target = sessionFilePath();
  if (!existsSync(target)) return { ok: false, reason: "missing" };

  let parsed: PersistedSession;
  try {
    parsed = JSON.parse(await readFile(target, "utf-8")) as PersistedSession;
  } catch (err: unknown) {
    return { ok: false, reason: "corrupt", error: (err as Error).message };
  }

  if (
    typeof parsed !== "object" || parsed === null ||
    parsed.version !== SESSION_FILE_VERSION ||
    !Array.isArray(parsed.messages) ||
    !parsed.messages.every(isPlausibleMessage)
  ) {
    return { ok: false, reason: "corrupt", error: "unrecognized session file shape" };
  }

  let messages = parsed.messages;
  const mismatch = parsed.provider !== current.provider || parsed.model !== current.model;
  if (mismatch) {
    // Reasoning payloads are opaque, provider-owned continuation state; they
    // are only valid replayed to the exact provider/model that minted them.
    messages = stripReasoningBlocks(messages);
  }

  // Decision 7: everything in a resumed history is "old" — elide every tool
  // result (pairing-preserving markers) so stale perception never resurfaces.
  messages = evictAllToolResults(messages);

  return {
    ok: true,
    messages,
    savedAt: parsed.savedAt ?? "(unknown)",
    strippedReasoning: mismatch,
  };
}

/** Cheap existence/size peek for the startup notice — no sanitizing. */
export async function peekSession(): Promise<{ exists: boolean; messageCount: number; savedAt?: string }> {
  const target = sessionFilePath();
  if (!existsSync(target)) return { exists: false, messageCount: 0 };
  try {
    const parsed = JSON.parse(await readFile(target, "utf-8")) as PersistedSession;
    if (!Array.isArray(parsed.messages)) return { exists: false, messageCount: 0 };
    return { exists: true, messageCount: parsed.messages.length, savedAt: parsed.savedAt };
  } catch {
    return { exists: false, messageCount: 0 };
  }
}

function isPlausibleMessage(m: unknown): m is NeutralMessage {
  if (typeof m !== "object" || m === null) return false;
  const msg = m as { role?: unknown; content?: unknown };
  return (
    (msg.role === "user" || msg.role === "assistant") &&
    Array.isArray(msg.content) &&
    (msg.content as ContentBlock[]).every((b) => typeof b === "object" && b !== null && "type" in b)
  );
}

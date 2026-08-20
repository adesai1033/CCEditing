import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveSession, loadSession, peekSession, sessionFilePath } from "../repl/session-store.js";
import {
  compactHistory, evictToolResults, evictAllToolResults, stripReasoningBlocks,
  splitTurns, validateHistoryStructure, estimateHistoryTokens, shouldAutoCompact,
  AUTO_COMPACT_THRESHOLD_TOKENS, KEEP_RECENT_TURNS, ELIDED_TOOL_RESULT,
} from "../repl/compaction.js";
import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { runAgent } from "../agent/loop.js";
import type { ChatProvider, ChatResponse, NeutralMessage } from "../agent/providers/types.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import { createSession } from "../project/session.js";
import type { MediaInfo } from "../media/types.js";

// ── Setup: isolate CWD (the store is CWD-keyed, like the project file) ────────

let testDir: string;
const originalCwd = process.cwd();

before(() => {
  testDir = mkdtempSync(join(tmpdir(), "cutcli-session-test-"));
  process.chdir(testDir);
});

after(() => {
  process.chdir(originalCwd);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  try { rmSync(sessionFilePath(), { force: true }); } catch {}
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INFO = { provider: "anthropic", model: "claude-sonnet-4-6" };
const OTHER_MODEL = { provider: "anthropic", model: "claude-other" };

function userMsg(text: string): NeutralMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** One complete turn: user ask → assistant reasoning+tool_use → tool_result →
 *  assistant text. The tool result is sized like real perception payloads
 *  (kilobytes), which is exactly why tier (a) shrinks history. */
function fullTurn(i: number, resultPayload = `{"turn":${i},"segments":"${"x".repeat(1200)}"}`): NeutralMessage[] {
  return [
    userMsg(`request ${i}: tighten the video`),
    {
      role: "assistant",
      content: [
        { type: "reasoning", provider: "anthropic", opaque: { type: "thinking", thinking: `plan turn ${i}`, signature: `sig${i}` }, text: `plan turn ${i}` },
        { type: "tool_use", id: `tu_${i}`, name: "query_timeline", input: { turn: i } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: `tu_${i}`, content: resultPayload }] },
    { role: "assistant", content: [{ type: "text", text: `done with turn ${i}` }] },
  ];
}

function history(turns: number): NeutralMessage[] {
  return Array.from({ length: turns }, (_, i) => fullTurn(i)).flat();
}

function makeMediaInfo(): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 120,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1, bitrate: 1, containerFormat: "mp4",
  };
}

function makeReplState(messages: NeutralMessage[] = []): ReplState {
  const r = addSource(createProject("t"), makeMediaInfo());
  assert.ok(r.ok);
  return { session: createSession(r.state), messages, autoApprove: false };
}

// ── Session store ─────────────────────────────────────────────────────────────

describe("session store — round trip", () => {
  test("save → load preserves neutral history, reasoning opaque payloads intact", async () => {
    const messages = history(2);
    const saved = await saveSession(messages, INFO);
    assert.ok(saved.ok);

    const loaded = await loadSession(INFO);
    assert.ok(loaded.ok);
    assert.equal(loaded.strippedReasoning, false);
    // Reasoning survives a same-model resume, opaque intact (the 3E-2.4
    // guarantee holding across disk)…
    const reasoning = loaded.messages.flatMap((m) => m.content).filter((b) => b.type === "reasoning");
    assert.equal(reasoning.length, 2);
    assert.deepEqual((reasoning[0] as { opaque: { signature: string } }).opaque.signature, "sig0");
    // …while tool results are elided on load (decision 7) — pairing intact.
    const results = loaded.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    assert.equal(results.length, 2);
    for (const r of results) assert.equal((r as { content: unknown }).content, ELIDED_TOOL_RESULT);
    assert.ok(validateHistoryStructure(loaded.messages).ok);
    // Text and structure otherwise identical.
    assert.equal(loaded.messages.length, messages.length);
  });

  test("provider/model mismatch strips reasoning, keeps text and tool exchanges", async () => {
    await saveSession(history(2), INFO);
    const loaded = await loadSession(OTHER_MODEL);
    assert.ok(loaded.ok);
    assert.equal(loaded.strippedReasoning, true);
    const blocks = loaded.messages.flatMap((m) => m.content);
    assert.equal(blocks.filter((b) => b.type === "reasoning").length, 0, "no model-bound blocks survive");
    assert.ok(blocks.some((b) => b.type === "tool_use"), "tool exchanges preserved");
    assert.ok(blocks.some((b) => b.type === "text"), "text preserved");
    assert.ok(validateHistoryStructure(loaded.messages).ok);
  });

  test("a mismatched load sends no reasoning blocks into the next request", async () => {
    await saveSession(history(2), INFO);
    const loaded = await loadSession(OTHER_MODEL);
    assert.ok(loaded.ok);

    const requests: NeutralMessage[][] = [];
    const endTurn: ChatResponse = { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    const provider: ChatProvider = {
      send: async (req) => { requests.push(req.messages); return endTurn; },
      stream: (req) => {
        requests.push(req.messages);
        return { async *[Symbol.asyncIterator]() {}, finalResponse: async () => endTurn };
      },
    };
    const state = makeReplState();
    await runAgent({
      userPrompt: "follow-up", session: state.session!, messages: loaded.messages,
      autoApprove: false, confirm: async () => ({ approved: true }), provider,
    });
    const sent = requests[0]!.flatMap((m) => m.content);
    assert.equal(sent.filter((b) => b.type === "reasoning").length, 0);
  });

  test("corrupt file → clean corrupt report, never a throw", async () => {
    writeFileSync(sessionFilePath(), "{not json", "utf-8");
    const loaded = await loadSession(INFO);
    assert.ok(!loaded.ok && loaded.reason === "corrupt");

    writeFileSync(sessionFilePath(), JSON.stringify({ version: 99, messages: "nope" }), "utf-8");
    const wrongShape = await loadSession(INFO);
    assert.ok(!wrongShape.ok && wrongShape.reason === "corrupt");
  });

  test("interrupted save leaves the previous file intact (atomic write)", async () => {
    await saveSession(history(1), INFO);
    const before = readFileSync(sessionFilePath(), "utf-8");

    // A serialization failure aborts before any file is touched.
    const circular: { role: "user"; content: never[] } & { self?: unknown } = { role: "user", content: [] };
    circular.self = circular;
    const failed = await saveSession([circular as unknown as NeutralMessage], INFO);
    assert.ok(!failed.ok);
    assert.equal(readFileSync(sessionFilePath(), "utf-8"), before, "previous file untouched");
    assert.ok(!existsSync(sessionFilePath() + ".tmp"), "no temp debris");
  });

  test("missing file reports missing; peek is honest", async () => {
    assert.deepEqual(await loadSession(INFO), { ok: false, reason: "missing" });
    assert.equal((await peekSession()).exists, false);
    await saveSession(history(1), INFO);
    const peek = await peekSession();
    assert.ok(peek.exists && peek.messageCount === 4);
  });
});

// ── Compaction ────────────────────────────────────────────────────────────────

describe("compaction — structural validity (the critical one)", () => {
  test("every tier preserves tool_use↔tool_result pairing and turn shape", async () => {
    const messages = history(8);
    assert.ok(validateHistoryStructure(messages).ok, "fixture valid");

    const tierA = evictToolResults(messages, KEEP_RECENT_TURNS);
    assert.ok(validateHistoryStructure(tierA).ok, "tier a valid");

    const tierB = stripReasoningBlocks(tierA);
    assert.ok(validateHistoryStructure(tierB).ok, "tier b valid");

    const full = await compactHistory(messages, { targetTokens: 1 });   // forces all tiers
    assert.ok(validateHistoryStructure(full.messages).ok, "post-summarize valid");
    assert.deepEqual(full.tiersApplied, ["tool-results", "reasoning", "summarize"]);

    // The compacted history survives a real loop request build.
    const endTurn: ChatResponse = { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    const provider: ChatProvider = {
      send: async () => endTurn,
      stream: () => ({ async *[Symbol.asyncIterator]() {}, finalResponse: async () => endTurn }),
    };
    const state = makeReplState();
    const r = await runAgent({
      userPrompt: "next", session: state.session!, messages: full.messages,
      autoApprove: false, confirm: async () => ({ approved: true }), provider,
    });
    assert.equal(r.isError, false);
  });

  test("the most recent turns stay verbatim through full compaction", async () => {
    const messages = history(8);
    const turns = splitTurns(messages);
    const recent = turns.slice(-KEEP_RECENT_TURNS).flat();

    const c = await compactHistory(messages, { targetTokens: 1 });
    const tail = c.messages.slice(-recent.length);
    assert.deepEqual(tail, recent, "recent turns byte-identical: results, reasoning, all of it");
  });

  test("tier ordering: tool results first, then reasoning, then summarization", async () => {
    const messages = history(8);
    // Generous target: tier a alone suffices.
    const light = await compactHistory(messages, { targetTokens: estimateHistoryTokens(messages) });
    assert.deepEqual(light.tiersApplied, ["tool-results"]);
    const lightBlocks = light.messages.flatMap((m) => m.content);
    assert.ok(lightBlocks.some((b) => b.type === "reasoning"), "reasoning untouched at tier a");
    // Old tool results elided, recent kept.
    const elided = lightBlocks.filter((b) => b.type === "tool_result" && (b as { content: unknown }).content === ELIDED_TOOL_RESULT);
    assert.equal(elided.length, 8 - KEEP_RECENT_TURNS);
  });

  test("user intent survives summarization — the digest carries the requests", async () => {
    const messages = history(6);
    const c = await compactHistory(messages, { targetTokens: 1 });   // mechanical digest (no provider)
    const first = c.messages[0]!;
    assert.equal(first.role, "user");
    const digest = (first.content[0] as { text: string }).text;
    assert.match(digest, /compacted digest of 3 earlier turns/);
    assert.match(digest, /request 0: tighten the video/, "user's own words preserved in the digest");
    assert.match(digest, /request 2/);
  });

  test("summarization goes through the ChatProvider seam when available", async () => {
    const sends: string[] = [];
    const provider: ChatProvider = {
      send: async (req) => {
        sends.push((req.messages[0]!.content[0] as { text: string }).text);
        return { content: [{ type: "text", text: "- user tightened video repeatedly" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
      },
      stream: () => { throw new Error("summarization must not stream"); },
    };
    const c = await compactHistory(history(6), { targetTokens: 1, getProvider: () => provider });
    assert.equal(sends.length, 1, "one summary call");
    assert.match(sends[0]!, /request 0/, "the old turns reach the summarizer");
    assert.match((c.messages[0]!.content[0] as { text: string }).text, /tightened video repeatedly/);
  });

  test("a failing provider falls back to the mechanical digest — never blocks", async () => {
    const provider: ChatProvider = {
      send: async () => { throw new Error("rate limited"); },
      stream: () => { throw new Error("rate limited"); },
    };
    const c = await compactHistory(history(6), { targetTokens: 1, getProvider: () => provider });
    assert.match((c.messages[0]!.content[0] as { text: string }).text, /request 0/);
    assert.ok(validateHistoryStructure(c.messages).ok);
  });

  test("compaction reduces the estimate; the estimator is the shared one", async () => {
    const messages = history(10);
    const before = estimateHistoryTokens(messages);
    const c = await compactHistory(messages, { targetTokens: 1 });
    assert.ok(c.afterTokens < before);
    assert.equal(c.beforeTokens, before, "reported numbers come from the one estimator");
    assert.equal(c.afterTokens, estimateHistoryTokens(c.messages));
  });

  test("shouldAutoCompact triggers at the named threshold", () => {
    assert.equal(shouldAutoCompact(history(3)), false);
    const big = [userMsg("x".repeat(AUTO_COMPACT_THRESHOLD_TOKENS * 5))];
    assert.equal(shouldAutoCompact(big), true);
  });

  test("evictAllToolResults elides everything (resume hygiene)", () => {
    const out = evictAllToolResults(history(4));
    const results = out.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    assert.ok(results.every((r) => (r as { content: unknown }).content === ELIDED_TOOL_RESULT));
    assert.ok(validateHistoryStructure(out).ok);
  });
});

// ── Dispatch integration ──────────────────────────────────────────────────────

describe("dispatch — persistence and compaction wiring", () => {
  const agentEcho = (reply: string) =>
    async (input: { messages: NeutralMessage[]; session: unknown; userPrompt: string }) => ({
      messages: [...input.messages, userMsg(input.userPrompt), { role: "assistant" as const, content: [{ type: "text" as const, text: reply }] }],
      session: input.session as never,
      output: reply,
      isError: false,
    });

  test("an agent turn persists the conversation to the sidecar", async () => {
    const state = makeReplState();
    await dispatch("hello", state, { confirm: async () => ({ approved: true }), agent: agentEcho("hi") as never });
    const peek = await peekSession();
    assert.ok(peek.exists && peek.messageCount === 2);
  });

  test("/clear empties the persisted file — a restart after /clear starts empty", async () => {
    await saveSession(history(2), INFO);
    const state = makeReplState(history(2));
    const r = await dispatch("/clear", state);
    assert.equal(r.isError, false);
    const peek = await peekSession();
    assert.equal(peek.messageCount, 0, "persisted conversation cleared");
    const reloaded = await loadSession(INFO);
    assert.ok(reloaded.ok && reloaded.messages.length === 0, "a restart after /clear starts empty");
  });

  test("/resume loads the saved conversation with stale results elided", async () => {
    await saveSession(history(2), INFO);
    const state = makeReplState();
    const r = await dispatch("/resume", state);
    assert.equal(r.isError, false);
    assert.match(r.output, /Resumed conversation: 8 messages/);
    assert.ok(r.newState);
    const results = r.newState.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    assert.ok(results.every((res) => (res as { content: unknown }).content === ELIDED_TOOL_RESULT));
  });

  test("/resume with no file and with a corrupt file never crashes", async () => {
    const none = await dispatch("/resume", makeReplState());
    assert.equal(none.isError, false);
    assert.match(none.output, /No saved conversation/);

    writeFileSync(sessionFilePath(), "garbage", "utf-8");
    const corrupt = await dispatch("/resume", makeReplState());
    assert.match(corrupt.output, /couldn't be read/);
  });

  test("/compact compacts, reports, and surfaces the divider payload", async () => {
    const state = makeReplState(history(6));
    const r = await dispatch("/compact", state, {
      compact: (msgs, deps) => compactHistory(msgs, { ...deps, getProvider: undefined, targetTokens: 1 }),
    });
    assert.equal(r.isError, false);
    assert.match(r.output, /Compacted 3 turns/);
    assert.ok(r.compacted && r.compacted.turns === 3);
    assert.ok(r.newState && r.newState.messages.length < state.messages.length);
    // The compacted history was persisted too.
    assert.ok((await peekSession()).messageCount === r.newState.messages.length);
  });

  test("auto-compact fires before an oversized agent turn and the agent sees compacted history", async () => {
    const huge = [
      ...history(4),
      userMsg("x".repeat(AUTO_COMPACT_THRESHOLD_TOKENS * 5)),
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
    ];
    const state = makeReplState(huge);
    let received: NeutralMessage[] | null = null;
    const agent = async (input: { messages: NeutralMessage[]; session: unknown; userPrompt: string }) => {
      received = input.messages;
      return { messages: input.messages, session: input.session as never, output: "done", isError: false };
    };
    const r = await dispatch("next request", state, {
      confirm: async () => ({ approved: true }),
      agent: agent as never,
      compact: (msgs, deps) => compactHistory(msgs, { ...deps, getProvider: undefined }),
    });
    assert.ok(r.compacted, "compaction reported for the divider");
    assert.ok(received !== null);
    assert.ok(
      estimateHistoryTokens(received!) < estimateHistoryTokens(huge),
      "the agent received the compacted history",
    );
  });

  test("small histories do not trigger auto-compaction", async () => {
    const state = makeReplState(history(2));
    let compactCalled = false;
    const r = await dispatch("hi", state, {
      confirm: async () => ({ approved: true }),
      agent: agentEcho("hello") as never,
      compact: (async (msgs: NeutralMessage[]) => { compactCalled = true; return compactHistory(msgs); }) as never,
    });
    assert.equal(compactCalled, false);
    assert.equal(r.compacted, undefined);
  });

  test("/help lists /compact and /resume", async () => {
    const r = await dispatch("/help", { session: null, messages: [], autoApprove: false });
    assert.match(r.output, /\/compact/);
    assert.match(r.output, /\/resume/);
  });
});

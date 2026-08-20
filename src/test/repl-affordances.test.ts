import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMPTY_QUEUE, typeIntoQueue, backspaceQueue, markQueueReady,
  drainQueueOnComplete, preserveQueueOnAbort,
} from "../repl/queue.js";
import { completionQuery, clipCompletions, applyCompletion } from "../repl/completions.js";
import {
  emptyTotals, addUsage, recordUsage, getSessionTotals, resetSessionTotals, renderCostReport,
} from "../repl/cost.js";
import { withUsageReporting } from "../agent/providers/default.js";
import {
  pushTurnDetail, formatDetailValue, MAX_DETAIL_TURNS, MAX_DETAIL_ITEM_CHARS,
  type TurnDetail,
} from "../repl/turn-detail.js";
import { stepHistory } from "../repl/hooks/useCommandHistory.js";
import { stripAnsi } from "../ui/theme.js";
import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { runAgent, type ProgressEvent } from "../agent/loop.js";
import type { ChatProvider, ChatResponse } from "../agent/providers/types.js";
import { createProject } from "../project/io.js";
import { addSource, setClipUserLabel, splitClip } from "../project/mutations.js";
import { createSession } from "../project/session.js";
import { clipsInOrder } from "../project/types.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 120,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4", ...overrides,
  };
}

function makeState(n = 1): ProjectState {
  let state = createProject("test");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({ fileName: `clip${i + 1}.mp4`, filePath: `/fake/clip${i + 1}.mp4` }));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

const USAGE = { inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 30, cacheCreationTokens: 5 };

// ── Queued input (3K §2) ──────────────────────────────────────────────────────

describe("input queue", () => {
  test("typing composes; backspace edits; Enter arms the line", () => {
    let q = typeIntoQueue(EMPTY_QUEUE, "trim ");
    q = typeIntoQueue(q, "clip 2x");
    q = backspaceQueue(q);
    assert.equal(q.text, "trim clip 2");
    assert.equal(q.ready, false);
    q = markQueueReady(q);
    assert.equal(q.ready, true);
  });

  test("a ready line auto-submits on turn completion", () => {
    const q = markQueueReady(typeIntoQueue(EMPTY_QUEUE, "delete clip 3"));
    const d = drainQueueOnComplete(q);
    assert.equal(d.submit, "delete clip 3");
    assert.equal(d.draft, null);
    assert.deepEqual(d.queue, EMPTY_QUEUE);
  });

  test("an unfinished draft moves back to the prompt, never auto-fired", () => {
    const d = drainQueueOnComplete(typeIntoQueue(EMPTY_QUEUE, "half a thou"));
    assert.equal(d.submit, null);
    assert.equal(d.draft, "half a thou");
  });

  test("abort preserves the queue as a draft — even a READY line does not fire", () => {
    const armed = markQueueReady(typeIntoQueue(EMPTY_QUEUE, "and then export it"));
    const d = preserveQueueOnAbort(armed);
    assert.equal(d.submit, null, "aborting a turn must never fire the queue");
    assert.equal(d.draft, "and then export it");
  });

  test("typing after Enter resumes editing (un-arms); empty lines never arm", () => {
    const resumed = typeIntoQueue(markQueueReady(typeIntoQueue(EMPTY_QUEUE, "x")), "y");
    assert.equal(resumed.ready, false);
    assert.equal(resumed.text, "xy");
    assert.deepEqual(markQueueReady(typeIntoQueue(EMPTY_QUEUE, "   ")), EMPTY_QUEUE);
  });

  test("/clear signals the queue to empty", async () => {
    const state: ReplState = { session: createSession(makeState()), messages: [], autoApprove: false };
    const r = await dispatch("/clear", state);
    assert.equal(r.clearsInputQueue, true);
  });
});

// ── @ completion (3K §3) ──────────────────────────────────────────────────────

describe("@ clip-ref completion", () => {
  test("completionQuery finds a trailing @token; applyCompletion inserts the plain ref", () => {
    assert.equal(completionQuery("trim @"), "");
    assert.equal(completionQuery("trim @2"), "2");
    assert.equal(completionQuery("no token here"), null);
    assert.equal(completionQuery("email me @ home "), null, "@ mid-sentence with trailing space is not a token");
    assert.equal(applyCompletion("tighten @2a", "2a"), "tighten 2a ");
    assert.ok(!applyCompletion("trim @1", "1").includes("@"), "inserted ref is plain — no @ reaches the agent");
  });

  test("completes over live refs including split groups, with labels", () => {
    let state = makeState(2);
    const [first] = clipsInOrder(state.timeline);
    const split = splitClip(state, first!.id, 60);
    assert.ok(split.ok);
    state = split.state;
    const labeled = setClipUserLabel(state, clipsInOrder(state.timeline)[0]!.id, "good take");
    assert.ok(labeled.ok);
    state = labeled.state;

    const all = clipCompletions(state, "");
    assert.deepEqual(all.map((c) => c.ref), ["1a", "1b", "2"]);
    assert.equal(all[0]!.userLabel, "good take");
    assert.equal(all[0]!.fileName, "clip1.mp4");

    const filtered = clipCompletions(state, "1");
    assert.deepEqual(filtered.map((c) => c.ref), ["1a", "1b"]);
  });

  test("empty timeline and null state are silent no-ops", () => {
    assert.deepEqual(clipCompletions(createProject("empty"), ""), []);
    assert.deepEqual(clipCompletions(null, ""), []);
  });
});

// ── /cost (3K §5) ─────────────────────────────────────────────────────────────

describe("/cost", () => {
  beforeEach(() => resetSessionTotals());

  test("addUsage accumulates per role, pure", () => {
    let t = emptyTotals();
    t = addUsage(t, "director", USAGE);
    t = addUsage(t, "director", USAGE);
    t = addUsage(t, "scout", USAGE);
    assert.equal(t.director.calls, 2);
    assert.equal(t.director.inputTokens, 200);
    assert.equal(t.director.reasoningTokens, 20);
    assert.equal(t.scout.calls, 1);
    assert.equal(t.critic.calls, 0);
  });

  test("withUsageReporting attributes send AND stream by request role", async () => {
    const reports: Array<[string, number]> = [];
    const response: ChatResponse = { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: USAGE };
    const inner: ChatProvider = {
      send: async () => response,
      stream: () => ({
        async *[Symbol.asyncIterator]() {},
        finalResponse: async () => response,
      }),
    };
    const tapped = withUsageReporting(inner, (role, usage) => reports.push([role, usage.inputTokens]));

    await tapped.send({ system: "s", messages: [], tools: [], maxTokens: 10, role: "scout" });
    await tapped.send({ system: "s", messages: [], tools: [], maxTokens: 10, role: "critic" });
    await tapped.stream({ system: "s", messages: [], tools: [], maxTokens: 10, role: "director" }).finalResponse();
    await tapped.send({ system: "s", messages: [], tools: [], maxTokens: 10 });   // untagged → director

    assert.deepEqual(reports, [["scout", 100], ["critic", 100], ["director", 100], ["director", 100]]);
  });

  test("the loop, scouts, and critic tag their requests with their role", () => {
    const root = new URL("../../", import.meta.url).pathname;
    assert.match(readFileSync(join(root, "src/agent/loop.ts"), "utf-8"), /role: "director"/);
    assert.match(readFileSync(join(root, "src/agent/scout.ts"), "utf-8"), /role: "scout"/);
    assert.match(readFileSync(join(root, "src/agent/critic.ts"), "utf-8"), /role: "critic"/);
  });

  test("/cost renders accumulated totals with per-role rows", async () => {
    recordUsage("director", USAGE);
    recordUsage("scout", USAGE);
    recordUsage("scout", USAGE);
    recordUsage("critic", USAGE);

    const state: ReplState = { session: createSession(makeState()), messages: [], autoApprove: false };
    const r = await dispatch("/cost", state);
    assert.equal(r.isError, false);
    const plain = stripAnsi(r.output);
    assert.match(plain, /director/);
    assert.match(plain, /scout/);
    assert.match(plain, /critic/);
    assert.match(plain, /total/);
    // scout row: 2 calls, 200 input.
    const scoutRow = plain.split("\n").find((l) => l.trim().startsWith("scout"))!;
    assert.match(scoutRow, /2/);
    assert.match(scoutRow, /200/);
    assert.match(plain, /Tokens only/, "no dollar estimate presented as authoritative");
  });

  test("/help lists /cost", async () => {
    const r = await dispatch("/help", { session: null, messages: [], autoApprove: false });
    assert.match(r.output, /\/cost/);
  });
});

// ── Ctrl+R expansion: retention + progress-event payloads (3K §1) ─────────────

describe("turn-detail retention", () => {
  const turn = (id: number): TurnDetail => ({
    id: String(id), prompt: `turn ${id}`,
    items: [{ kind: "tool", name: "detect_silence", input: { sourceId: "s" }, ok: true, result: { silences: [] } }],
  });

  test(`retention is bounded at ${MAX_DETAIL_TURNS} turns, oldest evicted`, () => {
    let list: TurnDetail[] = [];
    for (let i = 0; i < MAX_DETAIL_TURNS + 3; i++) list = pushTurnDetail(list, turn(i));
    assert.equal(list.length, MAX_DETAIL_TURNS, "never grows beyond the cap");
    assert.equal(list[0]!.id, "3", "oldest evicted first");
    assert.equal(list[list.length - 1]!.id, String(MAX_DETAIL_TURNS + 2));
  });

  test("rendered values are truncated to the per-item bound", () => {
    const huge = "x".repeat(MAX_DETAIL_ITEM_CHARS * 4);
    const out = formatDetailValue(huge);
    assert.ok(out.length <= MAX_DETAIL_ITEM_CHARS + 20, "bounded with a truncation note");
    assert.match(out, /truncated/);
  });

  test("expanded output is markdown-stripped (3I.5 discipline extends here)", () => {
    const out = formatDetailValue({ gist: "the **strongest** moment in `test.mp4`" });
    assert.doesNotMatch(out, /\*\*/);
    assert.doesNotMatch(out, /`test/);
    assert.match(out, /strongest/);
  });

  test("tool_result progress events carry the detail payload; critic verdicts carry concerns", async () => {
    const state = makeState();
    const session = createSession(state);
    const clipId = state.timeline.headId!;
    const responses: ChatResponse[] = [
      { content: [{ type: "tool_use", id: "t1", name: "query_timeline", input: {} }], stopReason: "tool_use", usage: USAGE },
      { content: [{ type: "tool_use", id: "t2", name: "propose_edit_plan", input: {
        summary: "Compound.", operations: [
          { type: "trim", clipId, inPoint: 0, outPoint: 60 },
          { type: "split", clipId, splitPoint: 20 },
          { type: "move", clipId, newIndex: 1 },
        ] } }], stopReason: "tool_use", usage: USAGE },
      { content: [{ type: "text", text: "Done." }], stopReason: "end_turn", usage: USAGE },
    ];
    let i = 0;
    const provider: ChatProvider = {
      send: async () => responses[i++]!,
      stream: () => ({ async *[Symbol.asyncIterator]() {}, finalResponse: async () => responses[i++]! }),
    };

    const events: ProgressEvent[] = [];
    const r = await runAgent({
      userPrompt: "do a compound edit",
      session, messages: [], autoApprove: true,
      confirm: async () => ({ approved: true }),
      onProgress: (e) => events.push(e),
      provider,
      critic: async () => ({ verdict: "revise", concerns: [{ severity: "major", operationIndex: 1, issue: "mid-word cut" }] }),
    });
    // Critic revises forever → cap → presented with concerns → auto-approved.
    assert.equal(r.isError, false);

    const toolResult = events.find((e) => e.type === "tool_result" && e.name === "query_timeline");
    assert.ok(toolResult && toolResult.type === "tool_result");
    assert.ok(toolResult.detail !== undefined, "tool_result must carry its payload for expansion");
    assert.match(JSON.stringify(toolResult.detail), /clips/);

    const verdict = events.find((e) => e.type === "critic_verdict");
    assert.ok(verdict && verdict.type === "critic_verdict");
    assert.equal(verdict.concernDetails?.[0]?.issue, "mid-word cut", "verdict must carry structured concerns");
  });
});

// ── History + key-routing regressions (3K §4) ─────────────────────────────────

describe("input history", () => {
  test("up cycles back through submitted inputs; down returns to the draft", () => {
    const history = ["third", "second", "first"];   // newest first
    let s = stepHistory(history, -1, "up")!;
    assert.equal(s.value, "third");
    s = stepHistory(history, s.cursor, "up")!;
    assert.equal(s.value, "second");
    s = stepHistory(history, s.cursor, "down")!;
    assert.equal(s.value, "third");
    s = stepHistory(history, s.cursor, "down")!;
    assert.equal(s.value, "");
    assert.equal(s.cursor, -1);
  });

  test("up clamps at the oldest entry; empty history is a no-op", () => {
    const history = ["only"];
    const top = stepHistory(history, 0, "up")!;
    assert.equal(top.value, "only");
    assert.equal(stepHistory([], -1, "up"), null);
    assert.equal(stepHistory(["x"], -1, "down"), null);
  });

  test("no regression: arrows still route timeline zoom/scroll first, history otherwise; completion wins while open", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const src = readFileSync(join(root, "src/repl/components/InputLine.tsx"), "utf-8");
    // Timeline binding intact (3C-3).
    assert.match(src, /timelineActive \? onViewportZoom\("in"\) : onHistoryUp\(\)/);
    assert.match(src, /timelineActive \? onViewportZoom\("out"\) : onHistoryDown\(\)/);
    // Completion handles arrows BEFORE the timeline/history routing.
    const completionIdx = src.indexOf("if (completionOpen)");
    const routingIdx = src.indexOf('timelineActive ? onViewportZoom("in")');
    assert.ok(completionIdx > 0 && completionIdx < routingIdx, "completion arrows resolve before timeline/history");
  });
});

// ── Wiring guards (the 3I.5 lesson: features must be REACHED) ─────────────────

describe("affordance wiring", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const appSource = readFileSync(join(root, "src/repl/App.tsx"), "utf-8");

  test("the App drains the queue at turn end and clears it on /clear", () => {
    assert.match(appSource, /drainQueueOnComplete\(queueRef\.current\)/);
    assert.match(appSource, /result\.clearsInputQueue/);
  });

  test("the App commits bounded turn detail and registers the usage listener", () => {
    assert.match(appSource, /pushTurnDetail\(prev/);
    assert.match(appSource, /setUsageListener\(recordUsage\)/);
  });
});

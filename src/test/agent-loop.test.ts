import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runAgent, MAX_CRITIC_REVISIONS } from "../agent/loop.js";
import type { CriticInput, CriticVerdict } from "../agent/critic.js";
import type { PlanForConfirmation } from "../agent/propose_edit_plan.js";
import type { ChatProvider, ChatResponse, ContentBlock } from "../agent/providers/types.js";
import { buildDefaultRegistry } from "../agent/registry.js";
import type { ToolSchema } from "../agent/types.js";
import type { ContentMap } from "../agent/content-map.js";
import { transcribeAudio } from "../agent/tools/transcribe_audio.js";
import { detectSilence } from "../agent/tools/detect_silence.js";
import { queryTimeline } from "../agent/tools/query_timeline.js";
import { setClipUserLabel } from "../project/mutations.js";
import { createSession } from "../project/session.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import { clipsInOrder } from "../project/types.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4",
    fileName: "a.mp4",
    duration: 120,
    width: 1920, height: 1080, fps: 30,
    videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128,
    fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4",
    ...overrides,
  };
}

function makeSession() {
  let state: ProjectState = createProject("test");
  const r = addSource(state, makeMediaInfo());
  assert.ok(r.ok);
  state = r.state;
  return { session: createSession(state), clipId: state.timeline.headId! };
}

// Build a StreamHandle that synthesizes neutral deltas from a canned response
// (thinking → thinking_delta, text → text_delta, tool_use → tool_use_start) and
// resolves that same response from finalResponse(). This is how the loop now
// consumes a turn; the assembled response drives all behavior identically.
function handleFor(response: ChatResponse): import("../agent/providers/types.js").StreamHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const block of response.content) {
        if (block.type === "reasoning" && block.text) yield { type: "thinking_delta", text: block.text };
        else if (block.type === "text") yield { type: "text_delta", text: block.text };
        else if (block.type === "tool_use") yield { type: "tool_use_start", name: block.name };
      }
      yield { type: "message_complete", stopReason: response.stopReason };
    },
    async finalResponse() { return response; },
  };
}

// A mock ChatProvider that STREAMS canned NEUTRAL responses, one per turn.
// The seam the loop talks to — no Anthropic SDK shapes here.
function mockProvider(responses: ChatResponse[]): ChatProvider {
  let i = 0;
  const next = () => {
    const r = responses[i++];
    if (!r) throw new Error(`mockProvider exhausted at call ${i}`);
    return r;
  };
  return {
    send: async () => next(),
    stream: () => handleFor(next()),
  };
}

// Like mockProvider but also records every ChatRequest the loop builds, so we
// can assert what the loop asks for (reasoning config, maxTokens).
function capturingProvider(responses: ChatResponse[]): {
  provider: ChatProvider;
  requests: import("../agent/providers/types.js").ChatRequest[];
} {
  const requests: import("../agent/providers/types.js").ChatRequest[] = [];
  let i = 0;
  const next = () => {
    const r = responses[i++];
    if (!r) throw new Error(`capturingProvider exhausted at call ${i}`);
    return r;
  };
  return {
    provider: {
      send: async (req) => { requests.push(req); return next(); },
      stream: (req) => { requests.push(req); return handleFor(next()); },
    },
    requests,
  };
}

function endTurn(text: string): ChatResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function toolUse(name: string, input: unknown, id = "tu_1"): ChatResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function noConfirm() {
  return async () => {
    throw new Error("confirm should not be called");
  };
}

/**
 * The default registry with the audio tools' execute swapped for canned
 * results — `register` overwrites by name. Nothing else is stubbed, so a turn
 * here exercises the real loop, the real dispatch, and the real schemas.
 */
function registryWithMockedAudio(canned: { transcript?: unknown; silences?: unknown }) {
  const called: string[] = [];
  const registry = buildDefaultRegistry();
  registry.register({
    schema: transcribeAudio.schema,
    execute: async (_state, input) => {
      called.push(`transcribe_audio:${JSON.stringify(input)}`);
      return { ok: true, result: canned.transcript ?? { segments: [] } };
    },
  });
  registry.register({
    schema: detectSilence.schema,
    execute: async (_state, input) => {
      called.push(`detect_silence:${JSON.stringify(input)}`);
      return { ok: true, result: canned.silences ?? { silences: [] } };
    },
  });
  return { registry, called };
}

// ── Single tool call → text reply ─────────────────────────────────────────────

describe("runAgent — basic flow", () => {
  test("calls query_timeline then ends turn with text", async () => {
    const { session } = makeSession();
    const provider = mockProvider([
      toolUse("query_timeline", {}, "tu_qt"),
      endTurn("There is one clip on the timeline."),
    ]);

    const events: string[] = [];
    const r = await runAgent({
      userPrompt: "what's on the timeline?",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      onProgress: (e) => events.push(e.type),
      provider,
    });

    assert.equal(r.isError, false);
    assert.match(r.output, /one clip/);
    assert.ok(events.includes("tool_call"));
    assert.ok(events.includes("tool_result"));
    assert.ok(events.includes("text_delta"), "assistant text streams as deltas");
  });

  test("multi-turn: second runAgent call sees prior messages", async () => {
    const { session } = makeSession();
    const provider = mockProvider([endTurn("OK.")]);

    const r = await runAgent({
      userPrompt: "second prompt",
      session,
      messages: [
        { role: "user", content: [{ type: "text", text: "first prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      ],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, false);
    // The returned messages include both turns plus the second prompt + reply
    const userTurns = r.messages.filter((m) => m.role === "user");
    assert.equal(userTurns.length, 2);
  });
});

// ── Plan submission + auto-approve ────────────────────────────────────────────

describe("runAgent — propose_edit_plan", () => {
  test("auto-approve: applies plan without calling confirm; undo entry has the user prompt as label", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", {
        summary: "Trim the start.",
        operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }],
      }, "tu_plan"),
      endTurn("Done."),
    ]);

    let confirmCalled = false;
    const r = await runAgent({
      userPrompt: "trim clip 1 to 30 seconds",
      session,
      messages: [],
      autoApprove: true,
      confirm: async () => { confirmCalled = true; return { approved: true }; },
      provider,
    });

    assert.equal(r.isError, false);
    assert.equal(confirmCalled, false, "confirm must NOT be called when autoApprove is true");
    // Clip was trimmed
    const updated = clipsInOrder(r.session.state.timeline)[0]!;
    assert.equal(updated.outPoint, 30);
    // One undo entry, labeled with the user's verbatim prompt
    assert.equal(r.session.undo.length, 1);
    assert.equal(r.session.undo[0]!.label, "trim clip 1 to 30 seconds");
    assert.match(r.output, /Applied: trim clip 1 to 30 seconds/);
  });

  test("user rejects: no state change, agent gets rejected tool_result", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", {
        summary: "Trim the start.",
        operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }],
      }, "tu_plan"),
      endTurn("OK, no changes."),
    ]);

    const r = await runAgent({
      userPrompt: "trim clip 1 to 30s",
      session,
      messages: [],
      autoApprove: false,
      confirm: async () => ({ approved: false }),
      provider,
    });

    assert.equal(r.isError, false);
    // No state change
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 120);
    assert.equal(r.session.undo.length, 0);
    assert.match(r.output, /rejected/i);
  });

  test("applyPlan fails: tool_result has is_error, agent continues and ends", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", {
        summary: "Bad trim.",
        operations: [{ type: "trim", clipId, inPoint: 50, outPoint: 30 }], // invalid
      }, "tu_plan"),
      endTurn("Sorry, that won't work."),
    ]);

    const r = await runAgent({
      userPrompt: "trim badly",
      session,
      messages: [],
      autoApprove: true,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, true);
    // No state change because applyPlan aborted
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 120);
    assert.equal(r.session.undo.length, 0);
    // Agent's text reply still surfaces in output
    assert.match(r.output, /won't work|failed/i);
  });
});

// ── Tool error handling ───────────────────────────────────────────────────────

describe("runAgent — error paths", () => {
  test("unknown tool: tool_result is_error, agent gracefully continues", async () => {
    const { session } = makeSession();
    const provider = mockProvider([
      toolUse("does_not_exist", {}, "tu_bad"),
      endTurn("I'll stop."),
    ]);

    const r = await runAgent({
      userPrompt: "do something weird",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, false);
    assert.match(r.output, /I'll stop/);
  });

  test("provider error surfaces as friendly output", async () => {
    const { session } = makeSession();
    // The loop consumes the stream; an error there must surface, not crash.
    const provider: ChatProvider = {
      send: async () => { throw new Error("rate limited"); },
      stream: () => { throw new Error("rate limited"); },
    };

    const r = await runAgent({
      userPrompt: "hi",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, true);
    assert.match(r.output, /rate limited/);
  });
});

// ── Reasoning-block round-trip through the loop (guards 3E-2.5) ────────────────

describe("runAgent — reasoning-block tolerance", () => {
  test("a neutral reasoning block alongside tool_use survives history unchanged", async () => {
    const { session } = makeSession();
    // Canned response with an opaque reasoning block + a tool_use block. The
    // opaque payload stands in for a provider's stateful reasoning; the loop
    // must carry it through history verbatim without inspecting it.
    const opaque = { type: "thinking", thinking: "Let me see the timeline first.", signature: "sig" };
    const withReasoning: ChatResponse = {
      content: [
        { type: "reasoning", provider: "anthropic", opaque, text: "Let me see the timeline first." },
        { type: "tool_use", id: "tu_qt2", name: "query_timeline", input: {} },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 12 },
    };
    const provider = mockProvider([withReasoning, endTurn("One clip.")]);

    const r = await runAgent({
      userPrompt: "describe the timeline",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, false);
    // The reasoning block is preserved in messages, opaque intact, not stripped.
    const assistantTurn = r.messages.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "reasoning"),
    );
    assert.ok(assistantTurn);
    const reasoning = assistantTurn.content.find(
      (b): b is Extract<ContentBlock, { type: "reasoning" }> => b.type === "reasoning",
    );
    assert.ok(reasoning);
    assert.deepEqual(reasoning.opaque, opaque);
  });
});

// ── Extended thinking (3E-2.5) ────────────────────────────────────────────────

describe("runAgent — extended thinking", () => {
  test("the loop asks the provider for reasoning and a raised max-output budget", async () => {
    const { session } = makeSession();
    const { provider, requests } = capturingProvider([endTurn("OK.")]);

    await runAgent({
      userPrompt: "hi",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.reasoning, { enabled: true });
    // Thinking tokens count toward the budget — must be above the old 4096.
    assert.ok(requests[0]!.maxTokens > 4096, `maxTokens ${requests[0]!.maxTokens} must exceed 4096`);
  });

  test("max_output twice in a row (after the larger-budget retry) is an explicit error, not a silent end", async () => {
    const { session } = makeSession();
    const cut: ChatResponse = {
      content: [{ type: "text", text: "partial answer that got cut" }],
      stopReason: "max_output",
      usage: { inputTokens: 0, outputTokens: 32000 },
    };
    const provider = mockProvider([cut, cut]);

    const r = await runAgent({
      userPrompt: "do a huge thing",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, true, "max_output must surface as an error");
    assert.match(r.output, /cut off|output-token limit|narrow/i);
  });

  test("one truncated turn is discarded and re-asked once with a bigger budget", async () => {
    const { session, clipId } = makeSession();
    const { provider, requests } = capturingProvider([
      { content: [{ type: "text", text: "half a plan" }], stopReason: "max_output", usage: { inputTokens: 0, outputTokens: 32000 } },
      toolUse("propose_edit_plan", { summary: "Trim.", operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }] }, "tu_plan"),
      endTurn("Done."),
    ]);
    const r = await runAgent({
      userPrompt: "trim", session, messages: [], autoApprove: true,
      confirm: async () => ({ approved: true }), provider,
    });
    assert.equal(r.isError, false, r.output);
    assert.ok(requests[1]!.maxTokens > requests[0]!.maxTokens, "the retry asks for more room");
    assert.equal(requests[1]!.messages.length, requests[0]!.messages.length, "the truncated response never entered history");
    assert.ok(!JSON.stringify(r.messages).includes("half a plan"));
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 30);
  });

  test("a turn with no reasoning block is handled with no error and no thinking event", async () => {
    const { session } = makeSession();
    const provider = mockProvider([endTurn("Trimmed the first 2 seconds.")]);

    const events: string[] = [];
    const r = await runAgent({
      userPrompt: "trim the first 2 seconds",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      onProgress: (e) => events.push(e.type),
      provider,
    });

    assert.equal(r.isError, false);
    assert.ok(!events.includes("thinking_delta"), "adaptive skipped thinking → no thinking event");
  });

  test("a reasoning block with empty text emits no thinking event and does not crash", async () => {
    const { session } = makeSession();
    const provider = mockProvider([
      {
        content: [
          { type: "reasoning", provider: "anthropic", opaque: { type: "thinking", thinking: "", signature: "s" }, text: "" },
          { type: "text", text: "Done." },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);

    const events: string[] = [];
    const r = await runAgent({
      userPrompt: "hello",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      onProgress: (e) => events.push(e.type),
      provider,
    });

    assert.equal(r.isError, false);
    assert.ok(!events.includes("thinking_delta"), "empty reasoning text must not emit a thinking event");
  });

  test("thinking progress is emitted before the tool_call it precedes", async () => {
    const { session } = makeSession();
    const provider = mockProvider([
      {
        content: [
          { type: "reasoning", provider: "anthropic", opaque: { type: "thinking", thinking: "Check the timeline first.", signature: "s" }, text: "Check the timeline first." },
          { type: "tool_use", id: "tu_qt", name: "query_timeline", input: {} },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      endTurn("One clip."),
    ]);

    const ordered: string[] = [];
    const r = await runAgent({
      userPrompt: "what's on the timeline?",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      onProgress: (e) => ordered.push(e.type),
      provider,
    });

    assert.equal(r.isError, false);
    const think = ordered.indexOf("thinking_delta");
    const call = ordered.indexOf("tool_call");
    assert.ok(think >= 0 && call >= 0, "both events present");
    assert.ok(think < call, "thinking must precede the tool_call");
  });

  test("reasoning + propose_edit_plan applies under auto-approve with the label intact", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      {
        content: [
          { type: "reasoning", provider: "anthropic", opaque: { type: "thinking", thinking: "Trim to 30.", signature: "s" }, text: "Trim to 30." },
          { type: "tool_use", id: "tu_plan", name: "propose_edit_plan", input: {
            summary: "Trim the start.",
            operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }],
          } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      endTurn("Done."),
    ]);

    const r = await runAgent({
      userPrompt: "trim clip 1 to 30 seconds",
      session,
      messages: [],
      autoApprove: true,
      confirm: noConfirm(),
      provider,
    });

    assert.equal(r.isError, false);
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 30);
    assert.equal(r.session.undo.length, 1);
    assert.equal(r.session.undo[0]!.label, "trim clip 1 to 30 seconds");
    // The reasoning block preceding the plan is preserved in history.
    const assistantTurn = r.messages.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "reasoning"),
    );
    assert.ok(assistantTurn);
  });
});

// ── Audio tools (3E-2) ────────────────────────────────────────────────────────
//
// The architectural guard for the slice: these turns dispatch audio tools with
// ZERO changes to loop.ts. If they ever need one, the registry abstraction is
// leaking and the registry is what should be fixed.

describe("runAgent — audio tools", () => {
  test("the default registry offers both audio tools to the model", () => {
    const names = buildDefaultRegistry().allSchemas().map((s) => s.name);
    assert.ok(names.includes("transcribe_audio"));
    assert.ok(names.includes("detect_silence"));
    // Still terminal, still present alongside them.
    assert.ok(names.includes("propose_edit_plan"));
  });

  test("transcribe_audio dispatches through the registry — no loop change", async () => {
    const { session } = makeSession();
    const { registry, called } = registryWithMockedAudio({
      transcript: {
        sourceId: "s1",
        segments: [{ start: 7, end: 11, text: "The price is forty nine dollars a month." }],
        totalSegments: 5,
        transcriptDuration: 20,
        truncated: false,
        hasAudio: true,
        cached: false,
      },
    });

    const provider = mockProvider([
      toolUse("transcribe_audio", { sourceId: "s1", query: "price" }, "tu_ta"),
      endTurn("You mention the price at 0:07."),
    ]);

    const r = await runAgent({
      userPrompt: "where do I mention the price?",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
      registry,
    });

    assert.equal(r.isError, false);
    assert.deepEqual(called, ['transcribe_audio:{"sourceId":"s1","query":"price"}']);
    assert.match(r.output, /0:07/);
  });

  test("detect_silence dispatches through the registry — no loop change", async () => {
    const { session } = makeSession();
    const { registry, called } = registryWithMockedAudio({
      silences: { sourceId: "s1", silences: [{ start: 0, end: 3, duration: 3 }], hasAudio: true, cached: false },
    });

    const provider = mockProvider([
      toolUse("detect_silence", { sourceId: "s1" }, "tu_ds"),
      endTurn("There's a 3 second pause at the start."),
    ]);

    const r = await runAgent({
      userPrompt: "is there dead air at the start?",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
      registry,
    });

    assert.equal(r.isError, false);
    assert.deepEqual(called, ['detect_silence:{"sourceId":"s1"}']);
  });

  test("silence-driven plan: detect_silence then trim at the silence boundary", async () => {
    const { session, clipId } = makeSession();
    const { registry, called } = registryWithMockedAudio({
      silences: {
        sourceId: "s1",
        silences: [{ start: 0, end: 3, duration: 3 }],
        minDuration: 0.5,
        thresholdDb: -35,
        hasAudio: true,
        cached: false,
      },
    });

    const provider = mockProvider([
      toolUse("detect_silence", { sourceId: "s1" }, "tu_ds"),
      // The cut lands on the silence boundary (3), not a guess.
      toolUse("propose_edit_plan", {
        summary: "Trim the 3s of dead air at the start.",
        operations: [{ type: "trim", clipId, inPoint: 3, outPoint: 120 }],
      }, "tu_plan"),
      endTurn("Done."),
    ]);

    const r = await runAgent({
      userPrompt: "cut the long pause before I start talking",
      session,
      messages: [],
      autoApprove: true,
      confirm: noConfirm(),
      provider,
      registry,
    });

    assert.equal(r.isError, false);
    assert.equal(called.length, 1, "detect_silence ran once");

    // The trim landed on the boundary the tool reported.
    const updated = clipsInOrder(r.session.state.timeline)[0]!;
    assert.equal(updated.inPoint, 3);

    // One undo entry for the whole turn, labeled with the user's own words.
    assert.equal(r.session.undo.length, 1);
    assert.equal(r.session.undo[0]!.label, "cut the long pause before I start talking");
  });

  test("a transcript-driven cut applies at a segment boundary", async () => {
    const { session, clipId } = makeSession();
    const { registry } = registryWithMockedAudio({
      transcript: {
        sourceId: "s1",
        segments: [{ start: 7, end: 11, text: "The price is forty nine dollars a month." }],
        totalSegments: 5,
        transcriptDuration: 20,
        truncated: false,
        hasAudio: true,
        cached: false,
      },
    });

    const provider = mockProvider([
      toolUse("transcribe_audio", { sourceId: "s1", query: "price" }, "tu_ta"),
      toolUse("propose_edit_plan", {
        summary: "Trim to where the price is mentioned.",
        operations: [{ type: "trim", clipId, inPoint: 7, outPoint: 120 }],
      }, "tu_plan"),
      endTurn("Trimmed to the pricing mention."),
    ]);

    const r = await runAgent({
      userPrompt: "trim to where I mention the price",
      session,
      messages: [],
      autoApprove: true,
      confirm: noConfirm(),
      provider,
      registry,
    });

    assert.equal(r.isError, false);
    // 7 is the segment start the tool reported — not mid-word.
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 7);
    assert.equal(r.session.undo.length, 1);
  });

  test("a no-audio tool_result is a normal turn, not an error", async () => {
    const { session } = makeSession();
    const { registry } = registryWithMockedAudio({
      transcript: {
        sourceId: "s1", segments: [], totalSegments: 0, transcriptDuration: 0,
        truncated: false, hasAudio: false, cached: false,
        note: "a.mp4 has no audio track — there is nothing to transcribe.",
      },
    });

    const provider = mockProvider([
      toolUse("transcribe_audio", { sourceId: "s1", query: "price" }, "tu_ta"),
      endTurn("That clip has no audio track, so I can't find spoken content in it."),
    ]);

    const r = await runAgent({
      userPrompt: "trim to where I mention the price",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      provider,
      registry,
    });

    assert.equal(r.isError, false, "no audio is a normal answer, not a failure");
    assert.match(r.output, /no audio track/);
    assert.equal(r.session.undo.length, 0, "nothing was applied");
  });
});

// ── Narrative planning via survey_sources (3E-3) ──────────────────────────────
//
// The director loop is UNCHANGED by 3E-3: survey_sources dispatches through the
// registry like any other tool, and a narrative plan is one propose_edit_plan
// with many operations. These tests mock survey_sources at the registry seam so
// the director's own behaviour is what's exercised (the fan-out is tested in
// survey-sources.test.ts).

const SURVEY_SCHEMA: ToolSchema = {
  name: "survey_sources",
  description: "mock",
  input_schema: { type: "object", properties: {} },
};

function registryWithMockedSurvey(map: ContentMap) {
  const calls: unknown[] = [];
  const registry = buildDefaultRegistry();
  registry.registerDirectorTool({
    schema: SURVEY_SCHEMA,
    execute: async (_state, input) => { calls.push(input); return { ok: true, result: map }; },
  });
  return { registry, calls };
}

function cannedMap(sourceId: string): ContentMap {
  return {
    sources: [{
      sourceId, displayRef: "1", duration: 120,
      outline: [{ start: 0, end: 4, gist: "flat intro" }, { start: 4, end: 120, gist: "the good part" }],
      keyMoments: [{ time: 4, gist: "strongest moment" }],
    }],
    truncated: false,
  };
}

describe("runAgent — narrative planning", () => {
  test("survey_sources → multi-op propose_edit_plan applies as ONE undo entry", async () => {
    const { session, clipId } = makeSession();
    const { registry, calls } = registryWithMockedSurvey(cannedMap(session.state.sources[0]!.id));

    const provider = mockProvider([
      toolUse("survey_sources", {}, "tu_survey"),
      // A narrative plan: several operations in ONE propose_edit_plan call.
      toolUse("propose_edit_plan", {
        summary: "Open on the strongest moment and tighten.",
        operations: [
          { type: "trim", clipId, inPoint: 4, outPoint: 34 },
        ],
      }, "tu_plan"),
      endTurn("Tightened to 30s opening on the strongest moment."),
    ]);

    const r = await runAgent({
      userPrompt: "tighten this to about 30 seconds, open on the strongest moment, cut anything flat",
      session,
      messages: [],
      autoApprove: true,
      confirm: noConfirm(),
      provider,
      registry,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 1, "survey_sources was called once");
    // One undo entry for the whole narrative plan, labeled with the user's words.
    assert.equal(r.session.undo.length, 1);
    assert.equal(r.session.undo[0]!.label, "tighten this to about 30 seconds, open on the strongest moment, cut anything flat");
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 4);
  });

  test("the plan is submitted after the survey result is in history", async () => {
    const { session, clipId } = makeSession();
    const { registry } = registryWithMockedSurvey(cannedMap(session.state.sources[0]!.id));

    const provider = mockProvider([
      toolUse("survey_sources", {}, "tu_survey"),
      toolUse("propose_edit_plan", {
        summary: "Trim.",
        operations: [{ type: "trim", clipId, inPoint: 4, outPoint: 34 }],
      }, "tu_plan"),
      endTurn("Done."),
    ]);

    const r = await runAgent({
      userPrompt: "tighten and open strong",
      session, messages: [], autoApprove: true, confirm: noConfirm(), provider, registry,
    });

    assert.equal(r.isError, false);
    // History contains the survey tool_result before the applied plan's result.
    const flat = r.messages.flatMap((m) => m.content.map((b) => b.type + (b.type === "tool_use" ? `:${(b as { name: string }).name}` : "")));
    const surveyIdx = flat.indexOf("tool_use:survey_sources");
    const planIdx = flat.indexOf("tool_use:propose_edit_plan");
    assert.ok(surveyIdx >= 0 && planIdx >= 0 && surveyIdx < planIdx, "survey precedes the plan in history");
  });

  test("a /label'd clip is visible to the director and can be targeted", async () => {
    const { session, clipId } = makeSession();
    // User labels the clip; the plan then targets it by id.
    const labeled = setClipUserLabel(session.state, clipId, "good take");
    assert.ok(labeled.ok);
    const labeledSession = { ...session, state: labeled.state };

    // The label is surfaced through query_timeline — the director's channel for it.
    const q = await queryTimeline.execute(labeled.state, {});
    assert.ok(q.ok);
    assert.equal(q.result.clips[0]!.userLabel, "good take");

    const provider = mockProvider([
      toolUse("propose_edit_plan", {
        summary: "Use the good take as the opener.",
        operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }],
      }, "tu_plan"),
      endTurn("Opened on the good take."),
    ]);

    const r = await runAgent({
      userPrompt: "use the good take as the opener",
      session: labeledSession, messages: [], autoApprove: true, confirm: noConfirm(), provider,
    });

    assert.equal(r.isError, false);
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 30);
    // The label survives the edit (trim keeps it).
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.userLabel, "good take");
  });
});

// ── Streaming (3E-4) ──────────────────────────────────────────────────────────
//
// Streaming is a rendering change, not a behavior change: the same tool calls,
// plans, and writes happen in the same order. These tests assert the deltas
// reach the progress channel and that a streamed plan still flows through the
// confirm gate to a single applied undo entry.

describe("runAgent — streaming", () => {
  test("thinking and text deltas reach the progress channel in order", async () => {
    const { session } = makeSession();
    const provider = mockProvider([
      {
        content: [
          { type: "reasoning", provider: "anthropic", opaque: { type: "thinking", thinking: "Let me look.", signature: "s" }, text: "Let me look." },
          { type: "text", text: "Here is what I found." },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);

    const ordered: string[] = [];
    const r = await runAgent({
      userPrompt: "hi", session, messages: [], autoApprove: false, confirm: noConfirm(),
      onProgress: (e) => ordered.push(e.type), provider,
    });

    assert.equal(r.isError, false);
    const think = ordered.indexOf("thinking_delta");
    const text = ordered.indexOf("text_delta");
    assert.ok(think >= 0 && text >= 0, "both deltas forwarded");
    assert.ok(think < text, "thinking streams before the answer text");
    // The final committed output still has the full text (assembled response).
    assert.match(r.output, /what I found/);
  });

  test("a tool_use_start indicator is forwarded before the tool is dispatched", async () => {
    const { session } = makeSession();
    const provider = mockProvider([
      toolUse("query_timeline", {}, "tu_qt"),
      endTurn("One clip."),
    ]);

    const ordered: string[] = [];
    await runAgent({
      userPrompt: "what's here?", session, messages: [], autoApprove: false, confirm: noConfirm(),
      onProgress: (e) => ordered.push(e.type), provider,
    });

    const start = ordered.indexOf("tool_use_start");
    const call = ordered.indexOf("tool_call");
    assert.ok(start >= 0 && call >= 0 && start < call, "tool_use_start precedes tool_call dispatch");
  });

  test("stream → confirm → resume: a streamed plan applies as one undo entry after approval", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", {
        summary: "Trim.",
        operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }],
      }, "tu_plan"),
      endTurn("Applied the trim."),   // the resumed turn streams after approval
    ]);

    let confirmCalls = 0;
    const events: string[] = [];
    const r = await runAgent({
      userPrompt: "trim to 30s",
      session,
      messages: [],
      autoApprove: false,                       // force the confirm gate
      confirm: async () => { confirmCalls++; return { approved: true }; },
      onProgress: (e) => events.push(e.type),
      provider,
    });

    assert.equal(r.isError, false);
    assert.equal(confirmCalls, 1, "the confirm gate fired once, between turns");
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 30);
    assert.equal(r.session.undo.length, 1, "one undo entry for the applied plan");
    // The resumed turn streamed its text.
    assert.ok(events.filter((e) => e === "text_delta").length >= 1, "the post-approval turn streamed");
  });
});

// ── Critic loop (3G) ──────────────────────────────────────────────────────────
//
// The critic reviews a drafted COMPOUND plan before the user sees it. These
// tests inject the critic at the seam runAgent exposes (`critic`), so the
// bounded cycle in the loop is what's exercised; the critic's own provider
// interaction is tested in critic.test.ts. Decision 1's invariant recurs
// throughout: confirm() fires exactly once per turn — draft-then-revision
// churn never reaches the gate.

function criticStub(verdicts: CriticVerdict[]) {
  const calls: CriticInput[] = [];
  let i = 0;
  return {
    calls,
    critic: async (input: CriticInput): Promise<CriticVerdict> => {
      calls.push(input);
      return verdicts[Math.min(i++, verdicts.length - 1)]!;
    },
  };
}

// A compound (3-op) plan on the standard 120s clip. All ops reference the
// original clip id, so they validate and apply in sequence.
function compoundPlanOps(clipId: string, outPoint = 60, splitPoint = 20) {
  return [
    { type: "trim", clipId, inPoint: 0, outPoint },
    { type: "split", clipId, splitPoint },
    { type: "move", clipId, newIndex: 1 },
  ];
}

const REVISE_ONCE: CriticVerdict = {
  verdict: "revise",
  concerns: [
    { severity: "major", operationIndex: 1, issue: "Split lands mid-word; the map's silence boundary is at 30s." },
    { severity: "minor", issue: "Resulting duration misses the stated target." },
  ],
};
const APPROVE: CriticVerdict = { verdict: "approve", concerns: [] };

describe("runAgent — critic (3G)", () => {
  test("approve path: compound plan → critic approves → confirm once → applied as one undo entry", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", { summary: "Tighten.", operations: compoundPlanOps(clipId) }, "tu_plan"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([APPROVE]);

    let confirmCalls = 0;
    const events: string[] = [];
    const r = await runAgent({
      userPrompt: "tighten this up",
      session, messages: [], autoApprove: false,
      confirm: async () => { confirmCalls++; return { approved: true }; },
      onProgress: (e) => events.push(e.type),
      provider, critic,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 1, "the critic reviewed the draft once");
    assert.equal(confirmCalls, 1, "confirm fired exactly once");
    assert.equal(r.session.undo.length, 1, "one undo entry for the whole plan");
    assert.equal(clipsInOrder(r.session.state.timeline).length, 2, "the split applied");
    // The critic saw the request and the rendered plan — and got no survey map
    // because none was taken this turn.
    assert.equal(calls[0]!.userRequest, "tighten this up");
    assert.equal(calls[0]!.renderedPlan.length, 3);
    assert.equal(calls[0]!.contentMap, null);
    // The pass surfaced on the progress channel.
    assert.ok(events.includes("critic_start"));
    assert.ok(events.includes("critic_verdict"));
  });

  test("revise path: concerns go back as a tool_result, the director re-proposes, the user confirms the REVISED plan once", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", { summary: "Draft.", operations: compoundPlanOps(clipId, 50, 20) }, "tu_plan1"),
      toolUse("propose_edit_plan", { summary: "Revised.", operations: compoundPlanOps(clipId, 60, 30) }, "tu_plan2"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([REVISE_ONCE, APPROVE]);

    const confirmedPlans: PlanForConfirmation[] = [];
    const r = await runAgent({
      userPrompt: "tighten this up",
      session, messages: [], autoApprove: false,
      confirm: async (plan) => { confirmedPlans.push(plan); return { approved: true }; },
      provider, critic,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 2, "draft reviewed, then the revision reviewed");
    assert.equal(confirmedPlans.length, 1, "confirm fired exactly once — no draft churn at the gate");
    // The plan the user saw is the REVISED one.
    assert.equal(confirmedPlans[0]!.summary, "Revised.");
    assert.equal(confirmedPlans[0]!.outstandingConcerns, undefined, "an approved revision carries no concerns");
    // The structured concerns went back to the director as a tool_result.
    const feedback = r.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => String((b as { content: unknown }).content))
      .find((c) => c.includes('"status":"revise"'));
    assert.ok(feedback, "revise feedback present in history");
    assert.match(feedback!, /mid-word/);
    // The REVISED plan applied: split at 30 then move → first clip starts at 30.
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 30);
    assert.equal(r.session.undo.length, 1);
  });

  test("cap exhaustion: an always-revise critic gets exactly 2 revisions, then the plan is presented with concerns attached", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", { summary: "Draft 1.", operations: compoundPlanOps(clipId, 50, 20) }, "tu_p1"),
      toolUse("propose_edit_plan", { summary: "Draft 2.", operations: compoundPlanOps(clipId, 55, 25) }, "tu_p2"),
      toolUse("propose_edit_plan", { summary: "Draft 3.", operations: compoundPlanOps(clipId, 45, 15) }, "tu_p3"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([REVISE_ONCE]); // revises forever

    const confirmedPlans: PlanForConfirmation[] = [];
    const r = await runAgent({
      userPrompt: "tighten this up",
      session, messages: [], autoApprove: false,
      confirm: async (plan) => { confirmedPlans.push(plan); return { approved: true }; },
      provider, critic,
    });

    assert.equal(r.isError, false);
    // draft + 2 revisions = 3 reviews; MAX_CRITIC_REVISIONS bounds the cycle.
    assert.equal(calls.length, MAX_CRITIC_REVISIONS + 1);
    assert.equal(confirmedPlans.length, 1, "confirm still fired exactly once");
    // The final plan carries the outstanding concerns for the user to arbitrate.
    assert.equal(confirmedPlans[0]!.summary, "Draft 3.");
    assert.equal(confirmedPlans[0]!.outstandingConcerns?.length, 2);
    // The user approved it anyway → applied (split at 15, moved).
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 15);
    assert.equal(r.session.undo.length, 1);
  });

  test("threshold: a single-op plan skips the critic entirely", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", {
        summary: "Trim.",
        operations: [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }],
      }, "tu_plan"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([APPROVE]);

    let confirmCalls = 0;
    const r = await runAgent({
      userPrompt: "trim to 30s",
      session, messages: [], autoApprove: false,
      confirm: async () => { confirmCalls++; return { approved: true }; },
      provider, critic,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 0, "single-op edits are never reviewed");
    assert.equal(confirmCalls, 1);
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 30);
  });

  test("threshold: a 2-op plan without a survey skips; the same size AFTER survey_sources is reviewed with the map", async () => {
    // Without survey: 2 ops → skip.
    {
      const { session, clipId } = makeSession();
      const provider = mockProvider([
        toolUse("propose_edit_plan", {
          summary: "Trim and split.",
          operations: [
            { type: "trim", clipId, inPoint: 0, outPoint: 60 },
            { type: "split", clipId, splitPoint: 20 },
          ],
        }, "tu_plan"),
        endTurn("Done."),
      ]);
      const { critic, calls } = criticStub([APPROVE]);
      const r = await runAgent({
        userPrompt: "trim and split",
        session, messages: [], autoApprove: true, confirm: noConfirm(), provider, critic,
      });
      assert.equal(r.isError, false);
      assert.equal(calls.length, 0, "2 ops with no survey stays under the threshold");
    }

    // After survey: the same 2-op plan is a narrative edit → reviewed, and the
    // critic gets the survey's map.
    {
      const { session, clipId } = makeSession();
      const map = cannedMap(session.state.sources[0]!.id);
      const { registry } = registryWithMockedSurvey(map);
      const provider = mockProvider([
        toolUse("survey_sources", {}, "tu_survey"),
        toolUse("propose_edit_plan", {
          summary: "Open strong and tighten.",
          operations: [
            { type: "trim", clipId, inPoint: 4, outPoint: 34 },
            { type: "split", clipId, splitPoint: 20 },
          ],
        }, "tu_plan"),
        endTurn("Done."),
      ]);
      const { critic, calls } = criticStub([APPROVE]);
      const r = await runAgent({
        userPrompt: "tighten and open strong",
        session, messages: [], autoApprove: true, confirm: noConfirm(), provider, registry, critic,
      });
      assert.equal(r.isError, false);
      assert.equal(calls.length, 1, "a multi-op plan after a survey is reviewed");
      assert.deepEqual(calls[0]!.contentMap, map, "the critic sees the survey's map");
    }
  });

  test("/critic off: the critic never runs and behavior is identical to pre-slice", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", { summary: "Tighten.", operations: compoundPlanOps(clipId) }, "tu_plan"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([REVISE_ONCE]);

    let confirmCalls = 0;
    const r = await runAgent({
      userPrompt: "tighten this up",
      session, messages: [], autoApprove: false,
      criticEnabled: false,
      confirm: async () => { confirmCalls++; return { approved: true }; },
      provider, critic,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 0, "critic disabled → never invoked");
    assert.equal(confirmCalls, 1);
    assert.equal(r.session.undo.length, 1);
  });

  test("revision rounds respect the per-turn tool budget: with no budget left, present instead of revising", async () => {
    const { session, clipId } = makeSession();
    // Burn the budget down to 1 with 39 query_timeline calls (budget 40), then propose:
    // the plan call takes the last budget unit, so a revise verdict cannot be
    // sent back for a re-proposal — the plan is presented with concerns.
    const burn: ChatResponse[] = Array.from({ length: 39 }, (_, i) =>
      toolUse("query_timeline", {}, `tu_q${i}`),
    );
    const provider = mockProvider([
      ...burn,
      toolUse("propose_edit_plan", { summary: "Tighten.", operations: compoundPlanOps(clipId) }, "tu_plan"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([REVISE_ONCE]);

    const confirmedPlans: PlanForConfirmation[] = [];
    const r = await runAgent({
      userPrompt: "tighten this up",
      session, messages: [], autoApprove: false,
      confirm: async (plan) => { confirmedPlans.push(plan); return { approved: true }; },
      provider, critic,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 1, "reviewed once; no budget for a revision round");
    assert.equal(confirmedPlans.length, 1);
    assert.equal(confirmedPlans[0]!.outstandingConcerns?.length, 2, "concerns attached instead of revising");
    assert.equal(r.session.undo.length, 1, "the approved plan still applied");
  });

  test("auto-approve still gets the critic pass on compound plans (review is about the plan, not the gate)", async () => {
    const { session, clipId } = makeSession();
    const provider = mockProvider([
      toolUse("propose_edit_plan", { summary: "Draft.", operations: compoundPlanOps(clipId, 50, 20) }, "tu_p1"),
      toolUse("propose_edit_plan", { summary: "Revised.", operations: compoundPlanOps(clipId, 60, 30) }, "tu_p2"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([REVISE_ONCE, APPROVE]);

    const r = await runAgent({
      userPrompt: "tighten this up",
      session, messages: [], autoApprove: true, confirm: noConfirm(), provider, critic,
    });

    assert.equal(r.isError, false);
    assert.equal(calls.length, 2, "reviewed, revised, re-reviewed under auto-approve");
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 30, "the revised plan applied");
    assert.equal(r.session.undo.length, 1);
  });
});

// ── Critic evidence ───────────────────────────────────────────────────────────

describe("runAgent — the critic sees the director's perception evidence", () => {
  test("a transcript lookup this turn reaches the critic with exact times; non-perception calls don't", async () => {
    const { session, clipId } = makeSession();
    // Cache a transcript so the real transcribe_audio tool answers offline.
    const src = session.state.sources[0]!;
    const withTranscript = {
      ...session,
      state: {
        ...session.state,
        sources: [{
          ...src,
          analyses: {
            ...src.analyses,
            transcript: {
              segments: [
                { start: 48.3, end: 49.44, text: "That's a new place." },
                { start: 49.98, end: 51.84, text: "I'd like to check with Jay before booking the ride." },
              ],
              duration: 120, model: "test", hasAudio: true, transcribedAt: "x",
            },
          },
        }],
      },
    };
    const provider = mockProvider([
      toolUse("transcribe_audio", { sourceId: src.id, query: "new place check" }, "tu_t"),
      toolUse("query_timeline", {}, "tu_q"),
      toolUse("propose_edit_plan", { summary: "Tighten.", operations: compoundPlanOps(clipId) }, "tu_plan"),
      endTurn("Done."),
    ]);
    const { critic, calls } = criticStub([APPROVE]);

    await runAgent({
      userPrompt: "cut after the new-place line",
      session: withTranscript, messages: [], autoApprove: true,
      confirm: async () => ({ approved: true }),
      provider, critic,
    });

    assert.equal(calls.length, 1);
    const evidence = calls[0]!.evidence ?? [];
    assert.equal(evidence.length, 1, "only the perception call is evidence");
    assert.equal(evidence[0]!.tool, "transcribe_audio");
    assert.equal(evidence[0]!.source, src.fileName);
    assert.deepEqual(evidence[0]!.input, { query: "new place check" });
    const lines = (evidence[0]!.result as { lines: string[] }).lines;
    assert.ok(lines.includes("49.98–51.84 I'd like to check with Jay before booking the ride."), "exact transcript times reach the critic");
  });
});

// ── Concurrent reads in one turn ──────────────────────────────────────────────

import { buildDefaultRegistry as buildRegistryForConcurrency } from "../agent/registry.js";

describe("runAgent — reads in one turn run concurrently", () => {
  test("both start before either ends; both cache writes and both results survive, in request order", async () => {
    const { session } = makeSession();
    const sourceId = session.state.sources[0]!.id;
    const registry = buildRegistryForConcurrency();
    const log: string[] = [];
    const slow = (name: string, key: "scenes" | "description") => ({
      schema: { name, description: name, input_schema: { type: "object" as const, properties: {} } },
      execute: async (st: ProjectState) => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 25));
        log.push(`end ${name}`);
        const value = key === "scenes" ? { threshold: 0.4, boundaries: [1], detectedAt: "x" } : { text: "d", model: "m", generatedAt: "x" };
        return {
          ok: true as const,
          result: { from: name },
          stateUpdate: { ...st, sources: st.sources.map((x) => (x.id === sourceId ? { ...x, analyses: { ...x.analyses, [key]: value } } : x)) },
        };
      },
    });
    registry.register(slow("detect_scenes", "scenes"));
    registry.register(slow("describe_clip", "description"));

    const twoReads: ChatResponse = {
      content: [
        { type: "tool_use", id: "a", name: "detect_scenes", input: { sourceId } },
        { type: "tool_use", id: "b", name: "describe_clip", input: { sourceId } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    const r = await runAgent({
      userPrompt: "look", session, messages: [], autoApprove: true,
      confirm: async () => ({ approved: true }), provider: mockProvider([twoReads, endTurn("ok")]), registry,
    });
    assert.equal(r.isError, false, r.output);
    assert.deepEqual(log.slice(0, 2).sort(), ["start describe_clip", "start detect_scenes"], "both started before either ended");
    const a = r.session.state.sources[0]!.analyses;
    assert.ok(a.scenes && a.description, "both cache writes kept");
    const results = r.messages.find((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"))!;
    assert.deepEqual(results.content.map((b) => (b.type === "tool_result" ? b.toolUseId : "")), ["a", "b"]);
  });
});

describe("runAgent — tool budget warning", () => {
  test("with 5 calls left the agent is told to propose now, once per read round", async () => {
    const { session } = makeSession();
    const reads: ChatResponse[] = Array.from({ length: 35 }, (_, i) => toolUse("query_timeline", {}, `q${i}`));
    const { provider, requests } = capturingProvider([...reads, endTurn("ok")]);
    await runAgent({ userPrompt: "look", session, messages: [], autoApprove: true, confirm: async () => ({ approved: true }), provider });
    const lastUser = (i: number) => requests[i]!.messages[requests[i]!.messages.length - 1]!;
    const hasNudge = (i: number) => lastUser(i).content.some((b) => b.type === "text" && /tool calls? left this turn/.test(b.text));
    assert.equal(hasNudge(34), false, "30 left: no warning");
    assert.equal(hasNudge(35), true, "5 left: warned");
    assert.match((lastUser(35).content.find((b) => b.type === "text") as { text: string }).text, /Only 5 tool calls left/);
  });
});

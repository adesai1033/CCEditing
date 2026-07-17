import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import { runAgent, type AnthropicLike } from "../agent/loop.js";
import { buildDefaultRegistry } from "../agent/registry.js";
import { transcribeAudio } from "../agent/tools/transcribe_audio.js";
import { detectSilence } from "../agent/tools/detect_silence.js";
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

// A tiny mock Anthropic client that returns canned responses, one per call.
function mockClient(responses: Anthropic.Messages.Message[]): AnthropicLike {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const r = responses[i++];
        if (!r) throw new Error(`mockClient exhausted at call ${i}`);
        return r;
      },
    },
  };
}

function endTurn(text: string): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Messages.Message;
}

function toolUse(name: string, input: unknown, id = "tu_1"): Anthropic.Messages.Message {
  return {
    id: "msg_tu",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Messages.Message;
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
    const client = mockClient([
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
      client,
    });

    assert.equal(r.isError, false);
    assert.match(r.output, /one clip/);
    assert.ok(events.includes("tool_call"));
    assert.ok(events.includes("tool_result"));
    assert.ok(events.includes("assistant_text"));
  });

  test("multi-turn: second runAgent call sees prior messages", async () => {
    const { session } = makeSession();
    const client = mockClient([endTurn("OK.")]);

    const r = await runAgent({
      userPrompt: "second prompt",
      session,
      messages: [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: [{ type: "text", text: "first reply" }] as unknown as string },
      ],
      autoApprove: false,
      confirm: noConfirm(),
      client,
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
    const client = mockClient([
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
      client,
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
    const client = mockClient([
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
      client,
    });

    assert.equal(r.isError, false);
    // No state change
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.outPoint, 120);
    assert.equal(r.session.undo.length, 0);
    assert.match(r.output, /rejected/i);
  });

  test("applyPlan fails: tool_result has is_error, agent continues and ends", async () => {
    const { session, clipId } = makeSession();
    const client = mockClient([
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
      client,
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
    const client = mockClient([
      toolUse("does_not_exist", {}, "tu_bad"),
      endTurn("I'll stop."),
    ]);

    const r = await runAgent({
      userPrompt: "do something weird",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      client,
    });

    assert.equal(r.isError, false);
    assert.match(r.output, /I'll stop/);
  });

  test("API error surfaces as friendly output", async () => {
    const { session } = makeSession();
    const client: AnthropicLike = {
      messages: {
        create: async () => { throw new Error("rate limited"); },
      },
    };

    const r = await runAgent({
      userPrompt: "hi",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      client,
    });

    assert.equal(r.isError, true);
    assert.match(r.output, /rate limited/);
  });
});

// ── Thinking-block tolerance ──────────────────────────────────────────────────

describe("runAgent — extended-thinking tolerance", () => {
  test("assistant turn with a thinking block alongside tool_use is handled without error", async () => {
    const { session } = makeSession();
    // Canned response with a `thinking` block + `tool_use` block (decision 11).
    const withThinking = {
      id: "msg_think",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: "Let me see the timeline first.", signature: "sig" },
        { type: "tool_use", id: "tu_qt2", name: "query_timeline", input: {} },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
    } as unknown as Anthropic.Messages.Message;
    const client = mockClient([withThinking, endTurn("One clip.")]);

    const r = await runAgent({
      userPrompt: "describe the timeline",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      client,
    });

    assert.equal(r.isError, false);
    // The thinking block is preserved in messages, not stripped
    const assistantTurn = r.messages.find((m) => m.role === "assistant" && Array.isArray(m.content));
    assert.ok(assistantTurn);
    const content = assistantTurn.content as Array<{ type: string }>;
    assert.ok(content.some((b) => b.type === "thinking"));
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

    const client = mockClient([
      toolUse("transcribe_audio", { sourceId: "s1", query: "price" }, "tu_ta"),
      endTurn("You mention the price at 0:07."),
    ]);

    const r = await runAgent({
      userPrompt: "where do I mention the price?",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      client,
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

    const client = mockClient([
      toolUse("detect_silence", { sourceId: "s1" }, "tu_ds"),
      endTurn("There's a 3 second pause at the start."),
    ]);

    const r = await runAgent({
      userPrompt: "is there dead air at the start?",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      client,
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

    const client = mockClient([
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
      client,
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

    const client = mockClient([
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
      client,
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

    const client = mockClient([
      toolUse("transcribe_audio", { sourceId: "s1", query: "price" }, "tu_ta"),
      endTurn("That clip has no audio track, so I can't find spoken content in it."),
    ]);

    const r = await runAgent({
      userPrompt: "trim to where I mention the price",
      session,
      messages: [],
      autoApprove: false,
      confirm: noConfirm(),
      client,
      registry,
    });

    assert.equal(r.isError, false, "no audio is a normal answer, not a failure");
    assert.match(r.output, /no audio track/);
    assert.equal(r.session.undo.length, 0, "nothing was applied");
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import { runAgent, type AnthropicLike } from "../agent/loop.js";
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

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import { AnthropicProvider, MODEL_DEFAULT, type AnthropicClientLike } from "../agent/providers/anthropic.js";
import type { ChatRequest, NeutralMessage } from "../agent/providers/types.js";
import type { ToolSchema } from "../agent/types.js";

// ── Capturing mock SDK client ─────────────────────────────────────────────────
//
// Records the params `send()` passes to messages.create and returns a canned
// response. Lets us assert both directions of translation at the seam.

function capturingClient(response: Anthropic.Messages.Message): {
  client: AnthropicClientLike;
  lastParams: () => Anthropic.Messages.MessageCreateParamsNonStreaming;
} {
  let captured: Anthropic.Messages.MessageCreateParamsNonStreaming | undefined;
  return {
    client: {
      messages: {
        create: async (params) => {
          captured = params;
          return response;
        },
        stream: () => { throw new Error("stream not used in this test"); },
      },
    },
    lastParams: () => {
      if (!captured) throw new Error("create was never called");
      return captured;
    },
  };
}

// A client whose messages.stream() yields canned raw SSE events and resolves a
// canned assembled final message — the two halves the provider must reconcile.
function streamingClient(rawEvents: unknown[], finalMsg: Anthropic.Messages.Message): {
  client: AnthropicClientLike;
  lastParams: () => Anthropic.Messages.MessageStreamParams;
} {
  let captured: Anthropic.Messages.MessageStreamParams | undefined;
  return {
    client: {
      messages: {
        create: async () => { throw new Error("create not used in this test"); },
        stream: (params) => {
          captured = params;
          return {
            async *[Symbol.asyncIterator]() {
              for (const ev of rawEvents) yield ev as Anthropic.Messages.RawMessageStreamEvent;
            },
            async finalMessage() { return finalMsg; },
          };
        },
      },
    },
    lastParams: () => {
      if (!captured) throw new Error("stream was never called");
      return captured;
    },
  };
}

// Raw SSE event fixtures (loosely typed — the provider only reads a few fields).
function evTextDelta(text: string): unknown { return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }; }
function evThinkingDelta(thinking: string): unknown { return { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }; }
function evToolStart(name: string): unknown { return { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu", name, input: {} } }; }
function evStop(stopReason: string): unknown[] { return [{ type: "message_delta", delta: { stop_reason: stopReason }, usage: {} }, { type: "message_stop" }]; }

function anthropicMessage(
  content: unknown[],
  stopReason: Anthropic.Messages.Message["stop_reason"],
  usage: Partial<Anthropic.Messages.Usage> = {},
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL_DEFAULT,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: null, service_tier: null,
      ...usage,
    },
  } as unknown as Anthropic.Messages.Message;
}

const TOOLS: ToolSchema[] = [
  {
    name: "query_timeline",
    description: "Inspect the timeline.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

function baseRequest(messages: NeutralMessage[]): ChatRequest {
  return { system: "You are an editor.", messages, tools: TOOLS, maxTokens: 4096 };
}

// ── Neutral request → Anthropic params ────────────────────────────────────────

describe("AnthropicProvider — request translation", () => {
  test("maps model, system, max_tokens, tools, and message shape", async () => {
    const { client, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "hi", citations: null }], "end_turn"));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    await provider.send(baseRequest([
      { role: "user", content: [{ type: "text", text: "what's on the timeline?" }] },
    ]));

    const p = lastParams();
    assert.equal(p.model, MODEL_DEFAULT);
    assert.equal(p.system, "You are an editor.");
    assert.equal(p.max_tokens, 4096);
    // Tool format: neutral ToolSchema → Anthropic { name, description, input_schema }
    assert.equal(p.tools?.length, 1);
    assert.equal(p.tools?.[0]?.name, "query_timeline");
    assert.ok((p.tools?.[0] as Anthropic.Messages.Tool).input_schema);
    // Message shape
    assert.equal(p.messages.length, 1);
    assert.equal(p.messages[0]?.role, "user");
    assert.deepEqual(p.messages[0]?.content, [{ type: "text", text: "what's on the timeline?" }]);
  });

  test("tool_use and tool_result blocks translate to Anthropic wire shape", async () => {
    const { client, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "ok", citations: null }], "end_turn"));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    await provider.send(baseRequest([
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "query_timeline", input: { a: 1 } }] },
      { role: "user", content: [
        { type: "tool_result", toolUseId: "tu_1", content: "{\"clips\":1}" },
        { type: "tool_result", toolUseId: "tu_1", content: "boom", isError: true },
      ] },
    ]));

    const p = lastParams();
    const toolUse = (p.messages[0]?.content as any[])[0];
    assert.deepEqual(toolUse, { type: "tool_use", id: "tu_1", name: "query_timeline", input: { a: 1 } });

    const results = p.messages[1]?.content as any[];
    // Success result: tool_use_id set, no is_error key (matches pre-slice shape).
    assert.equal(results[0].type, "tool_result");
    assert.equal(results[0].tool_use_id, "tu_1");
    assert.equal(results[0].content, "{\"clips\":1}");
    assert.ok(!("is_error" in results[0]));
    // Error result: is_error true.
    assert.equal(results[1].is_error, true);
  });
});

// ── Anthropic response → neutral ─────────────────────────────────────────────

describe("AnthropicProvider — response translation", () => {
  test("text and tool_use blocks map to neutral blocks", async () => {
    const { client } = capturingClient(anthropicMessage(
      [
        { type: "text", text: "Here is the plan.", citations: null },
        { type: "tool_use", id: "tu_9", name: "query_timeline", input: {} },
      ],
      "tool_use",
    ));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    const res = await provider.send(baseRequest([]));
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(res.content[0], { type: "text", text: "Here is the plan." });
    assert.deepEqual(res.content[1], { type: "tool_use", id: "tu_9", name: "query_timeline", input: {} });
  });

  test("stop_reason maps to neutral stop reasons, including max_output", async () => {
    const cases: Array<[Anthropic.Messages.Message["stop_reason"], string]> = [
      ["end_turn", "end_turn"],
      ["tool_use", "tool_use"],
      ["max_tokens", "max_output"],
      ["stop_sequence", "other"],
      [null, "other"],
    ];
    for (const [anthropicReason, expected] of cases) {
      const { client } = capturingClient(anthropicMessage([{ type: "text", text: "x", citations: null }], anthropicReason));
      const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });
      const res = await provider.send(baseRequest([]));
      assert.equal(res.stopReason, expected, `${anthropicReason} → ${expected}`);
    }
  });

  test("usage normalizes reasoningTokens from output_tokens_details.thinking_tokens", async () => {
    const withThinkingTokens = capturingClient(anthropicMessage(
      [{ type: "text", text: "x", citations: null }],
      "end_turn",
      { input_tokens: 100, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } as any },
    ));
    const p1 = new AnthropicProvider({ model: MODEL_DEFAULT, client: withThinkingTokens.client });
    const r1 = await p1.send(baseRequest([]));
    assert.equal(r1.usage.inputTokens, 100);
    assert.equal(r1.usage.outputTokens, 50);
    assert.equal(r1.usage.reasoningTokens, 20);

    // Absent when the vendor doesn't report it.
    const withoutDetails = capturingClient(anthropicMessage(
      [{ type: "text", text: "x", citations: null }],
      "end_turn",
      { input_tokens: 10, output_tokens: 5 },
    ));
    const p2 = new AnthropicProvider({ model: MODEL_DEFAULT, client: withoutDetails.client });
    const r2 = await p2.send(baseRequest([]));
    assert.equal(r2.usage.reasoningTokens, undefined);
  });
});

// ── Reasoning round-trip (define-now, exercise-now) ───────────────────────────
//
// Proves the exact path 3E-2.5 depends on, before 3E-2.5 exists: a thinking
// block survives response→neutral→request byte-identically, signature intact.

describe("AnthropicProvider — reasoning round-trip", () => {
  test("thinking block → neutral reasoning → back to a byte-identical thinking block", async () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "The user wants the intro trimmed; check the timeline first.",
      signature: "EqQBCkYIA...opaque-signature...==",
    };

    // 1. Response carrying a thinking block → neutral reasoning block.
    const { client } = capturingClient(anthropicMessage(
      [thinkingBlock, { type: "tool_use", id: "tu_1", name: "query_timeline", input: {} }],
      "tool_use",
    ));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });
    const res = await provider.send(baseRequest([]));

    const reasoning = res.content[0];
    assert.equal(reasoning?.type, "reasoning");
    assert.equal((reasoning as any).provider, "anthropic");
    // Opaque is the whole thinking block, intact; text mirrors the summary.
    assert.deepEqual((reasoning as any).opaque, thinkingBlock);
    assert.equal((reasoning as any).text, thinkingBlock.thinking);

    // 2. Feed that neutral reasoning block back through a request — alongside a
    // text block and a tool_use block, the real multi-block assistant-turn shape.
    const { client: client2, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "done", citations: null }], "end_turn"));
    const provider2 = new AnthropicProvider({ model: MODEL_DEFAULT, client: client2 });
    await provider2.send(baseRequest([
      { role: "assistant", content: [
        reasoning!,
        { type: "text", text: "Let me check the timeline." },
        { type: "tool_use", id: "tu_1", name: "query_timeline", input: {} },
      ] },
    ]));

    // 3. The thinking block serializes back byte-identical, signature untouched,
    // and its siblings translate to their normal wire shapes in order.
    const outContent = lastParams().messages[0]?.content as any[];
    assert.deepEqual(outContent[0], thinkingBlock);
    assert.equal(outContent[0].signature, thinkingBlock.signature);
    assert.deepEqual(outContent[1], { type: "text", text: "Let me check the timeline." });
    assert.deepEqual(outContent[2], { type: "tool_use", id: "tu_1", name: "query_timeline", input: {} });
  });
});

// ── Reasoning config → adaptive thinking (3E-2.5) ─────────────────────────────

describe("AnthropicProvider — reasoning config mapping", () => {
  test("reasoning { enabled: true } → thinking adaptive + display summarized, no header, no budget", async () => {
    const { client, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "ok", citations: null }], "end_turn"));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    await provider.send({ ...baseRequest([]), reasoning: { enabled: true } });

    const p = lastParams() as any;
    assert.deepEqual(p.thinking, { type: "adaptive", display: "summarized" });
    // Adaptive uses no manual budget and needs no interleaved beta header.
    assert.ok(!("budget_tokens" in p.thinking), "adaptive must not carry a manual budget");
    assert.equal(p.output_config, undefined, "effort unset this slice → no output_config");
  });

  test("effort, when present, maps to output_config.effort (future-proofing)", async () => {
    const { client, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "ok", citations: null }], "end_turn"));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    await provider.send({ ...baseRequest([]), reasoning: { enabled: true, effort: "low" } });

    const p = lastParams() as any;
    assert.deepEqual(p.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(p.output_config, { effort: "low" });
  });

  test("reasoning absent or disabled → no thinking param", async () => {
    for (const reasoning of [undefined, { enabled: false } as const]) {
      const { client, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "ok", citations: null }], "end_turn"));
      const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });
      await provider.send({ ...baseRequest([]), reasoning });
      const p = lastParams() as any;
      assert.equal(p.thinking, undefined);
      assert.equal(p.output_config, undefined);
    }
  });

  test("a summarized-thinking response maps to a neutral reasoning block with text + opaque intact", async () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "Two ops: reorder then trim. Reorder first so indices stay valid.",
      signature: "sig-abc==",
    };
    const { client } = capturingClient(anthropicMessage(
      [
        thinkingBlock,
        { type: "text", text: "Here's the plan.", citations: null },
        { type: "tool_use", id: "tu_1", name: "query_timeline", input: {} },
      ],
      "tool_use",
    ));
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    const res = await provider.send({ ...baseRequest([]), reasoning: { enabled: true } });

    // Reasoning block: text populated from the summarized thinking, opaque intact.
    const reasoning = res.content[0] as any;
    assert.equal(reasoning.type, "reasoning");
    assert.equal(reasoning.provider, "anthropic");
    assert.equal(reasoning.text, thinkingBlock.thinking);
    assert.deepEqual(reasoning.opaque, thinkingBlock);
    // The text and tool_use blocks alongside it map normally.
    assert.deepEqual(res.content[1], { type: "text", text: "Here's the plan." });
    assert.deepEqual(res.content[2], { type: "tool_use", id: "tu_1", name: "query_timeline", input: {} });
  });
});

// ── Missing key → fail fast ───────────────────────────────────────────────────

describe("AnthropicProvider — key handling", () => {
  test("missing ANTHROPIC_API_KEY throws a friendly error", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      assert.throws(
        () => new AnthropicProvider(),
        /ANTHROPIC_API_KEY is not set/,
      );
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
});

// ── Streaming (3E-4) ──────────────────────────────────────────────────────────

describe("AnthropicProvider — stream()", () => {
  test("translates raw SSE events into neutral StreamEvents in order", async () => {
    const raw = [
      evThinkingDelta("Let me "), evThinkingDelta("think."),
      evTextDelta("Here "), evTextDelta("goes."),
      evToolStart("query_timeline"),
      ...evStop("tool_use"),
    ];
    const finalMsg = anthropicMessage([{ type: "text", text: "Here goes.", citations: null }], "tool_use");
    const { client } = streamingClient(raw, finalMsg);
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    const events: unknown[] = [];
    const handle = provider.stream(baseRequest([]));
    for await (const ev of handle) events.push(ev);

    assert.deepEqual(events, [
      { type: "thinking_delta", text: "Let me " },
      { type: "thinking_delta", text: "think." },
      { type: "text_delta", text: "Here " },
      { type: "text_delta", text: "goes." },
      { type: "tool_use_start", name: "query_timeline" },
      { type: "message_complete", stopReason: "tool_use" },
    ]);
    // Tool-use INPUT JSON is never surfaced as a stream event (decision 4).
    assert.ok(!events.some((e) => JSON.stringify(e).includes("input_json")));
  });

  test("the assembled final response is identical to block mode — thinking signature intact, round-trip survives", async () => {
    const thinkingBlock = { type: "thinking", thinking: "Plan it out.", signature: "sig-stream-xyz==" };
    // The final message carries a thinking block + a fully-assembled tool_use.
    const finalMsg = anthropicMessage(
      [thinkingBlock, { type: "tool_use", id: "tu_1", name: "query_timeline", input: { a: 1 } }],
      "tool_use",
    );
    const raw = [evThinkingDelta("Plan it out."), evToolStart("query_timeline"), ...evStop("tool_use")];
    const { client } = streamingClient(raw, finalMsg);
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    // Drain the stream, then take the assembled response.
    const handle = provider.stream(baseRequest([]));
    for await (const _ of handle) { /* consume */ }
    const res = await handle.finalResponse();

    // Same neutral shape send() would produce: reasoning block opaque intact + tool_use.
    const reasoning = res.content[0] as any;
    assert.equal(reasoning.type, "reasoning");
    assert.deepEqual(reasoning.opaque, thinkingBlock);
    assert.deepEqual(res.content[1], { type: "tool_use", id: "tu_1", name: "query_timeline", input: { a: 1 } });
    assert.equal(res.stopReason, "tool_use");

    // Feed the streamed reasoning block back through a request → byte-identical
    // thinking block, signature untouched (the 3E-2.5 round-trip survives streaming).
    const { client: c2, lastParams } = capturingClient(anthropicMessage([{ type: "text", text: "ok", citations: null }], "end_turn"));
    const provider2 = new AnthropicProvider({ model: MODEL_DEFAULT, client: c2 });
    await provider2.send(baseRequest([{ role: "assistant", content: [reasoning] }]));
    assert.deepEqual((lastParams().messages[0]?.content as any[])[0], thinkingBlock);
  });

  test("a streamed turn with no thinking block assembles cleanly", async () => {
    const finalMsg = anthropicMessage([{ type: "text", text: "Just text.", citations: null }], "end_turn");
    const { client } = streamingClient([evTextDelta("Just text."), ...evStop("end_turn")], finalMsg);
    const provider = new AnthropicProvider({ model: MODEL_DEFAULT, client });

    const handle = provider.stream(baseRequest([]));
    const seen: string[] = [];
    for await (const ev of handle) seen.push(ev.type);
    const res = await handle.finalResponse();

    assert.ok(!seen.includes("thinking_delta"), "no thinking streamed");
    assert.ok(!res.content.some((b) => b.type === "reasoning"), "no reasoning block assembled");
    assert.deepEqual(res.content[0], { type: "text", text: "Just text." });
    assert.equal(res.stopReason, "end_turn");
  });
});

import Anthropic from "@anthropic-ai/sdk";
import type { ToolSchema } from "../types.js";
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  NeutralMessage,
  NeutralStopReason,
  StreamEvent,
  StreamHandle,
} from "./types.js";

/**
 * The default Anthropic model. Single source of truth — imported, never
 * re-declared, so a stale copy can't report green while the app 404s. Lives
 * with the provider because the provider owns its model (loop no longer
 * hardcodes one). Routing across providers/models is 3E-9.
 */
export const MODEL_DEFAULT = "claude-sonnet-4-6";

const MISSING_KEY_MESSAGE =
  "ANTHROPIC_API_KEY is not set. Export it before running an agent turn (get one at https://console.anthropic.com).";

// A streamed turn from the SDK: async-iterable raw events plus the assembled
// final message. `client.messages.stream()` returns a MessageStream that
// satisfies this; tests supply a stand-in.
export interface AnthropicMessageStreamLike
  extends AsyncIterable<Anthropic.Messages.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Messages.Message>;
}

// Minimal surface of the Anthropic SDK we use, so tests can inject a mock
// without constructing a real client. The real client satisfies this trivially.
export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Messages.Message>;
    stream(
      params: Anthropic.Messages.MessageStreamParams,
    ): AnthropicMessageStreamLike;
  };
}

export interface AnthropicProviderOptions {
  /** Defaults to MODEL_DEFAULT. */
  model?: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY; fail-fast if absent. */
  apiKey?: string;
  /** Injected for tests. When present, apiKey is ignored (no real client built). */
  client?: AnthropicClientLike;
}

/**
 * The one and only Anthropic adapter. This file is the ONLY place
 * `@anthropic-ai/sdk` is imported anywhere under `src/agent/` — the loop and
 * the history layer speak the neutral dialect exclusively. `send()` translates
 * neutral → Anthropic wire params, calls the SDK, and translates the response
 * back to neutral.
 */
export class AnthropicProvider implements ChatProvider {
  private readonly model: string;
  private readonly client: AnthropicClientLike;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? MODEL_DEFAULT;
    if (opts.client) {
      this.client = opts.client;
    } else {
      // Fail-fast friendly error moved here from the loop (3E-1 behavior,
      // same message, same timing — thrown on first use of the default provider).
      const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
      this.client = new Anthropic({ apiKey });
    }
  }

  async send(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.messages.create(this.buildParams(request));
    return toNeutralResponse(response);
  }

  /**
   * Stream a turn. Iterates the SDK's raw stream events, translating them to
   * neutral `StreamEvent`s for display; `finalResponse()` returns the SDK's
   * ASSEMBLED message mapped through the SAME `toNeutralResponse` as `send()`.
   * Using the SDK's accumulation (not hand-rolled delta concatenation) is what
   * keeps thinking `signature` and tool-use input byte-identical, so the
   * multi-turn round-trip survives streaming (decision 2).
   */
  stream(request: ChatRequest): StreamHandle {
    const sdkStream = this.client.messages.stream(this.buildParams(request));
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        let stopReason: NeutralStopReason = "other";
        for await (const ev of sdkStream) {
          if (ev.type === "content_block_start") {
            // Surface only that a tool call is forming — never its input JSON.
            if (ev.content_block.type === "tool_use") {
              yield { type: "tool_use_start", name: ev.content_block.name };
            }
          } else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") {
              yield { type: "text_delta", text: ev.delta.text };
            } else if (ev.delta.type === "thinking_delta") {
              yield { type: "thinking_delta", text: ev.delta.thinking };
            }
            // input_json_delta / signature_delta are intentionally not surfaced.
          } else if (ev.type === "message_delta" && ev.delta.stop_reason) {
            stopReason = toNeutralStopReason(ev.delta.stop_reason);
          } else if (ev.type === "message_stop") {
            yield { type: "message_complete", stopReason };
          }
        }
      },
      async finalResponse(): Promise<ChatResponse> {
        return toNeutralResponse(await sdkStream.finalMessage());
      },
    };
  }

  private buildParams(request: ChatRequest): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: request.model ?? this.model,
      system: toAnthropicSystem(request.system),
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools.map(toAnthropicTool),
      max_tokens: request.maxTokens,
    };

    // Reasoning: neutral { enabled } → Anthropic adaptive thinking. Adaptive
    // auto-enables interleaved thinking (reasoning *between* tool calls) with
    // NO beta header and NO manual budget_tokens (deprecated). `display:
    // "summarized"` forces the summarized thinking text into the response so the
    // neutral reasoning block's `text` is populated regardless of the model's
    // default display (4.6 defaults summarized; newer models default omitted).
    if (request.reasoning?.enabled) {
      params.thinking = { type: "adaptive", display: "summarized" };
      // effort is unset this slice; mapped when present for future callers.
      // Anthropic reads effort from output_config, not the thinking object.
      if (request.reasoning.effort) {
        params.output_config = { effort: request.reasoning.effort };
      }
    }

    return params;
  }
}

// ── Neutral → Anthropic (request) ──────────────────────────────────────────────

/**
 * Neutral system → Anthropic system. Plain strings pass through untouched.
 * Segments become text blocks; a `cacheable` segment gets a `cache_control`
 * breakpoint, which caches the whole prefix up to and including that block —
 * the tools array included, since the vendor prefix order is tools → system →
 * messages. (Prefixes below the model's minimum cacheable length are silently
 * not cached; sonnet-4-6's minimum is 1024 tokens, and our static prefix plus
 * tool schemas clears it.)
 */
function toAnthropicSystem(
  system: ChatRequest["system"],
): string | Anthropic.Messages.TextBlockParam[] {
  if (typeof system === "string") return system;
  return system.map((seg) => ({
    type: "text",
    text: seg.text,
    ...(seg.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function toAnthropicMessage(m: NeutralMessage): Anthropic.Messages.MessageParam {
  return {
    role: m.role,
    content: m.content.map(toAnthropicBlock),
  };
}

function toAnthropicBlock(b: ContentBlock): Anthropic.Messages.ContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result": {
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content as Anthropic.Messages.ToolResultBlockParam["content"],
      };
      // Match pre-slice shape: `is_error` present only when true, omitted otherwise.
      if (b.isError) block.is_error = true;
      return block;
    }
    case "reasoning":
      // The opaque blob IS the original Anthropic thinking/redacted_thinking
      // block — handed back byte-identical, `signature` untouched. This is the
      // round-trip 3E-2.5 depends on.
      return b.opaque as Anthropic.Messages.ContentBlockParam;
  }
}

function toAnthropicTool(s: ToolSchema): Anthropic.Messages.Tool {
  return {
    name: s.name,
    description: s.description,
    input_schema: s.input_schema as Anthropic.Messages.Tool["input_schema"],
  };
}

// ── Anthropic → Neutral (response) ─────────────────────────────────────────────

function toNeutralResponse(response: Anthropic.Messages.Message): ChatResponse {
  return {
    content: response.content.map(toNeutralBlock),
    stopReason: toNeutralStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.output_tokens_details?.thinking_tokens != null
        ? { reasoningTokens: response.usage.output_tokens_details.thinking_tokens }
        : {}),
      ...(response.usage.cache_read_input_tokens != null
        ? { cacheReadTokens: response.usage.cache_read_input_tokens }
        : {}),
      ...(response.usage.cache_creation_input_tokens != null
        ? { cacheCreationTokens: response.usage.cache_creation_input_tokens }
        : {}),
    },
  };
}

function toNeutralBlock(b: Anthropic.Messages.ContentBlock): ContentBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "thinking":
      return { type: "reasoning", provider: "anthropic", opaque: b, text: b.thinking };
    case "redacted_thinking":
      // No readable summary to surface; opaque carries the whole block.
      return { type: "reasoning", provider: "anthropic", opaque: b };
    default:
      // Any other block kind (e.g. future server_tool blocks) is preserved as
      // opaque reasoning-style state rather than dropped, so history stays valid.
      return { type: "reasoning", provider: "anthropic", opaque: b };
  }
}

function toNeutralStopReason(
  reason: Anthropic.Messages.Message["stop_reason"],
): NeutralStopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_output";
    default:
      // stop_sequence, pause_turn, refusal, null → treated as a plain end.
      return "other";
  }
}

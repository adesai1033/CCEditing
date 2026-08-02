import Anthropic from "@anthropic-ai/sdk";
import type { ToolSchema } from "../types.js";
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  NeutralMessage,
  NeutralStopReason,
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

// Minimal surface of the Anthropic SDK we use, so tests can inject a mock
// without constructing a real client. The real client satisfies this trivially.
export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Messages.Message>;
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
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.model,
      system: request.system,
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools.map(toAnthropicTool),
      max_tokens: request.maxTokens,
      // request.reasoning maps to nothing this slice — extended thinking is off.
      // ── 3E-2.5 fills in here: translate request.reasoning → `thinking`. ──
    };

    const response = await this.client.messages.create(params);
    return toNeutralResponse(response);
  }
}

// ── Neutral → Anthropic (request) ──────────────────────────────────────────────

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

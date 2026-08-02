import type { ToolSchema } from "../types.js";

/**
 * Provider-neutral chat model. The agent loop and the REPL's conversation
 * history are expressed ENTIRELY in these types; no vendor SDK type leaks past
 * this boundary. A `ChatProvider` implementation (one per vendor) translates
 * neutral ↔ that vendor's wire format inside `send()`, and nowhere else.
 *
 * Why the neutrality is load-bearing, not cosmetic: reasoning state
 * (extended thinking, enabled in 3E-2.5) is stateful across turns — a vendor's
 * reasoning payload must be round-tripped back into history byte-identical or
 * the API rejects the continuation. Each vendor shapes that payload
 * differently and none of them agree:
 *
 *   - Anthropic: a `thinking` block carrying an opaque `signature`
 *     (or a `redacted_thinking` block).
 *   - OpenAI (Responses API): a `reasoning` item whose `encrypted_content`
 *     must be replayed in full — id + summary alone are insufficient.
 *   - Grok / xAI: OpenAI-compatible `reasoning.encrypted_content`, replayed
 *     the same way.
 *
 * The common denominator across all three is "an opaque blob the vendor owns,
 * handed back verbatim." The neutral `reasoning` block below carries exactly
 * that (see `opaque`), tagged with `provider` so one vendor's blob is never
 * fed to another. This lets 3E-2.5 turn thinking on by FILLING this slot
 * rather than reshaping the seam.
 */

// ── Content blocks — what a message is made of ─────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: unknown; isError?: boolean }
  // Opaque, provider-owned reasoning state. `opaque` holds whatever the vendor
  // requires for stateful continuation (Anthropic: the whole thinking block
  // including its `signature`), round-tripped UNCHANGED. Nothing outside the
  // owning provider parses it. `text` is a human-readable summary when the
  // vendor exposes one; it is never authoritative for continuation.
  // Defined now; NOT produced until 3E-2.5 (thinking stays off this slice).
  | { type: "reasoning"; provider: string; opaque: unknown; text?: string };

export interface NeutralMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// ── Request / response ─────────────────────────────────────────────────────────

/**
 * Reasoning configuration slot. Unused this slice (thinking is off); 3E-2.5
 * fills it and each provider maps it to its own vendor parameters. Kept
 * deliberately minimal — this is a placeholder, not the final shape.
 */
export interface ReasoningConfig {
  enabled?: boolean;
  budgetTokens?: number;
}

export interface ChatRequest {
  system: string;
  messages: NeutralMessage[];
  /** The registry's neutral tool schemas; the provider translates them. */
  tools: ToolSchema[];
  maxTokens: number;
  /** None this slice; filled by 3E-2.5. */
  reasoning?: ReasoningConfig;
}

/**
 * Neutral stop reasons. The loop branches on THESE, never on vendor strings.
 * `max_output` (vendor "max_tokens" / truncation) is mapped explicitly because
 * it becomes load-bearing in 3E-2.5; this slice treats it exactly like
 * `end_turn`, matching pre-slice behavior.
 */
export type NeutralStopReason = "end_turn" | "tool_use" | "max_output" | "other";

export interface ChatResponse {
  content: ContentBlock[];
  stopReason: NeutralStopReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Normalized reasoning-token count when the vendor reports one. */
    reasoningTokens?: number;
  };
}

// ── The seam ───────────────────────────────────────────────────────────────────

/**
 * The one interface the loop talks to. Minimal on purpose: exactly what
 * `loop.ts` uses today plus the reasoning slot. Streaming, caching, batching,
 * and routing arrive later, through this same seam, in their own slices.
 */
export interface ChatProvider {
  send(request: ChatRequest): Promise<ChatResponse>;
}

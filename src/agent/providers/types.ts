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
  // vendor exposes one (Anthropic summarized thinking); it is never
  // authoritative for continuation. Produced when reasoning is enabled (3E-2.5).
  | { type: "reasoning"; provider: string; opaque: unknown; text?: string };

export interface NeutralMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// ── Request / response ─────────────────────────────────────────────────────────

/**
 * Effort is the obvious cross-provider axis — Anthropic and OpenAI both have an
 * effort/budget notion. Kept to the common three; a provider maps them to its
 * own scale (Anthropic: output_config.effort). Tuning effort needs telemetry
 * (3E-9); this slice leaves it unset and lets the provider default it.
 */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Reasoning configuration. `enabled` turns thinking on; the provider maps it to
 * its own reasoning mode (Anthropic: adaptive thinking). `effort` is defined as
 * the cross-provider steering axis but intentionally left unset this slice.
 */
export interface ReasoningConfig {
  enabled: boolean;
  effort?: ReasoningEffort;
}

export interface ChatRequest {
  system: string;
  messages: NeutralMessage[];
  /** The registry's neutral tool schemas; the provider translates them. */
  tools: ToolSchema[];
  maxTokens: number;
  /** When enabled, the provider turns on its reasoning mode (3E-2.5). */
  reasoning?: ReasoningConfig;
}

/**
 * Neutral stop reasons. The loop branches on THESE, never on vendor strings.
 * `max_output` (vendor "max_tokens" / truncation) is load-bearing once thinking
 * is on: reasoning tokens count toward the output budget, so truncation is a
 * real failure the loop surfaces as an error rather than a silent cutoff.
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

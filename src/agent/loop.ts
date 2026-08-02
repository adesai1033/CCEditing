import type { ProjectSession } from "../project/session.js";
import { applyPlan } from "../project/session.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildDefaultRegistry, type ToolRegistry } from "./registry.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import type {
  ChatProvider,
  ChatResponse,
  ContentBlock,
  NeutralMessage,
} from "./providers/types.js";
import {
  AgentOperationSchema,
  ProposeEditPlanInputSchema,
  renderPlanForConfirmation,
  type PlanForConfirmation,
} from "./propose_edit_plan.js";

const MAX_TOOL_CALLS_PER_TURN = 25;
const MAX_TOKENS = 4096;

// Neutral block aliases — the loop works exclusively in these.
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

// ── Public types ──────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; durationMs: number }
  | { type: "assistant_text"; text: string };

export interface AgentInput {
  userPrompt: string;
  session: ProjectSession;
  messages: NeutralMessage[];
  autoApprove: boolean;
  confirm: (plan: PlanForConfirmation) => Promise<{ approved: boolean }>;
  onProgress?: (event: ProgressEvent) => void;
  // Injected for tests. Defaults to a real AnthropicProvider built from
  // ANTHROPIC_API_KEY. Production callers omit this.
  provider?: ChatProvider;
  // Injected for tests. Defaults to buildDefaultRegistry().
  registry?: ToolRegistry;
}

export interface AgentResult {
  messages: NeutralMessage[];
  session: ProjectSession;
  output: string;
  isError: boolean;
}

// ── Internal state ────────────────────────────────────────────────────────────

// Explicit, threaded through the loop — never smeared across closures.
// Mirrors what a future LangGraph State channel would carry.
interface AgentState {
  messages: NeutralMessage[];
  session: ProjectSession;
  autoApprove: boolean;
  toolBudget: number;
  appliedLabel: string | null;   // set when a plan was successfully applied
  rejected: boolean;             // set when a plan was rejected
  applyError: string | null;     // set when applyPlan failed mid-plan
  assistantText: string[];       // accumulated text replies for the final output summary
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const provider = input.provider ?? buildDefaultProvider();
  const registry = input.registry ?? buildDefaultRegistry();

  let state: AgentState = {
    messages: [
      ...input.messages,
      { role: "user", content: [{ type: "text", text: input.userPrompt }] },
    ],
    session: input.session,
    autoApprove: input.autoApprove,
    toolBudget: MAX_TOOL_CALLS_PER_TURN,
    appliedLabel: null,
    rejected: false,
    applyError: null,
    assistantText: [],
  };

  const system = await buildSystemPrompt(state.session.state);
  const tools = registry.allSchemas();

  for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN + 1; i++) {
    let response: ChatResponse;
    try {
      response = await provider.send({
        system,
        messages: state.messages,
        tools,
        maxTokens: MAX_TOKENS,
        // No reasoning config this slice — extended thinking is off (3E-2.5).
      });
    } catch (err: unknown) {
      return finalize(state, `Agent error: ${(err as Error).message}`, true);
    }

    // Append the assistant's response verbatim. Content may include text,
    // tool_use, and (when extended thinking is enabled in 3E-2.5) reasoning
    // blocks — we preserve ALL of them unchanged so the provider round-trip
    // stays valid. Do not filter (3E-1 decision 11, now on neutral blocks).
    state = {
      ...state,
      messages: [
        ...state.messages,
        { role: "assistant", content: response.content },
      ],
    };

    // Surface any text blocks via progress and remember them for the final
    // summary. Reasoning blocks are carried in history but not surfaced as text.
    for (const block of response.content) {
      if (block.type === "text") {
        state.assistantText.push(block.text);
        input.onProgress?.({ type: "assistant_text", text: block.text });
      }
    }

    if (response.stopReason === "end_turn" || response.stopReason === "max_output") {
      // `max_output` is treated as a plain end this slice (pre-slice behavior);
      // 3E-2.5 tightens it.
      return finalize(state, null, false);
    }

    if (response.stopReason !== "tool_use") {
      // Unexpected stop reason — bail with the text we have.
      return finalize(state, null, false);
    }

    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Defensive: stopReason said tool_use but no tool_use blocks appeared.
      return finalize(state, null, false);
    }

    const toolResults: ToolResultBlock[] = [];
    let stopAfterThisRound = false;

    for (const tu of toolUses) {
      if (state.toolBudget <= 0) {
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: "Tool budget exhausted for this turn — agent must stop.",
          isError: true,
        });
        stopAfterThisRound = true;
        continue;
      }
      state.toolBudget -= 1;

      const handled = await dispatchToolUse(tu, state, registry, input);
      state = handled.state;
      toolResults.push(handled.result);
      if (handled.stopAfterThisRound) stopAfterThisRound = true;
    }

    state = {
      ...state,
      messages: [
        ...state.messages,
        { role: "user", content: toolResults },
      ],
    };

    if (stopAfterThisRound && state.toolBudget <= 0) {
      return finalize(state, "Agent exceeded tool-call budget for this turn.", true);
    }
  }

  return finalize(state, "Agent exceeded tool-call budget for this turn.", true);
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

interface ToolHandled {
  state: AgentState;
  result: ToolResultBlock;
  stopAfterThisRound: boolean;
}

async function dispatchToolUse(
  tu: ToolUseBlock,
  state: AgentState,
  registry: ToolRegistry,
  input: AgentInput,
): Promise<ToolHandled> {
  const start = Date.now();
  input.onProgress?.({ type: "tool_call", name: tu.name, input: tu.input });

  if (tu.name === "propose_edit_plan") {
    return handleProposePlan(tu, state, input, start);
  }

  const entry = registry.get(tu.name);
  if (!entry) {
    const errText = `Unknown tool: ${tu.name}`;
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start });
    return {
      state,
      result: { type: "tool_result", toolUseId: tu.id, content: errText, isError: true },
      stopAfterThisRound: false,
    };
  }

  let outcome;
  try {
    outcome = await entry.execute(state.session.state, tu.input);
  } catch (err: unknown) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start });
    return {
      state,
      result: {
        type: "tool_result",
        toolUseId: tu.id,
        content: `Tool threw: ${(err as Error).message}`,
        isError: true,
      },
      stopAfterThisRound: false,
    };
  }

  if (!outcome.ok) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start });
    return {
      state,
      result: { type: "tool_result", toolUseId: tu.id, content: outcome.error, isError: true },
      stopAfterThisRound: false,
    };
  }

  // Cache writes from perception tools bypass applyPlan — they aren't
  // undoable. Thread the updated state into the session for subsequent
  // tool calls in this same turn.
  let nextSession = state.session;
  if (outcome.stateUpdate) {
    nextSession = { ...state.session, state: outcome.stateUpdate };
  }

  input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - start });

  return {
    state: { ...state, session: nextSession },
    result: {
      type: "tool_result",
      toolUseId: tu.id,
      content: JSON.stringify(outcome.result),
    },
    stopAfterThisRound: false,
  };
}

// ── propose_edit_plan special case ────────────────────────────────────────────

async function handleProposePlan(
  tu: ToolUseBlock,
  state: AgentState,
  input: AgentInput,
  startMs: number,
): Promise<ToolHandled> {
  const parsed = ProposeEditPlanInputSchema.safeParse(tu.input);
  if (!parsed.success) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs });
    return {
      state,
      result: {
        type: "tool_result",
        toolUseId: tu.id,
        content: `Plan input failed validation: ${parsed.error.message}`,
        isError: true,
      },
      stopAfterThisRound: false,
    };
  }

  // Validate each op against the agent operation schema (already done by
  // ProposeEditPlanInputSchema but explicit for clarity).
  for (const op of parsed.data.operations) {
    const r = AgentOperationSchema.safeParse(op);
    if (!r.success) {
      input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs });
      return {
        state,
        result: {
          type: "tool_result",
          toolUseId: tu.id,
          content: `Operation failed validation: ${r.error.message}`,
          isError: true,
        },
        stopAfterThisRound: false,
      };
    }
  }

  const plan = renderPlanForConfirmation(state.session.state, parsed.data);

  // Confirm (unless auto-approve)
  let approved = true;
  if (!state.autoApprove) {
    const decision = await input.confirm(plan);
    approved = decision.approved;
  }

  if (!approved) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - startMs });
    return {
      state: { ...state, rejected: true },
      result: {
        type: "tool_result",
        toolUseId: tu.id,
        content: JSON.stringify({ status: "rejected", message: "User rejected the plan." }),
      },
      stopAfterThisRound: false,
    };
  }

  // Apply via the chokepoint, labeled with the user's verbatim NL prompt.
  const userPrompt = lastUserPromptFrom(state.messages);
  const applyResult = applyPlan(state.session, userPrompt, plan.operations);

  if (!applyResult.ok) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs });
    return {
      state: {
        ...state,
        applyError: `Plan failed at operation ${applyResult.failedAt + 1}: ${applyResult.error}`,
      },
      result: {
        type: "tool_result",
        toolUseId: tu.id,
        content: JSON.stringify({
          status: "failed",
          failedAt: applyResult.failedAt,
          error: applyResult.error,
        }),
        isError: true,
      },
      stopAfterThisRound: false,
    };
  }

  input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - startMs });
  return {
    state: {
      ...state,
      session: applyResult.session,
      appliedLabel: userPrompt,
    },
    result: {
      type: "tool_result",
      toolUseId: tu.id,
      content: JSON.stringify({
        status: "applied",
        summary: plan.summary,
        opsCount: plan.operations.length,
      }),
    },
    stopAfterThisRound: false,
  };
}

// ── Finalization ──────────────────────────────────────────────────────────────

function finalize(state: AgentState, errorOverride: string | null, hadError: boolean): AgentResult {
  const parts: string[] = [];
  if (state.assistantText.length > 0) parts.push(state.assistantText.join("\n").trim());
  if (state.appliedLabel) parts.push(`Applied: ${state.appliedLabel}`);
  if (state.rejected) parts.push("No changes — plan rejected.");
  if (state.applyError) parts.push(state.applyError);
  if (errorOverride) parts.push(errorOverride);

  const output = parts.filter(Boolean).join("\n\n") || "(no output)";
  return {
    messages: state.messages,
    session: state.session,
    output,
    isError: hadError || state.applyError !== null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lastUserPromptFrom(messages: NeutralMessage[]): string {
  // Walk backwards to find the most recent role=user message that is a genuine
  // prompt (a text block) rather than a tool_result envelope. The current
  // turn's prompt is appended last among user text messages, so it wins.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (m.content.some((b) => b.type === "tool_result")) continue;
    const text = m.content.find((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");
    if (text) return text.text;
  }
  return "(unknown prompt)";
}

let cachedProvider: ChatProvider | null = null;
function buildDefaultProvider(): ChatProvider {
  // Lazy + cached, mirroring the pre-slice real-client construction: the
  // fail-fast missing-key error surfaces on first agent turn, not at startup.
  if (cachedProvider) return cachedProvider;
  cachedProvider = new AnthropicProvider();
  return cachedProvider;
}

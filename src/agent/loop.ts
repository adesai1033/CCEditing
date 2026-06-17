import Anthropic from "@anthropic-ai/sdk";
import type { ProjectSession } from "../project/session.js";
import { applyPlan } from "../project/session.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildDefaultRegistry, type ToolRegistry } from "./registry.js";
import {
  AgentOperationSchema,
  ProposeEditPlanInputSchema,
  renderPlanForConfirmation,
  type PlanForConfirmation,
} from "./propose_edit_plan.js";

const MODEL_DEFAULT = "claude-sonnet-4-6";
const MAX_TOOL_CALLS_PER_TURN = 25;
const MAX_TOKENS = 4096;

// ── Public types ──────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; durationMs: number }
  | { type: "assistant_text"; text: string };

export interface AgentInput {
  userPrompt: string;
  session: ProjectSession;
  messages: Anthropic.Messages.MessageParam[];
  autoApprove: boolean;
  confirm: (plan: PlanForConfirmation) => Promise<{ approved: boolean }>;
  onProgress?: (event: ProgressEvent) => void;
  // Injected for tests. Defaults to a real Anthropic client built from
  // ANTHROPIC_API_KEY. Production callers omit this.
  client?: AnthropicLike;
  // Injected for tests. Defaults to buildDefaultRegistry().
  registry?: ToolRegistry;
}

// Minimal surface of the Anthropic SDK we use, so tests can mock without
// pulling in the full client. The real client implements this trivially.
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Messages.Message>;
  };
}

export interface AgentResult {
  messages: Anthropic.Messages.MessageParam[];
  session: ProjectSession;
  output: string;
  isError: boolean;
}

// ── Internal state ────────────────────────────────────────────────────────────

// Explicit, threaded through the loop — never smeared across closures.
// Mirrors what a future LangGraph State channel would carry.
interface AgentState {
  messages: Anthropic.Messages.MessageParam[];
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
  const client = input.client ?? buildRealClient();
  const registry = input.registry ?? buildDefaultRegistry();

  let state: AgentState = {
    messages: [
      ...input.messages,
      { role: "user", content: input.userPrompt },
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
  const tools = registry.allSchemas().map(toAnthropicTool);

  for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN + 1; i++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL_DEFAULT,
        system,
        messages: state.messages,
        tools,
        max_tokens: MAX_TOKENS,
      });
    } catch (err: unknown) {
      return finalize(state, `Agent error: ${(err as Error).message}`, true);
    }

    // Append the assistant's response verbatim. Content may include
    // text, tool_use, and (when extended thinking is enabled later) thinking
    // blocks — we preserve all of them so the SDK round-trip stays valid.
    state = {
      ...state,
      messages: [
        ...state.messages,
        { role: "assistant", content: response.content },
      ],
    };

    // Surface any text blocks via progress and remember them for the final summary.
    for (const block of response.content) {
      if (block.type === "text") {
        state.assistantText.push(block.text);
        input.onProgress?.({ type: "assistant_text", text: block.text });
      }
    }

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      return finalize(state, null, false);
    }

    if (response.stop_reason !== "tool_use") {
      // Unexpected stop_reason — bail with the text we have.
      return finalize(state, null, false);
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Defensive: stop_reason said tool_use but no tool_use blocks appeared.
      return finalize(state, null, false);
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    let stopAfterThisRound = false;

    for (const tu of toolUses) {
      if (state.toolBudget <= 0) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Tool budget exhausted for this turn — agent must stop.",
          is_error: true,
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
  result: Anthropic.Messages.ToolResultBlockParam;
  stopAfterThisRound: boolean;
}

async function dispatchToolUse(
  tu: Anthropic.Messages.ToolUseBlock,
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
      result: { type: "tool_result", tool_use_id: tu.id, content: errText, is_error: true },
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
        tool_use_id: tu.id,
        content: `Tool threw: ${(err as Error).message}`,
        is_error: true,
      },
      stopAfterThisRound: false,
    };
  }

  if (!outcome.ok) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start });
    return {
      state,
      result: { type: "tool_result", tool_use_id: tu.id, content: outcome.error, is_error: true },
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
      tool_use_id: tu.id,
      content: JSON.stringify(outcome.result),
    },
    stopAfterThisRound: false,
  };
}

// ── propose_edit_plan special case ────────────────────────────────────────────

async function handleProposePlan(
  tu: Anthropic.Messages.ToolUseBlock,
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
        tool_use_id: tu.id,
        content: `Plan input failed validation: ${parsed.error.message}`,
        is_error: true,
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
          tool_use_id: tu.id,
          content: `Operation failed validation: ${r.error.message}`,
          is_error: true,
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
        tool_use_id: tu.id,
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
        tool_use_id: tu.id,
        content: JSON.stringify({
          status: "failed",
          failedAt: applyResult.failedAt,
          error: applyResult.error,
        }),
        is_error: true,
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
      tool_use_id: tu.id,
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

function toAnthropicTool(s: { name: string; description: string; input_schema: object }): Anthropic.Messages.Tool {
  return {
    name: s.name,
    description: s.description,
    input_schema: s.input_schema as Anthropic.Messages.Tool["input_schema"],
  };
}

function lastUserPromptFrom(messages: Anthropic.Messages.MessageParam[]): string {
  // Walk backwards to find the most recent role=user message whose content
  // is a plain string (i.e. user prompt, not a tool_result envelope).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "(unknown prompt)";
}

let cachedClient: Anthropic | null = null;
function buildRealClient(): AnthropicLike {
  if (cachedClient) return cachedClient;
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it before running an agent turn (get one at https://console.anthropic.com).",
    );
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

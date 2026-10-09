import type { ProjectSession, Operation } from "../project/session.js";
import { applyPlan, applyOperations } from "../project/session.js";
import { mergeAnalyses } from "./scout.js";
import { ProposeProgramInputSchema } from "./propose_program.js";
import { compileProgram, shotList, renderShotList, type Program } from "../edit/program.js";
import { measureProjectSync, syncIsCurrent } from "./tools/sync_sources.js";
import { defaultReviewer, type ReviewerFn } from "./reviewer.js";
import { executeDetectSilence } from "./tools/detect_silence.js";
import { CUT_SILENCE } from "../edit/cut-facts.js";
import { staticSystemPrefix, stateSnapshotSegment } from "./prompt.js";
import { buildDefaultRegistry, type ToolRegistry } from "./registry.js";
import { buildDefaultProvider } from "./providers/default.js";
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
import { runCritic, type CriticConcern, type CriticInput, type CriticVerdict } from "./critic.js";
import { evidenceFrom, type EvidenceItem } from "./evidence.js";
import type { ContentMap } from "./content-map.js";

// Reads now run in parallel and the cut is verified line by line, so a story
// edit legitimately uses more calls: a measured run spent all 25 on checks and
// ended with nothing applied. 40, plus a warning when the end is near.
const MAX_TOOL_CALLS_PER_TURN = 40;
/** When this many calls remain, the director is told to propose now. */
const BUDGET_WARNING_AT = 5;
// ── Critic thresholds (3G) ────────────────────────────────────────────────────
// Only compound plans get a critic pass: a plan with at least this many ops is
// always reviewed, and a smaller multi-op plan is reviewed when it followed a
// survey_sources call (the tell that the turn was a narrative edit). Single-op
// edits are NEVER reviewed — a critic pass there is pure latency and cost.
export const CRITIC_MIN_OPS = 3;
// Bounded revision cycle: draft → review → (revise → review) up to this many
// times → stop. On exhaustion the plan is presented WITH the outstanding
// concerns attached rather than looping or failing — the user is the arbiter.
export const MAX_CRITIC_REVISIONS = 2;
// Thinking tokens count toward the output budget. At 4096, reasoning on a hard
// request eats the budget and truncates the plan mid-response. Sized to leave
// room for both the reasoning and the answer. Provider-agnostic.
//
// Story edits (a tightened spine with many kept ranges plus several anchored
// cutaways) produce long plans: a real run truncated at 16000 with nothing
// applied. 32000 is the normal budget; a truncated turn is retried ONCE at
// MAX_TOKENS_RETRY before giving up.
const MAX_TOKENS = 32000;
const MAX_TOKENS_RETRY = 64000;

// Neutral block aliases — the loop works exclusively in these.
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

// ── Public types ──────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { type: "tool_call"; name: string; input: unknown }
  // `detail` (3K) carries the tool's result payload (or error text) so the
  // REPL can retain it for Ctrl+R expansion. Display channel only.
  | { type: "tool_result"; name: string; ok: boolean; durationMs: number; detail?: unknown }
  // Streamed incremental display (3E-4). text/thinking arrive token-by-token;
  // tool_use_start indicates a tool call is forming (name only, never its JSON);
  // scout reports parallel fan-out lifecycle from survey_sources.
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; name: string }
  | { type: "scout"; sourceId: string; status: "started" | "completed" | "failed" }
  // Critic pass lifecycle (3G): start when a drafted plan goes to review,
  // verdict when it comes back. The REPL renders these as a dim line.
  | { type: "critic_start" }
  // `concernDetails` (3K): the structured concerns themselves, for expansion —
  // seeing WHY the critic revised is the most useful thing Ctrl+R unlocks.
  | { type: "critic_verdict"; verdict: "approve" | "revise"; concerns: number; concernDetails?: CriticConcern[] };

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
  // 3G: the /critic toggle. Undefined means ON — compound plans are reviewed
  // by a fresh context before the user sees them; false skips the pass.
  criticEnabled?: boolean;
  // Injected for tests. Defaults to runCritic through this turn's provider.
  critic?: (input: CriticInput) => Promise<CriticVerdict>;
  /** Injected for tests — watches a draft of a proposed program. Defaults to
   *  the video reviewer (renders from proxies, reviewed by a video model). */
  reviewer?: ReviewerFn;
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
  surveyed: boolean;             // 3G: survey_sources ran this turn (critic threshold input)
  lastContentMap: ContentMap | null; // 3G: the most recent survey's map, handed to the critic
  evidence: EvidenceItem[];      // perception results this turn, handed to the critic

  criticRevisions: number;       // 3G: revision rounds consumed (capped at MAX_CRITIC_REVISIONS)
}

type CriticFn = (input: CriticInput) => Promise<CriticVerdict>;

// ── Entrypoint ────────────────────────────────────────────────────────────────

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const provider = input.provider ?? buildDefaultProvider();
  const registry = input.registry ?? buildDefaultRegistry();
  // The critic goes through the same ChatProvider seam as the director
  // (decision 7); it just builds its own fresh message list inside runCritic.
  const critic: CriticFn = input.critic ?? ((ci) => runCritic(ci, { provider }));
  const reviewer: ReviewerFn = input.reviewer ?? defaultReviewer;

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
    surveyed: false,
    lastContentMap: null,
    evidence: [],

    criticRevisions: 0,
  };

  // System prompt in two segments (3E-5): the static prefix is cacheable —
  // byte-identical every turn, so the provider can cache it (plus the tool
  // schemas ahead of it); the fresh timeline snapshot follows OUTSIDE the
  // cached prefix so state changes never invalidate it. Same effective
  // instructions as the pre-split prompt.
  const system = [
    { text: staticSystemPrefix(), cacheable: true },
    { text: await stateSnapshotSegment(state.session.state) },
  ];
  const tools = registry.allSchemas();

  for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN + 1; i++) {
    // Stream the turn for live display, then take the SAME complete response the
    // block path would return and proceed identically (decisions 1 & 3). Text
    // and thinking render token-by-token via deltas; tool calls surface as a
    // name-only indicator — never streamed input JSON.
    let response: ChatResponse;
    let budget = MAX_TOKENS;
    for (let attempt = 0; ; attempt++) {
    try {
      const streaming = provider.stream({
        system,
        messages: state.messages,
        tools,
        maxTokens: budget,
        // Always-on reasoning. The provider maps this to adaptive thinking; the
        // model decides per turn whether/how much to think (adaptive skips it on
        // simple edits). No Anthropic-specific handling reaches this file.
        reasoning: { enabled: true },
        role: "director",
      });
      for await (const ev of streaming) {
        if (ev.type === "text_delta") input.onProgress?.({ type: "text_delta", text: ev.text });
        else if (ev.type === "thinking_delta") input.onProgress?.({ type: "thinking_delta", text: ev.text });
        else if (ev.type === "tool_use_start") input.onProgress?.({ type: "tool_use_start", name: ev.name });
        // message_complete carries nothing the loop needs; stop reason comes
        // from the assembled response below.
      }
      response = await streaming.finalResponse();
    } catch (err: unknown) {
      return finalize(state, `Agent error: ${(err as Error).message}`, true);
    }
    // A truncated turn is discarded (never appended — a half-written tool call
    // is not valid history) and re-asked once with a larger budget.
    if (response.stopReason === "max_output" && attempt === 0) {
      budget = MAX_TOKENS_RETRY;
      continue;
    }
    break;
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

    // Accumulate assistant text for the final summary. The text was already
    // shown live via text_delta events during streaming, so we do NOT re-emit a
    // completed block event here (that would double-render). Reasoning blocks
    // are carried in history but only surfaced as streamed thinking.
    for (const block of response.content) {
      if (block.type === "text") state.assistantText.push(block.text);
    }

    if (response.stopReason === "max_output") {
      // Reasoning tokens count toward the output budget; truncation here means
      // the turn was cut off before completing. Surface it, don't swallow it.
      return finalize(
        state,
        "The response was cut off at the output-token limit before finishing. Try narrowing the request.",
        true,
      );
    }

    if (response.stopReason === "end_turn") {
      return finalize(state, null, false);
    }

    if (response.stopReason !== "tool_use") {
      // Unexpected stop reason ("other") — bail with the text we have.
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

    // Consecutive reads in one turn run CONCURRENTLY (a transcript, a beat
    // map and a description don't wait on each other); propose_edit_plan
    // stays serial and sees everything read before it. Results, cache writes
    // and evidence are folded back in the order the director asked for them.
    let i = 0;
    while (i < toolUses.length) {
      const tu = toolUses[i]!;
      if (state.toolBudget <= 0) {
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: "Tool budget exhausted for this turn — agent must stop.",
          isError: true,
        });
        stopAfterThisRound = true;
        i++;
        continue;
      }

      if (TERMINAL_TOOLS.has(tu.name)) {
        state.toolBudget -= 1;
        const handled = await dispatchToolUse(tu, state, registry, input, critic, reviewer);
        state = handled.state;
        toolResults.push(handled.result);
        if (handled.stopAfterThisRound) stopAfterThisRound = true;
        i++;
        continue;
      }

      const batch: ToolUseBlock[] = [];
      while (i < toolUses.length && !TERMINAL_TOOLS.has(toolUses[i]!.name) && state.toolBudget > 0) {
        state.toolBudget -= 1;
        batch.push(toolUses[i]!);
        i++;
      }
      const base = state;
      const handled = await Promise.all(batch.map((b) => dispatchToolUse(b, base, registry, input, critic, reviewer)));
      for (const h of handled) {
        state = {
          ...state,
          session: { ...state.session, state: mergeAnalyses(state.session.state, base.session.state, h.state.session.state) },
          surveyed: state.surveyed || h.state.surveyed,
          lastContentMap: h.state.lastContentMap !== base.lastContentMap ? h.state.lastContentMap : state.lastContentMap,
          evidence: [...state.evidence, ...h.state.evidence.slice(base.evidence.length)],
        };
        toolResults.push(h.result);
        if (h.stopAfterThisRound) stopAfterThisRound = true;
      }
    }

    // Running out of budget discards the whole turn, so say so while there is
    // still room to propose. Only reads count down here; a plan already
    // proposed this round doesn't need the nudge.
    const nudge: ContentBlock[] = state.toolBudget > 0 && state.toolBudget <= BUDGET_WARNING_AT && !toolUses.some((t) => TERMINAL_TOOLS.has(t.name))
      ? [{
          type: "text",
          text: `Only ${state.toolBudget} tool call${state.toolBudget === 1 ? "" : "s"} left this turn. Stop verifying and call ` +
            "propose_edit_plan / propose_program now with what you have — running out applies nothing.",
        }]
      : [];
    state = {
      ...state,
      messages: [
        ...state.messages,
        { role: "user", content: [...toolResults, ...nudge] },
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

/** Tools that end in a confirm/apply — never batched with reads. */
const TERMINAL_TOOLS = new Set(["propose_edit_plan", "propose_program"]);

async function dispatchToolUse(
  tu: ToolUseBlock,
  state: AgentState,
  registry: ToolRegistry,
  input: AgentInput,
  critic: CriticFn,
  reviewer: ReviewerFn,
): Promise<ToolHandled> {
  const start = Date.now();
  input.onProgress?.({ type: "tool_call", name: tu.name, input: tu.input });

  if (tu.name === "propose_edit_plan") {
    return handleProposePlan(tu, state, input, critic, start);
  }
  if (tu.name === "propose_program") {
    return handleProposeProgram(tu, state, input, reviewer, start);
  }

  const entry = registry.get(tu.name);
  if (!entry) {
    const errText = `Unknown tool: ${tu.name}`;
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start, detail: errText });
    return {
      state,
      result: { type: "tool_result", toolUseId: tu.id, content: errText, isError: true },
      stopAfterThisRound: false,
    };
  }

  // Forward any per-scout lifecycle the tool reports (survey_sources) to the
  // progress channel so the REPL can render the parallel fan-out.
  const ctx = {
    onScoutProgress: (e: { sourceId: string; status: "started" | "completed" | "failed" }) =>
      input.onProgress?.({ type: "scout", sourceId: e.sourceId, status: e.status }),
  };

  let outcome;
  try {
    outcome = await entry.execute(state.session.state, tu.input, ctx);
  } catch (err: unknown) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start, detail: `Tool threw: ${(err as Error).message}` });
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
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - start, detail: outcome.error });
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

  input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - start, detail: outcome.result });

  // 3G: remember that this turn surveyed, and hold the map for the critic —
  // the critic sees the same distilled substrate the director planned against.
  let nextState: AgentState = { ...state, session: nextSession };
  if (tu.name === "survey_sources") {
    nextState = { ...nextState, surveyed: true, lastContentMap: outcome.result as ContentMap };
  }
  const observed = evidenceFrom(tu.name, tu.input, outcome.result, state.session.state);
  if (observed) nextState = { ...nextState, evidence: [...nextState.evidence, observed] };

  return {
    state: nextState,
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
  critic: CriticFn,
  startMs: number,
): Promise<ToolHandled> {
  const parsed = ProposeEditPlanInputSchema.safeParse(tu.input);
  if (!parsed.success) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs, detail: `Plan input failed validation: ${parsed.error.message}` });
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
      input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs, detail: `Operation failed validation: ${r.error.message}` });
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

  let plan = renderPlanForConfirmation(state.session.state, parsed.data);

  // ── Critic review, BEFORE the user sees the plan (3G, decision 1) ──────────
  // On `revise`, the structured concerns go back to the director as a
  // tool_result and this turn's loop continues — the director alone revises
  // and re-proposes (decision 8); the critic never writes. Bounded by
  // MAX_CRITIC_REVISIONS and the per-turn tool budget; on exhaustion the plan
  // is presented WITH the outstanding concerns rather than looping or failing.
  if (input.criticEnabled !== false && planNeedsReview(parsed.data.operations.length, state.surveyed)) {
    input.onProgress?.({ type: "critic_start" });
    let review: CriticVerdict;
    try {
      review = await critic({
        userRequest: lastUserPromptFrom(state.messages),
        contentMap: state.lastContentMap,
        evidence: state.evidence,
        plan: { summary: parsed.data.summary, operations: parsed.data.operations },
        renderedPlan: plan.renderedLines,
        timelineState: state.session.state,
      });
    } catch {
      // runCritic itself fails open, but an injected critic may throw — a
      // critic failure must never strand a valid plan.
      review = { verdict: "approve", concerns: [] };
    }
    input.onProgress?.({ type: "critic_verdict", verdict: review.verdict, concerns: review.concerns.length, concernDetails: review.concerns });

    if (review.verdict === "revise") {
      // A revision round needs budget for the director's re-proposal; if the
      // cap or the budget is exhausted, stop revising and present instead.
      if (state.criticRevisions < MAX_CRITIC_REVISIONS && state.toolBudget > 0) {
        input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - startMs, detail: { status: "revise", concerns: review.concerns } });
        return {
          state: { ...state, criticRevisions: state.criticRevisions + 1 },
          result: {
            type: "tool_result",
            toolUseId: tu.id,
            content: JSON.stringify({
              status: "revise",
              concerns: review.concerns,
              instruction:
                "A plan reviewer flagged these concerns before the user saw the plan. " +
                "Revise the plan to address them and call propose_edit_plan again. " +
                "Fix the plan; do not argue with the review.",
            }),
          },
          stopAfterThisRound: false,
        };
      }
      if (review.concerns.length > 0) {
        plan = { ...plan, outstandingConcerns: review.concerns };
      }
    }
  }

  return confirmAndApply(tu, state, input, plan, startMs);
}

/**
 * The shared end of both terminal tools: the user's confirm gate (unless
 * auto-approve), then ONE applyPlan labeled with the user's prompt.
 */
async function confirmAndApply(
  tu: ToolUseBlock,
  state: AgentState,
  input: AgentInput,
  plan: PlanForConfirmation,
  startMs: number,
): Promise<ToolHandled> {
  // Confirm (unless auto-approve)
  let approved = true;
  if (!state.autoApprove) {
    const decision = await input.confirm(plan);
    approved = decision.approved;
  }

  if (!approved) {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - startMs, detail: { status: "rejected" } });
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
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs, detail: { status: "failed", failedAt: applyResult.failedAt, error: applyResult.error } });
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

  input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - startMs, detail: { status: "applied", summary: plan.summary, opsCount: plan.operations.length } });
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

// ── propose_program ───────────────────────────────────────────────────────────

/**
 * A story edit as a program (src/edit/program.ts). The program is compiled to
 * operations — synced angles lined up from measured offsets — then a reviewer
 * watches a draft of the result. Major notes go back to the director to
 * revise (bounded by MAX_CRITIC_REVISIONS and the tool budget); otherwise the
 * user confirms a shot list and the operations apply as one undo entry.
 */
async function handleProposeProgram(
  tu: ToolUseBlock,
  state: AgentState,
  input: AgentInput,
  reviewer: ReviewerFn,
  startMs: number,
): Promise<ToolHandled> {
  const fail = (message: string): ToolHandled => {
    input.onProgress?.({ type: "tool_result", name: tu.name, ok: false, durationMs: Date.now() - startMs, detail: message });
    return { state, result: { type: "tool_result", toolUseId: tu.id, content: message, isError: true }, stopAfterThisRound: false };
  };
  const parsed = ProposeProgramInputSchema.safeParse(tu.input);
  if (!parsed.success) return fail(`Program failed validation: ${parsed.error.message}`);
  const program = parsed.data.program as Program;

  // Synced angles need measured offsets; measure with this spine as the
  // reference if the project doesn't have them yet.
  const needsSync = program.shots.some((sh) => sh.angle !== program.spine && sh.sourceIn === undefined);
  if (needsSync && !syncIsCurrent(state.session.state, program.spine)) {
    try {
      const sync = await measureProjectSync(state.session.state, program.spine);
      state = { ...state, session: { ...state.session, state: { ...state.session.state, sync } } };
    } catch { /* compile reports which angles lack sync */ }
  }

  // The reviewer's measured facts need the spine's silence (audio-only, cached,
  // well under a second). Measure it here rather than relying on the director.
  {
    const r = await executeDetectSilence(state.session.state, { sourceId: program.spine, ...CUT_SILENCE }).catch(() => null);
    if (r && r.ok && r.stateUpdate) state = { ...state, session: { ...state.session, state: r.stateUpdate } };
  }

  const compiled = compileProgram(state.session.state, program);
  if (!compiled.ok) return fail(`Program can't be built: ${compiled.error}`);
  const scratch = applyOperations(state.session.state, compiled.ops);
  if (!scratch.ok) return fail(`Program can't be applied: operation ${scratch.failedAt + 1} fails: ${scratch.error}`);

  let outstanding: CriticConcern[] | undefined;
  if (input.criticEnabled !== false) {
    input.onProgress?.({ type: "critic_start" });
    let review: Awaited<ReturnType<ReviewerFn>>;
    try {
      review = await reviewer({ userRequest: lastUserPromptFrom(state.messages), state: scratch.state });
    } catch {
      review = { verdict: "approve", notes: [], shots: [] };
    }
    const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    const concerns: CriticConcern[] = review.notes.map((n) => ({ severity: n.severity, issue: `at ${clock(n.time)}: ${n.issue}` }));
    input.onProgress?.({ type: "critic_verdict", verdict: review.verdict, concerns: concerns.length, concernDetails: concerns });

    if (review.verdict === "revise") {
      if (state.criticRevisions < MAX_CRITIC_REVISIONS && state.toolBudget > 0) {
        const detail = { status: "review", notes: concerns, shotList: review.shots, measured: review.facts ?? [] };
        input.onProgress?.({ type: "tool_result", name: tu.name, ok: true, durationMs: Date.now() - startMs, detail });
        return {
          state: { ...state, criticRevisions: state.criticRevisions + 1 },
          result: {
            type: "tool_result",
            toolUseId: tu.id,
            content: JSON.stringify({
              ...detail,
              instruction:
                "Nothing was applied. A reviewer watched a draft of this cut (times are seconds into the cut, as in " +
                "the shot list). `measured` gives exact silent stretches with their source times, so a note about " +
                "length maps straight onto `keep`. Revise the program to fix the major notes and call propose_program again.",
            }),
          },
          stopAfterThisRound: false,
        };
      }
      outstanding = concerns;
    }
  }

  const plan: PlanForConfirmation = {
    summary: parsed.data.summary,
    operations: compiled.ops,
    renderedLines: renderShotList(shotList(scratch.state)),
    ...(outstanding && outstanding.length > 0 ? { outstandingConcerns: outstanding } : {}),
  };
  return confirmAndApply(tu, state, input, plan, startMs);
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

/**
 * The 3G review threshold. Single-op edits are never reviewed (pure latency);
 * a plan with CRITIC_MIN_OPS or more always is; a smaller multi-op plan is
 * reviewed when the turn surveyed sources — the tell of a narrative edit.
 */
function planNeedsReview(opsCount: number, surveyed: boolean): boolean {
  if (opsCount < 2) return false;
  return opsCount >= CRITIC_MIN_OPS || surveyed;
}

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


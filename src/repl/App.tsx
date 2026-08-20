import { useState, useRef, useEffect } from "react";
import { Box, Text } from "ink";
import { Header } from "./components/Header.js";
import { OutputHistory, type HistoryEntry } from "./components/OutputHistory.js";
import { InputLine } from "./components/InputLine.js";
import { ConfirmPlan } from "./components/ConfirmPlan.js";
import { useCommandHistory } from "./hooks/useCommandHistory.js";
import { dispatch, type ReplState } from "./commands/dispatch.js";
import { scratchStateForPlan, previewStateScope } from "./commands/preview.js";
import { ui, glyphs, spinnerFrame, thinkingFrame, clearTerminal } from "../ui/theme.js";
import { presentOutput, renderAgentProse, stripMarkdown } from "../ui/markdown.js";
import { useSpinnerFrame } from "./hooks/useSpinner.js";
import { EMPTY_QUEUE, typeIntoQueue, backspaceQueue, markQueueReady, drainQueueOnComplete, type InputQueue } from "./queue.js";
import { clipCompletions } from "./completions.js";
import { recordUsage } from "./cost.js";
import { setUsageListener } from "../agent/providers/default.js";
import { pushTurnDetail, formatDetailValue, MAX_DETAIL_TURNS, type DetailItem, type TurnDetail } from "./turn-detail.js";
import { renderTimeline, type ViewportState } from "../display/timeline.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { loadOrCreateProject } from "../cli/project-context.js";
import { clipsInOrder, getClipDisplayRefs } from "../project/types.js";
import type { PlanForConfirmation } from "../agent/propose_edit_plan.js";
import type { ProgressEvent } from "../agent/loop.js";

// The ephemeral live view of the turn in flight (3E-4). It shows streamed text
// and thinking token-by-token, tool indicators, and the parallel scout fan-out.
// It is never committed piecemeal — at turn end it's cleared and the loop's
// final output is committed once, so nothing double-renders.
interface LiveTool { key: string; name: string; done: boolean; ok: boolean; }
interface LiveScout { sourceId: string; status: "started" | "completed" | "failed"; }
interface LiveCritic { key: string; done: boolean; verdict?: "approve" | "revise"; concerns: number; }
interface LiveTurn {
  text: string;
  thinking: string;
  tools: LiveTool[];
  scouts: LiveScout[];
  critic: LiveCritic[];
}
const EMPTY_TURN: LiveTurn = { text: "", thinking: "", tools: [], scouts: [], critic: [] };

export function App() {
  const [entries, setEntries]               = useState<HistoryEntry[]>([]);
  const [replState, setReplState]           = useState<ReplState>({
    session: null,
    messages: [],
    autoApprove: false,
    criticEnabled: true,
  });
  const [inputValue, setInputValue]         = useState<string>("");
  const [viewport, setViewport]             = useState<ViewportState | null>(null);
  const [timelineActive, setTimelineActive] = useState<boolean>(false);
  const [pendingEntry, setPendingEntry]     = useState<HistoryEntry | null>(null);
  // Plan awaiting confirmation; presence puts InputLine in confirm mode.
  const [pendingPlan, setPendingPlan]       = useState<PlanForConfirmation | null>(null);
  // The turn in flight, streamed live; null when idle. `turnActive` disables input.
  const [liveTurn, setLiveTurn]             = useState<LiveTurn | null>(null);
  const [turnActive, setTurnActive]         = useState<boolean>(false);
  // Preview render status (3H): a dim line while rendering / after finishing;
  // `previewActive` reroutes Ctrl-C from "exit" to "cancel the render".
  const [previewStatus, setPreviewStatus]   = useState<string | null>(null);
  const [previewActive, setPreviewActive]   = useState<boolean>(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  // One shared animation ticker for every animated glyph (3I, decision 5).
  const spinner = useSpinnerFrame(turnActive || previewActive);
  // 3K: queued type-ahead (state for render, ref for reads inside async flows),
  // Ctrl+R tool-detail expansion, and the bounded per-turn detail store.
  const [queue, setQueue]               = useState<InputQueue>(EMPTY_QUEUE);
  const queueRef = useRef<InputQueue>(EMPTY_QUEUE);
  const [expanded, setExpanded]         = useState<boolean>(false);
  const [turnDetails, setTurnDetails]   = useState<TurnDetail[]>([]);
  const liveItemsRef = useRef<DetailItem[]>([]);

  function applyQueue(q: InputQueue): void {
    queueRef.current = q;
    setQueue(q);
  }

  // /cost (3K): fold every completed provider call — director, scouts, critic —
  // into the session totals via the default provider's usage tap.
  useEffect(() => {
    setUsageListener(recordUsage);
    return () => setUsageListener(null);
  }, []);

  const inputHistoryRef = useRef<string[]>([]);
  // Promise resolver for the agent's `await confirm(plan)`. Set when the agent
  // calls confirm, cleared when the user answers y/n.
  const confirmResolverRef = useRef<((decision: { approved: boolean }) => void) | null>(null);

  const { navigateUp, navigateDown, resetCursor } = useCommandHistory(
    inputHistoryRef.current,
    setInputValue,
  );

  // Load project on startup if .cutcli.json exists in CWD
  useEffect(() => {
    (async () => {
      const id = crypto.randomUUID();
      setPendingEntry({ id, input: "(startup)", output: "Loading project…", isError: false });
      const ctx = await loadOrCreateProject();
      setPendingEntry(null);
      if (ctx.ok && ctx.existed) {
        setReplState((s) => ({ ...s, session: ctx.session }));
        const clipCount = clipsInOrder(ctx.session.state.timeline).length;
        setEntries([{
          id,
          input: "(startup)",
          output: `Loaded project  ·  ${clipCount} clip${clipCount === 1 ? "" : "s"}`,
          isError: false,
        }]);
      }
    })();
  }, []);

  // The confirm callback handed to the agent loop. Stashes a resolver,
  // surfaces the plan to the UI, and waits.
  function makeConfirmCallback(): (plan: PlanForConfirmation) => Promise<{ approved: boolean }> {
    return (plan) => new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setPendingPlan(plan);
    });
  }

  function handleConfirmAnswer(approved: boolean): void {
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setPendingPlan(null);
    setPreviewStatus(null);
    setEntries((prev) => [...prev, {
      id: crypto.randomUUID(),
      input: approved ? "y" : "n",
      output: approved ? "Approved." : "Rejected.",
      isError: false,
    }]);
    resolve?.({ approved });
  }

  // `p` at the gate (3H): render the plan AS IT WOULD BE if applied — a scratch
  // state computed from the same operation logic applyPlan uses, rendered and
  // discarded. The gate stays pending throughout: previewing is not a decision.
  async function handleConfirmPreview(): Promise<void> {
    if (!pendingPlan || !replState.session || previewActive) return;
    const scratch = scratchStateForPlan(replState.session.state, pendingPlan.operations);
    if (!scratch.ok) {
      setPreviewStatus(scratch.error);
      return;
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewActive(true);
    setPreviewStatus("rendering preview… 0%");
    const outcome = await previewStateScope(scratch.state, { type: "timeline" }, {
      onProgress: (pct) => setPreviewStatus(`rendering preview… ${pct}%`),
      signal: controller.signal,
    });
    previewAbortRef.current = null;
    setPreviewActive(false);
    setPreviewStatus(outcome.ok ? outcome.message : outcome.error);
  }

  function handlePreviewCancel(): void {
    previewAbortRef.current?.abort();
  }

  // 3K: collect expandable detail into a ref (no re-render per event — the
  // panel shows completed turns). tool_call opens an item; tool_result closes
  // the most recent open item of that name; critic verdicts append directly.
  function collectDetail(event: ProgressEvent): void {
    const items = liveItemsRef.current;
    if (event.type === "tool_call") {
      items.push({ kind: "tool", name: event.name, input: event.input, ok: false, result: undefined });
    } else if (event.type === "tool_result") {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!;
        if (it.kind === "tool" && it.name === event.name && it.result === undefined) {
          it.ok = event.ok;
          it.result = event.detail ?? (event.ok ? "(no detail)" : "(failed)");
          break;
        }
      }
    } else if (event.type === "critic_verdict") {
      items.push({ kind: "critic", verdict: event.verdict, concerns: event.concernDetails ?? [] });
    }
  }

  // Streamed events fold into the ephemeral live view. Nothing here commits to
  // history — that happens once at turn end (handleSubmit) with the loop's final
  // output, so streamed text is never double-rendered.
  function handleAgentProgress(event: ProgressEvent): void {
    collectDetail(event);
    setLiveTurn((prev) => {
      const t = prev ?? { ...EMPTY_TURN };
      switch (event.type) {
        case "text_delta":
          return { ...t, text: t.text + event.text };
        case "thinking_delta":
          return { ...t, thinking: t.thinking + event.text };
        case "tool_use_start":
          // A name-only indicator; its input JSON is never surfaced (decision 4).
          return t;
        case "tool_call":
          return { ...t, tools: [...t.tools, { key: crypto.randomUUID(), name: event.name, done: false, ok: true }] };
        case "tool_result": {
          // Mark the most recent not-yet-done call of this tool as finished.
          const tools = [...t.tools];
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i]!.name === event.name && !tools[i]!.done) { tools[i] = { ...tools[i]!, done: true, ok: event.ok }; break; }
          }
          return { ...t, tools };
        }
        case "scout": {
          const scouts = [...t.scouts];
          const idx = scouts.findIndex((s) => s.sourceId === event.sourceId);
          if (idx >= 0) scouts[idx] = { sourceId: event.sourceId, status: event.status };
          else scouts.push({ sourceId: event.sourceId, status: event.status });
          return { ...t, scouts };
        }
        case "critic_start":
          return { ...t, critic: [...t.critic, { key: crypto.randomUUID(), done: false, concerns: 0 }] };
        case "critic_verdict": {
          // Resolve the most recent still-open review line with its verdict.
          const critic = [...t.critic];
          for (let i = critic.length - 1; i >= 0; i--) {
            if (!critic[i]!.done) {
              critic[i] = { ...critic[i]!, done: true, verdict: event.verdict, concerns: event.concerns };
              break;
            }
          }
          return { ...t, critic };
        }
        default:
          return t;
      }
    });
  }

  async function handleSubmit(raw: string, fromQueue = false): Promise<void> {
    const trimmed = raw.trim();
    // No re-entry while a turn streams — except the queue drain, which fires
    // exactly at turn end (the closed-over turnActive may be stale there).
    if (!trimmed || (turnActive && !fromQueue)) return;

    inputHistoryRef.current = [trimmed, ...inputHistoryRef.current];
    resetCursor();
    setInputValue("");
    setTimelineActive(false);

    const pendingId = crypto.randomUUID();
    setPendingEntry({ id: pendingId, input: trimmed, output: "Running…", isError: false });
    // Open the live view for this turn and lock input until it finishes.
    setLiveTurn({ ...EMPTY_TURN });
    setTurnActive(true);

    // /preview renders report through this controller: progress updates the
    // pending entry in place, and Ctrl-C aborts the render (decision 6).
    const previewController = new AbortController();
    previewAbortRef.current = previewController;

    const result = await dispatch(trimmed, replState, {
      viewport: viewport ?? undefined,
      confirm: makeConfirmCallback(),
      onAgentProgress: handleAgentProgress,
      previewSignal: previewController.signal,
      onPreviewProgress: (pct) => {
        setPreviewActive(true);
        setPendingEntry({ id: pendingId, input: trimmed, output: `rendering preview… ${pct}%`, isError: false });
      },
    });

    // Finalize: drop the ephemeral live view and commit the loop's final output
    // once as static history (streamed text was shown live, not committed).
    previewAbortRef.current = null;
    setPreviewActive(false);
    setLiveTurn(null);
    setTurnActive(false);
    setPendingEntry(null);
    setEntries((prev) => [...prev, {
      id: pendingId,
      input: trimmed,
      // Agent prose renders through the markdown seam; slash output passes
      // through untouched (3I.5 fix — no raw markdown reaches the terminal).
      output: presentOutput(result.output, result.markdown === true),
      isError: result.isError,
    }]);

    if (result.newState) setReplState(result.newState);
    if (result.activatesTimeline) setTimelineActive(true);

    // 3K: commit this turn's expandable detail (bounded store, oldest evicted).
    if (liveItemsRef.current.length > 0) {
      const items = liveItemsRef.current;
      liveItemsRef.current = [];
      setTurnDetails((prev) => pushTurnDetail(prev, { id: pendingId, prompt: trimmed, items }));
    }

    // 3K: drain the type-ahead queue. A line finished with Enter fires now; an
    // unfinished draft moves back into the prompt — never auto-submitted.
    // (On a turn ABORT — 3J's Esc — preserveQueueOnAbort applies instead.)
    if (result.clearsInputQueue) {
      applyQueue(EMPTY_QUEUE);
    } else {
      const drained = drainQueueOnComplete(queueRef.current);
      applyQueue(drained.queue);
      if (drained.submit) void handleSubmit(drained.submit, true);
      else if (drained.draft) setInputValue(drained.draft);
    }

    if (result.shouldExit) setTimeout(() => process.exit(0), 50);
  }

  // 3K: Ctrl+L — clear the viewport and scrollback, keep every kind of state.
  // Distinct from /clear (which resets agent memory); the note makes that
  // visible. Committed Static history is not re-rendered by design.
  function handleClearScreen(): void {
    clearTerminal();
    setEntries((prev) => [...prev, {
      id: crypto.randomUUID(),
      input: "",
      output: "(screen cleared — conversation memory intact; /clear resets agent memory)",
      isError: false,
      dim: true,
    }]);
  }

  // Short label for a scouted source: the display ref of its first clip.
  function scoutLabel(sourceId: string): string {
    if (!replState.session) return "?";
    const refs = getClipDisplayRefs(replState.session.state.timeline);
    for (const clip of clipsInOrder(replState.session.state.timeline)) {
      if (clip.sourceId === sourceId) return refs.get(clip.id) ?? "?";
    }
    return "?";
  }

  // ── Viewport handlers ──────────────────────────────────────────────────────

  function totalDuration(state: ReplState): number {
    if (!state.session) return 0;
    return clipsInOrder(state.session.state.timeline).reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
  }

  function handleViewportZoom(dir: "in" | "out"): void {
    if (!timelineActive || !replState.session) return;
    const total = totalDuration(replState);
    const cur = viewport ?? { startTime: 0, viewDuration: total };
    const newViewport: ViewportState = {
      ...cur,
      viewDuration: Math.max(1, cur.viewDuration * (dir === "in" ? 0.667 : 1.5)),
    };
    setViewport(newViewport);
    const rendered = renderTimeline(replState.session.state, process.stdout.columns, newViewport)
      + "\n" + renderClipList(replState.session.state);
    setEntries((prev) => [...prev, {
      id: crypto.randomUUID(),
      input: `(zoom ${dir})`,
      output: rendered,
      isError: false,
    }]);
  }

  function handleViewportScroll(dir: "left" | "right"): void {
    if (!replState.session) return;
    const total = totalDuration(replState);
    const cur = viewport ?? { startTime: 0, viewDuration: total };
    const delta = cur.viewDuration * 0.2 * (dir === "right" ? 1 : -1);
    const newViewport: ViewportState = {
      ...cur,
      startTime: Math.max(0, cur.startTime + delta),
    };
    setViewport(newViewport);
    const rendered = renderTimeline(replState.session.state, process.stdout.columns, newViewport)
      + "\n" + renderClipList(replState.session.state);
    setEntries((prev) => [...prev, {
      id: crypto.randomUUID(),
      input: `(scroll ${dir})`,
      output: rendered,
      isError: false,
    }]);
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <OutputHistory entries={entries} pendingEntry={pendingEntry} />
      {expanded && <TurnDetailPanel details={turnDetails} />}
      {liveTurn && <LiveTurnView turn={liveTurn} scoutLabel={scoutLabel} frame={spinner} />}
      {pendingPlan && <ConfirmPlan plan={pendingPlan} />}
      {pendingPlan && previewStatus && (
        <Box paddingX={1}>
          <Text {...ui.muted}>{previewStatus}</Text>
        </Box>
      )}
      {replState.autoApprove && (
        <Box paddingX={1}>
          <Text {...ui.muted}>{`(approve-all mode is on ${glyphs.bullet} /auto off to disable)`}</Text>
        </Box>
      )}
      <InputLine
        value={inputValue}
        onChange={(v) => { setTimelineActive(false); setInputValue(v); }}
        onSubmit={handleSubmit}
        onHistoryUp={navigateUp}
        onHistoryDown={navigateDown}
        timelineActive={timelineActive}
        onViewportZoom={handleViewportZoom}
        onViewportScroll={handleViewportScroll}
        confirmMode={pendingPlan !== null}
        onConfirmAnswer={handleConfirmAnswer}
        onConfirmPreview={() => { void handleConfirmPreview(); }}
        previewActive={previewActive}
        onPreviewCancel={handlePreviewCancel}
        disabled={turnActive}
        spinner={spinner}
        queue={queue}
        onQueueType={(input) => applyQueue(typeIntoQueue(queueRef.current, input))}
        onQueueBackspace={() => applyQueue(backspaceQueue(queueRef.current))}
        onQueueEnter={() => applyQueue(markQueueReady(queueRef.current))}
        completionsFor={(prefix) => clipCompletions(replState.session?.state ?? null, prefix)}
        onToggleExpand={() => setExpanded((e) => !e)}
        onClearScreen={handleClearScreen}
      />
    </Box>
  );
}

// ── Live view of the streaming turn ────────────────────────────────────────────
//
// The one rule here (3I decision 6): in-flight work renders in color at normal
// weight; completed work settles to dim. "Happening now" and "already done"
// must be distinguishable at a glance.

/** Status glyph + one-glance style for a live row. */
function StatusGlyph({ state, frame }: { state: "running" | "ok" | "failed"; frame: number }) {
  if (state === "running") return <Text {...ui.inFlight}>{spinnerFrame(frame)}</Text>;
  if (state === "ok") return <Text {...ui.muted}>{glyphs.done}</Text>;
  return <Text {...ui.danger}>{glyphs.failed}</Text>;
}

function LiveTurnView({ turn, scoutLabel, frame }: {
  turn: LiveTurn;
  scoutLabel: (id: string) => string;
  frame: number;
}) {
  const nameWidth = Math.max(0, ...turn.tools.map((t) => displayToolName(t.name).length));
  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Parallel fan-out: one row, each source updating independently/out of order. */}
      {turn.scouts.length > 0 && (
        <Text>
          <Text {...ui.muted}>scouts  </Text>
          {turn.scouts.map((s) => (
            <Text key={s.sourceId}>
              <Text {...(s.status === "started" ? ui.inFlight : ui.muted)}>{`[${scoutLabel(s.sourceId)}] `}</Text>
              <StatusGlyph state={s.status === "completed" ? "ok" : s.status === "failed" ? "failed" : "running"} frame={frame} />
              <Text>{"  "}</Text>
            </Text>
          ))}
        </Text>
      )}
      {/* Tool indicators — name only, never streamed input JSON. */}
      {turn.tools.map((t) => (
        <Text key={t.key}>
          <StatusGlyph state={t.done ? (t.ok ? "ok" : "failed") : "running"} frame={frame} />
          <Text> </Text>
          <Text {...(t.done ? ui.muted : ui.emphasis)}>{displayToolName(t.name).padEnd(nameWidth)}</Text>
          {!t.done && <Text {...ui.muted}>{glyphs.ellipsis}</Text>}
        </Text>
      ))}
      {/* Critic passes (3G): animated while reviewing; a revise verdict keeps the
          concern count visible, an approve settles quietly. */}
      {turn.critic.map((c) => (
        <Text key={c.key}>
          <StatusGlyph state={c.done ? (c.verdict === "revise" ? "failed" : "ok") : "running"} frame={frame} />
          <Text {...(c.done ? ui.muted : ui.emphasis)}> reviewing plan</Text>
          {!c.done && <Text {...ui.muted}>{glyphs.ellipsis}</Text>}
          {c.done && c.verdict === "revise" && (
            <Text {...ui.warning}>{`  ${glyphs.revise} revised (${c.concerns} concern${c.concerns === 1 ? "" : "s"})`}</Text>
          )}
        </Text>
      ))}
      {/* Thinking: subtle animated glyph, text subordinate to assistant prose.
          Markdown is STRIPPED (not rendered) here — embedded style resets
          would cancel the dim-italic wrapper. */}
      {turn.thinking.trim().length > 0 && (
        <Text>
          <Text {...ui.accent}>{thinkingFrame(frame)}</Text>
          <Text {...ui.thinking}>{` thinking${glyphs.ellipsis} ${stripMarkdown(turn.thinking)}`}</Text>
        </Text>
      )}
      {/* Assistant prose streams in through the markdown renderer — the same
          text re-renders each delta, so constructs style as they close. */}
      {turn.text.length > 0 && <Text>{renderAgentProse(turn.text)}</Text>}
    </Box>
  );
}

/** Friendlier tool labels for the live rows; never the raw input JSON. */
function displayToolName(name: string): string {
  return name === "propose_edit_plan" ? "preparing plan" : name.replace(/_/g, " ");
}

// ── Ctrl+R tool-detail panel (3K) ────────────────────────────────────────────
//
// The audit view: which perception tools ran, with what arguments, what they
// returned, and why the critic revised. Renders only while expanded, over the
// bounded detail store (MAX_DETAIL_TURNS turns, values truncated) — collapsed
// costs nothing and committed Static history is never re-rendered.

function TurnDetailPanel({ details }: { details: TurnDetail[] }) {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text {...ui.heading}>
        {`tool detail — last ${Math.min(details.length, MAX_DETAIL_TURNS)} turn${details.length === 1 ? "" : "s"} retained (ctrl+r collapses)`}
      </Text>
      {details.length === 0 && <Text {...ui.muted}>(no agent turns with tool activity yet)</Text>}
      {details.map((turn) => (
        <Box key={turn.id} flexDirection="column" marginTop={1}>
          <Text>
            <Text {...ui.prompt}>{glyphs.prompt} </Text>
            <Text {...ui.emphasis}>{turn.prompt}</Text>
          </Text>
          {turn.items.map((item, i) => (
            <Box key={i} flexDirection="column">
              {item.kind === "tool" ? (
                <>
                  <Text>
                    <Text {...(item.ok ? ui.muted : ui.danger)}>{item.ok ? glyphs.done : glyphs.failed}</Text>
                    <Text {...ui.accent}> {item.name}</Text>
                  </Text>
                  <Text {...ui.muted}>{`    args ${formatDetailValue(item.input)}`}</Text>
                  <Text {...ui.muted}>{`    ${glyphs.arrow} ${formatDetailValue(item.result)}`}</Text>
                </>
              ) : (
                <>
                  <Text {...(item.verdict === "revise" ? ui.warning : ui.muted)}>
                    {`${item.verdict === "revise" ? glyphs.revise : glyphs.done} critic: ${item.verdict}`}
                  </Text>
                  {item.concerns.map((c, j) => (
                    <Text key={j} {...ui.muted}>
                      {`    ${c.severity}${c.operationIndex !== undefined ? ` ${glyphs.bullet} op ${c.operationIndex + 1}` : ""}: ${formatDetailValue(c.issue)}`}
                    </Text>
                  ))}
                </>
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

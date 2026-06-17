import { useState, useRef, useEffect } from "react";
import { Box, Text } from "ink";
import { Header } from "./components/Header.js";
import { OutputHistory, type HistoryEntry } from "./components/OutputHistory.js";
import { InputLine } from "./components/InputLine.js";
import { ConfirmPlan } from "./components/ConfirmPlan.js";
import { useCommandHistory } from "./hooks/useCommandHistory.js";
import { dispatch, type ReplState } from "./commands/dispatch.js";
import { renderTimeline, type ViewportState } from "../display/timeline.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { loadOrCreateProject } from "../cli/project-context.js";
import { clipsInOrder } from "../project/types.js";
import type { PlanForConfirmation } from "../agent/propose_edit_plan.js";
import type { ProgressEvent } from "../agent/loop.js";

export function App() {
  const [entries, setEntries]               = useState<HistoryEntry[]>([]);
  const [replState, setReplState]           = useState<ReplState>({
    session: null,
    messages: [],
    autoApprove: false,
  });
  const [inputValue, setInputValue]         = useState<string>("");
  const [viewport, setViewport]             = useState<ViewportState | null>(null);
  const [timelineActive, setTimelineActive] = useState<boolean>(false);
  const [pendingEntry, setPendingEntry]     = useState<HistoryEntry | null>(null);
  // Plan awaiting confirmation; presence puts InputLine in confirm mode.
  const [pendingPlan, setPendingPlan]       = useState<PlanForConfirmation | null>(null);

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
    setEntries((prev) => [...prev, {
      id: crypto.randomUUID(),
      input: approved ? "y" : "n",
      output: approved ? "Approved." : "Rejected.",
      isError: false,
    }]);
    resolve?.({ approved });
  }

  function handleAgentProgress(event: ProgressEvent): void {
    // Tool calls render as dim one-liners; assistant text streams through as
    // soon as it arrives. Errors get a marker.
    if (event.type === "tool_call") {
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        input: "",
        output: `→ ${event.name}(${truncateForProgress(event.input)})`,
        isError: false,
        dim: true,
      }]);
    } else if (event.type === "tool_result") {
      const tag = event.ok ? "✓" : "✗";
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        input: "",
        output: `${tag} ${event.name} (${event.durationMs}ms)`,
        isError: !event.ok,
        dim: true,
      }]);
    } else if (event.type === "assistant_text") {
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        input: "",
        output: event.text,
        isError: false,
      }]);
    }
  }

  async function handleSubmit(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (!trimmed) return;

    inputHistoryRef.current = [trimmed, ...inputHistoryRef.current];
    resetCursor();
    setInputValue("");
    setTimelineActive(false);

    const pendingId = crypto.randomUUID();
    setPendingEntry({ id: pendingId, input: trimmed, output: "Running…", isError: false });

    const result = await dispatch(trimmed, replState, {
      viewport: viewport ?? undefined,
      confirm: makeConfirmCallback(),
      onAgentProgress: handleAgentProgress,
    });

    setPendingEntry(null);
    setEntries((prev) => [...prev, {
      id: pendingId,
      input: trimmed,
      output: result.output,
      isError: result.isError,
    }]);

    if (result.newState) setReplState(result.newState);
    if (result.activatesTimeline) setTimelineActive(true);
    if (result.shouldExit) setTimeout(() => process.exit(0), 50);
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
      {pendingPlan && <ConfirmPlan plan={pendingPlan} />}
      {replState.autoApprove && (
        <Box paddingX={1}>
          <Text dimColor>(approve-all mode is on — /auto off to disable)</Text>
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
      />
    </Box>
  );
}

function truncateForProgress(input: unknown): string {
  const s = JSON.stringify(input);
  if (!s) return "";
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

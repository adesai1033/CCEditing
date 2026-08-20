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

  // Streamed events fold into the ephemeral live view. Nothing here commits to
  // history — that happens once at turn end (handleSubmit) with the loop's final
  // output, so streamed text is never double-rendered.
  function handleAgentProgress(event: ProgressEvent): void {
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

  async function handleSubmit(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (!trimmed || turnActive) return;   // no re-entry while a turn streams

    inputHistoryRef.current = [trimmed, ...inputHistoryRef.current];
    resetCursor();
    setInputValue("");
    setTimelineActive(false);

    const pendingId = crypto.randomUUID();
    setPendingEntry({ id: pendingId, input: trimmed, output: "Running…", isError: false });
    // Open the live view for this turn and lock input until it finishes.
    setLiveTurn({ ...EMPTY_TURN });
    setTurnActive(true);

    const result = await dispatch(trimmed, replState, {
      viewport: viewport ?? undefined,
      confirm: makeConfirmCallback(),
      onAgentProgress: handleAgentProgress,
    });

    // Finalize: drop the ephemeral live view and commit the loop's final output
    // once as static history (streamed text was shown live, not committed).
    setLiveTurn(null);
    setTurnActive(false);
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
      {liveTurn && <LiveTurnView turn={liveTurn} scoutLabel={scoutLabel} />}
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
        disabled={turnActive}
      />
    </Box>
  );
}

// ── Live view of the streaming turn ────────────────────────────────────────────

function LiveTurnView({ turn, scoutLabel }: { turn: LiveTurn; scoutLabel: (id: string) => string }) {
  const scoutGlyph = (s: LiveScout["status"]) => (s === "completed" ? "✓" : s === "failed" ? "✗" : "…");
  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Parallel fan-out: one row, each source updating independently/out of order. */}
      {turn.scouts.length > 0 && (
        <Text dimColor>
          {"scouting  " + turn.scouts.map((s) => `[${scoutLabel(s.sourceId)}] ${scoutGlyph(s.status)}`).join("  ")}
        </Text>
      )}
      {/* Tool indicators — name only, never streamed input JSON. */}
      {turn.tools.map((t) => (
        <Text key={t.key} dimColor>
          {t.name === "propose_edit_plan"
            ? `→ preparing plan…${t.done ? " done" : ""}`
            : `→ ${t.name}${t.done ? (t.ok ? " ✓" : " ✗") : "…"}`}
        </Text>
      ))}
      {/* Critic passes (3G): a dim line per review; a revise verdict notes the
          concern count, an approve resolves quietly. */}
      {turn.critic.map((c) => (
        <Text key={c.key} dimColor>
          {c.done && c.verdict === "revise"
            ? `✻ reviewing plan…  → revised (${c.concerns} concern${c.concerns === 1 ? "" : "s"})`
            : `✻ reviewing plan…${c.done ? " ✓" : ""}`}
        </Text>
      ))}
      {/* Thinking summary streams in, dim and distinct. */}
      {turn.thinking.trim().length > 0 && <Text dimColor>{`✻ thinking… ${turn.thinking}`}</Text>}
      {/* Assistant prose streams in, normal weight. */}
      {turn.text.length > 0 && <Text>{turn.text}</Text>}
    </Box>
  );
}

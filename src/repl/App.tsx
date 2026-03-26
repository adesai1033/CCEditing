import { useState, useRef, useEffect } from "react";
import { Box } from "ink";
import { Header } from "./components/Header.js";
import { OutputHistory, type HistoryEntry } from "./components/OutputHistory.js";
import { InputLine } from "./components/InputLine.js";
import { useCommandHistory } from "./hooks/useCommandHistory.js";
import { dispatch, type ReplState } from "./commands/dispatch.js";
import { renderTimeline, type ViewportState } from "../display/timeline.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { loadOrCreateProject } from "../cli/project-context.js";

export function App() {
  const [entries, setEntries]               = useState<HistoryEntry[]>([]);
  const [replState, setReplState]           = useState<ReplState>({ project: null });
  const [inputValue, setInputValue]         = useState<string>("");
  const [viewport, setViewport]             = useState<ViewportState | null>(null);
  const [timelineActive, setTimelineActive] = useState<boolean>(false);
  const [pendingEntry, setPendingEntry]     = useState<HistoryEntry | null>(null);

  const inputHistoryRef = useRef<string[]>([]);

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
        setReplState({ project: ctx.state });
        const clipCount = ctx.state.timeline.clips.length;
        setEntries([{
          id,
          input: "(startup)",
          output: `Loaded project  ·  ${clipCount} clip${clipCount === 1 ? "" : "s"}`,
          isError: false,
        }]);
      }
    })();
  }, []);

  async function handleSubmit(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (!trimmed) return;

    inputHistoryRef.current = [trimmed, ...inputHistoryRef.current];
    resetCursor();
    setInputValue("");
    setTimelineActive(false);

    const pendingId = crypto.randomUUID();
    setPendingEntry({ id: pendingId, input: trimmed, output: "Running…", isError: false });

    const result = await dispatch(trimmed, replState, viewport ?? undefined);

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
    if (!state.project) return 0;
    return state.project.timeline.clips.reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
  }

  function handleViewportZoom(dir: "in" | "out"): void {
    if (!timelineActive || !replState.project) return;
    const total = totalDuration(replState);
    const cur = viewport ?? { startTime: 0, viewDuration: total };
    const newViewport: ViewportState = {
      ...cur,
      viewDuration: Math.max(1, cur.viewDuration * (dir === "in" ? 0.667 : 1.5)),
    };
    setViewport(newViewport);
    const rendered = renderTimeline(replState.project, process.stdout.columns, newViewport)
      + "\n" + renderClipList(replState.project);
    setEntries((prev) => [...prev, {
      id: crypto.randomUUID(),
      input: `(zoom ${dir})`,
      output: rendered,
      isError: false,
    }]);
  }

  function handleViewportScroll(dir: "left" | "right"): void {
    if (!replState.project) return;
    const total = totalDuration(replState);
    const cur = viewport ?? { startTime: 0, viewDuration: total };
    const delta = cur.viewDuration * 0.2 * (dir === "right" ? 1 : -1);
    const newViewport: ViewportState = {
      ...cur,
      startTime: Math.max(0, cur.startTime + delta),
    };
    setViewport(newViewport);
    const rendered = renderTimeline(replState.project, process.stdout.columns, newViewport)
      + "\n" + renderClipList(replState.project);
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
      <InputLine
        value={inputValue}
        onChange={(v) => { setTimelineActive(false); setInputValue(v); }}
        onSubmit={handleSubmit}
        onHistoryUp={navigateUp}
        onHistoryDown={navigateDown}
        timelineActive={timelineActive}
        onViewportZoom={handleViewportZoom}
        onViewportScroll={handleViewportScroll}
      />
    </Box>
  );
}

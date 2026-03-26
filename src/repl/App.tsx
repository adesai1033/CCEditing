import { useState, useRef } from "react";
import { Box } from "ink";
import { Header } from "./components/Header.js";
import { OutputHistory, type HistoryEntry } from "./components/OutputHistory.js";
import { InputLine } from "./components/InputLine.js";
import { useCommandHistory } from "./hooks/useCommandHistory.js";
import { dispatch, type ReplState } from "./commands/dispatch.js";

export function App() {
  const [entries, setEntries]       = useState<HistoryEntry[]>([]);
  const [replState, setReplState]   = useState<ReplState>({ project: null });
  const [inputValue, setInputValue] = useState<string>("");

  // History is newest-first so navigateUp goes to the most recent command
  const inputHistoryRef = useRef<string[]>([]);

  const { navigateUp, navigateDown, resetCursor } = useCommandHistory(
    inputHistoryRef.current,
    setInputValue,
  );

  function handleSubmit(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // Record in history (prepend so index 0 = most recent)
    inputHistoryRef.current = [trimmed, ...inputHistoryRef.current];
    resetCursor();

    const result = dispatch(trimmed, replState);

    setEntries((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        input: trimmed,
        output: result.output,
        isError: result.isError,
      },
    ]);

    if (result.newState) {
      setReplState(result.newState);
    }

    setInputValue("");

    if (result.shouldExit) {
      // Defer so the final entry renders before exit
      setTimeout(() => process.exit(0), 50);
    }
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <OutputHistory entries={entries} />
      <InputLine
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        onHistoryUp={navigateUp}
        onHistoryDown={navigateDown}
      />
    </Box>
  );
}

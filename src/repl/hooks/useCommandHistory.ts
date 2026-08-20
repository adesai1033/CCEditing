import { useState } from "react";

/**
 * Pure history-cursor stepper (extracted in 3K for testability).
 * cursor = -1 means "not navigating" (empty / current draft).
 * Returns null when the step is a no-op.
 */
export function stepHistory(
  history: string[],
  cursor: number,
  direction: "up" | "down",
): { cursor: number; value: string } | null {
  if (direction === "up") {
    if (history.length === 0) return null;
    const next = cursor === -1 ? 0 : Math.min(cursor + 1, history.length - 1);
    return { cursor: next, value: history[next] ?? "" };
  }
  if (cursor === -1) return null;
  const next = cursor - 1;
  if (next < 0) return { cursor: -1, value: "" };
  return { cursor: next, value: history[next] ?? "" };
}

/**
 * Manages up/down arrow navigation through command history.
 */
export function useCommandHistory(
  history: string[],
  setValue: (v: string) => void,
): { navigateUp: () => void; navigateDown: () => void; resetCursor: () => void } {
  const [cursor, setCursor] = useState<number>(-1);

  function navigate(direction: "up" | "down"): void {
    const step = stepHistory(history, cursor, direction);
    if (!step) return;
    setCursor(step.cursor);
    setValue(step.value);
  }

  return {
    navigateUp: () => navigate("up"),
    navigateDown: () => navigate("down"),
    resetCursor: () => setCursor(-1),
  };
}

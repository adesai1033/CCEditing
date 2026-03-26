import { useState } from "react";

/**
 * Manages up/down arrow navigation through command history.
 * cursor = -1 means "not navigating" (empty / current draft).
 */
export function useCommandHistory(
  history: string[],
  setValue: (v: string) => void,
): { navigateUp: () => void; navigateDown: () => void; resetCursor: () => void } {
  const [cursor, setCursor] = useState<number>(-1);

  function navigateUp(): void {
    if (history.length === 0) return;
    const next = cursor === -1 ? 0 : Math.min(cursor + 1, history.length - 1);
    setCursor(next);
    setValue(history[next] ?? "");
  }

  function navigateDown(): void {
    if (cursor === -1) return;
    const next = cursor - 1;
    if (next < 0) {
      setCursor(-1);
      setValue("");
    } else {
      setCursor(next);
      setValue(history[next] ?? "");
    }
  }

  function resetCursor(): void {
    setCursor(-1);
  }

  return { navigateUp, navigateDown, resetCursor };
}

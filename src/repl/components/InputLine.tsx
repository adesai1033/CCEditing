import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { ui, panels, glyphs, spinnerFrame } from "../../ui/theme.js";
import { completionQuery, applyCompletion, type ClipCompletion } from "../completions.js";
import type { InputQueue } from "../queue.js";

const MAX_COMPLETION_ROWS = 6;

/**
 * Key routing (3K), resolved by context — stated explicitly:
 *   1. Ctrl+C — cancel a preview render, else exit.  Ctrl+R — toggle tool
 *      detail.  Ctrl+L — clear the screen. These work in every mode.
 *   2. Turn active (disabled): printable keys COMPOSE THE QUEUE; Enter marks
 *      it ready; backspace edits it.
 *   3. Confirm gate: y/n/p only (3G/3H, unchanged).
 *   4. `@` completion open: ↑/↓ move the selection, Tab inserts, Esc
 *      dismisses. Completion wins the arrows while open.
 *   5. Timeline active: ↑/↓ zoom, ←/→ scroll (3C-3, unchanged).
 *   6. Otherwise: ↑/↓ walk input history (3C, unchanged).
 */

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  timelineActive: boolean;
  onViewportZoom: (dir: "in" | "out") => void;
  onViewportScroll: (dir: "left" | "right") => void;
  /** When set, the line is in plan-confirmation mode: y/n/p only, text input disabled. */
  confirmMode?: boolean;
  /** Called when the user presses y or n in confirm mode. */
  onConfirmAnswer?: (approved: boolean) => void;
  /** Called when the user presses p in confirm mode — preview, then return to the gate (3H). */
  onConfirmPreview?: () => void;
  /** When set, a preview render is in flight: Ctrl-C cancels it instead of exiting. */
  previewActive?: boolean;
  /** Cancels the in-flight preview render (decision 6). */
  onPreviewCancel?: () => void;
  /** When set, a turn is streaming: typing composes the queue (3K). */
  disabled?: boolean;
  /** Shared animation frame from the App's single ticker (3I). */
  spinner?: number;
  /** 3K queued type-ahead: current queue + composition callbacks. */
  queue?: InputQueue;
  onQueueType?: (input: string) => void;
  onQueueBackspace?: () => void;
  onQueueEnter?: () => void;
  /** 3K `@` completion source over live clip refs. */
  completionsFor?: (prefix: string) => ClipCompletion[];
  /** 3K Ctrl+R / Ctrl+L. */
  onToggleExpand?: () => void;
  onClearScreen?: () => void;
}

/** A key affordance: the key itself styled as a keycap, its meaning muted. */
function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text {...ui.key}>{k}</Text>
      <Text {...ui.muted}> {label}</Text>
    </Text>
  );
}

export function InputLine({
  value, onChange, onSubmit,
  onHistoryUp, onHistoryDown,
  timelineActive, onViewportZoom, onViewportScroll,
  confirmMode = false, onConfirmAnswer, onConfirmPreview,
  previewActive = false, onPreviewCancel,
  disabled = false,
  spinner = 0,
  queue, onQueueType, onQueueBackspace, onQueueEnter,
  completionsFor,
  onToggleExpand, onClearScreen,
}: Props) {
  // `@` completion state: selection index plus the input value at dismissal —
  // any edit after Esc reopens the list.
  const [selected, setSelected] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  // ink-text-input does not filter ctrl+letter chords — a Ctrl+R ALSO inserts
  // a literal "r". Handler order isn't guaranteed (child hooks register
  // first), so the guard works both ways: if the echo already landed, strip
  // it retroactively; otherwise arm a one-shot swallow for when it arrives.
  const swallowRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  function handleChange(next: string): void {
    const swallow = swallowRef.current;
    swallowRef.current = null;
    if (swallow !== null && next === valueRef.current + swallow) return;
    valueRef.current = next;
    onChange(next);
  }

  function stripChordEcho(letter: string): void {
    if (valueRef.current.endsWith(letter)) {
      valueRef.current = valueRef.current.slice(0, -1);
      onChange(valueRef.current);
    } else {
      swallowRef.current = letter;
    }
  }

  const query = !disabled && !confirmMode ? completionQuery(value) : null;
  const items: ClipCompletion[] =
    query !== null && dismissedAt !== value && completionsFor
      ? completionsFor(query).slice(0, MAX_COMPLETION_ROWS)
      : [];
  const completionOpen = items.length > 0;
  const sel = Math.min(selected, Math.max(0, items.length - 1));

  function insertCompletion(): void {
    const chosen = items[sel];
    if (!chosen) return;
    onChange(applyCompletion(value, chosen.ref));
    setSelected(0);
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // Ctrl-C during a preview render cancels the render, not the REPL (3H).
      if (previewActive) { onPreviewCancel?.(); return; }
      process.exit(0);
    }
    // View-state toggles work in every mode (3K).
    if (key.ctrl && input === "r") { stripChordEcho("r"); onToggleExpand?.(); return; }
    if (key.ctrl && input === "l") { stripChordEcho("l"); onClearScreen?.(); return; }

    // Turn active (not the confirm gate): keystrokes compose the queue (3K).
    if (disabled && !confirmMode) {
      if (key.return) onQueueEnter?.();
      else if (key.backspace || key.delete) onQueueBackspace?.();
      else if (input && !key.ctrl && !key.meta && !key.escape) onQueueType?.(input);
      return;
    }
    if (confirmMode) {
      // A render in flight: only Ctrl-C acts; the gate resumes when it's done.
      if (previewActive) return;
      // y/n/p only — intercept before anything else, swallow other input.
      if (input === "y" || input === "Y") onConfirmAnswer?.(true);
      else if (input === "n" || input === "N") onConfirmAnswer?.(false);
      else if (input === "p" || input === "P") onConfirmPreview?.();
      return;
    }
    // Completion owns the arrows while open; Esc dismisses, Tab inserts.
    if (completionOpen) {
      if (key.escape) { setDismissedAt(value); return; }
      if (key.tab) { insertCompletion(); return; }
      if (key.upArrow) { setSelected(Math.max(0, sel - 1)); return; }
      if (key.downArrow) { setSelected(Math.min(items.length - 1, sel + 1)); return; }
    }
    if (key.upArrow) {
      timelineActive ? onViewportZoom("in") : onHistoryUp();
    }
    if (key.downArrow) {
      timelineActive ? onViewportZoom("out") : onHistoryDown();
    }
    if (key.leftArrow)  { onViewportScroll("left"); }
    if (key.rightArrow) { onViewportScroll("right"); }
  });

  if (confirmMode) {
    return (
      <Box flexDirection="column">
        <Box {...panels.gate} paddingX={1}>
          {previewActive ? (
            <Text>
              <Text {...ui.inFlight}>{spinnerFrame(spinner)} </Text>
              <Text {...ui.muted}>rendering preview{glyphs.ellipsis}  ctrl-c to cancel</Text>
            </Text>
          ) : (
            <Text>
              <Text {...ui.warningEmphasis}>Apply this plan?</Text>
              <Text>{"   "}</Text>
              <Key k="y" label="apply" />
              <Text {...ui.muted}>{`  ${glyphs.bullet}  `}</Text>
              <Key k="n" label="reject" />
              <Text {...ui.muted}>{`  ${glyphs.bullet}  `}</Text>
              <Key k="p" label="preview" />
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  if (disabled) {
    return (
      <Box flexDirection="column">
        <Box {...panels.waiting} paddingX={1}>
          <Text {...ui.inFlight}>{spinnerFrame(spinner)} </Text>
          <Text {...ui.muted}>working{glyphs.ellipsis} type to queue the next instruction</Text>
        </Box>
        {queue && queue.text.length > 0 && (
          <Box paddingX={1}>
            <Text {...ui.muted}>{`${glyphs.queued} queued${queue.ready ? ` ${glyphs.enter}` : ""}: `}</Text>
            <Text>{queue.text}</Text>
            {!queue.ready && <Text {...ui.muted}>  (enter to send when the turn ends)</Text>}
          </Box>
        )}
      </Box>
    );
  }

  const hint = timelineActive
    ? <Text {...ui.muted}>{`  ←→ scroll  ↑↓ zoom  (type to exit timeline mode)`}</Text>
    : null;

  return (
    <Box flexDirection="column">
      {hint}
      {completionOpen && (
        <Box flexDirection="column" paddingX={1}>
          {items.map((c, i) => (
            <Text key={c.ref}>
              <Text {...(i === sel ? ui.key : ui.accent)}>{`[${c.ref}]`}</Text>
              <Text {...(i === sel ? ui.emphasis : ui.muted)}> {c.name}</Text>
              {c.userLabel !== undefined && <Text {...ui.warning}>{`  ${glyphs.label} ${c.userLabel}`}</Text>}
            </Text>
          ))}
          <Text {...ui.muted}>{`  tab insert ${glyphs.bullet} esc dismiss ${glyphs.bullet} ↑↓ select`}</Text>
        </Box>
      )}
      <Box {...panels.input} paddingX={1}>
        <Text {...ui.prompt}>{glyphs.prompt} </Text>
        <TextInput value={value} onChange={handleChange} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}

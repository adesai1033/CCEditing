import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  timelineActive: boolean;
  onViewportZoom: (dir: "in" | "out") => void;
  onViewportScroll: (dir: "left" | "right") => void;
  /** When set, the line is in plan-confirmation mode: y/n only, text input disabled. */
  confirmMode?: boolean;
  /** Called when the user presses y or n in confirm mode. */
  onConfirmAnswer?: (approved: boolean) => void;
  /** When set, a turn is streaming: input is disabled (no typing mid-stream, 3E-4). */
  disabled?: boolean;
}

export function InputLine({
  value, onChange, onSubmit,
  onHistoryUp, onHistoryDown,
  timelineActive, onViewportZoom, onViewportScroll,
  confirmMode = false, onConfirmAnswer,
  disabled = false,
}: Props) {
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      process.exit(0);
    }
    // During an active turn (not the confirm gate) swallow everything but Ctrl-C.
    if (disabled && !confirmMode) return;
    if (confirmMode) {
      // y/n only — intercept before anything else, swallow other input.
      if (input === "y" || input === "Y") onConfirmAnswer?.(true);
      else if (input === "n" || input === "N") onConfirmAnswer?.(false);
      return;
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
        <Box borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Apply plan? [y/n]</Text>
        </Box>
      </Box>
    );
  }

  if (disabled) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>› working… (input paused)</Text>
      </Box>
    );
  }

  const hint = timelineActive
    ? <Text dimColor>  ←→ scroll  ↑↓ zoom  (type to exit timeline mode)</Text>
    : null;

  return (
    <Box flexDirection="column">
      {hint}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">› </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}

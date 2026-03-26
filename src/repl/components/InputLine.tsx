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
}

export function InputLine({
  value, onChange, onSubmit,
  onHistoryUp, onHistoryDown,
  timelineActive, onViewportZoom, onViewportScroll,
}: Props) {
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      process.exit(0);
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

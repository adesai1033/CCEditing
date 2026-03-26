import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
}

export function InputLine({ value, onChange, onSubmit, onHistoryUp, onHistoryDown }: Props) {
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      process.exit(0);
    }
    if (key.upArrow) {
      onHistoryUp();
    }
    if (key.downArrow) {
      onHistoryDown();
    }
  });

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">› </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

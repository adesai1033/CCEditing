import { Box, Text } from "ink";

export function Header() {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">CutCLI</Text>
      <Text dimColor>  v0.2.0  —  type /help for commands, /quit to exit</Text>
    </Box>
  );
}

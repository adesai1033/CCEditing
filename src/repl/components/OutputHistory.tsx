import { Box, Static, Text } from "ink";

export interface HistoryEntry {
  id: string;
  input: string;
  output: string;
  isError: boolean;
}

interface Props {
  entries: HistoryEntry[];
  pendingEntry?: HistoryEntry | null;
}

export function OutputHistory({ entries, pendingEntry }: Props) {
  const hasContent = entries.length > 0 || pendingEntry;

  return (
    <Box flexGrow={1} flexDirection="column">
      {!hasContent && (
        <Box paddingX={1}>
          <Text dimColor>No output yet. Type a command to get started.</Text>
        </Box>
      )}
      {entries.length > 0 && (
        <Static items={entries}>
          {(entry) => (
            <Box key={entry.id} flexDirection="column" paddingX={1} marginBottom={1}>
              <Text color="green" bold>› {entry.input}</Text>
              <Text color={entry.isError ? "red" : undefined}>{entry.output}</Text>
            </Box>
          )}
        </Static>
      )}
      {pendingEntry && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text color="green" bold>› {pendingEntry.input}</Text>
          <Text dimColor>{pendingEntry.output}</Text>
        </Box>
      )}
    </Box>
  );
}

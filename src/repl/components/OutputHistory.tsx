import { Box, Static, Text } from "ink";
import { ui, glyphs } from "../../ui/theme.js";

export interface HistoryEntry {
  id: string;
  input: string;
  output: string;
  isError: boolean;
  /** Render this entry's output as dimmed (used for agent tool-call progress lines). */
  dim?: boolean;
}

interface Props {
  entries: HistoryEntry[];
  pendingEntry?: HistoryEntry | null;
}

/** One committed exchange: the echoed input line, then its output. */
function Entry({ entry, pending }: { entry: HistoryEntry; pending?: boolean }) {
  const outputStyle = entry.isError ? ui.danger : entry.dim || pending ? ui.muted : {};
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={entry.dim ? 0 : 1}>
      {entry.input && (
        <Text>
          <Text {...ui.prompt}>{glyphs.prompt} </Text>
          <Text {...ui.emphasis}>{entry.input}</Text>
        </Text>
      )}
      <Text {...outputStyle}>{entry.output}</Text>
    </Box>
  );
}

export function OutputHistory({ entries, pendingEntry }: Props) {
  const hasContent = entries.length > 0 || pendingEntry;

  return (
    <Box flexGrow={1} flexDirection="column">
      {!hasContent && (
        <Box paddingX={1}>
          <Text {...ui.muted}>No output yet. Type a command to get started.</Text>
        </Box>
      )}
      {entries.length > 0 && (
        <Static items={entries}>
          {(entry) => <Entry key={entry.id} entry={entry} />}
        </Static>
      )}
      {pendingEntry && <Entry entry={pendingEntry} pending />}
    </Box>
  );
}

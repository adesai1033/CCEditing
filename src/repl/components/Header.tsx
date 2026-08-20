import { Box, Text } from "ink";
import { ui, panels, glyphs } from "../../ui/theme.js";

export function Header() {
  return (
    <Box {...panels.header} paddingX={1}>
      <Text {...ui.heading}>CutCLI</Text>
      <Text {...ui.muted}>{`  v0.2.0  ${glyphs.bullet}  /help for commands  ${glyphs.bullet}  /quit to exit`}</Text>
    </Box>
  );
}

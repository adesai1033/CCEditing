export interface CommandDef {
  name: string;
  syntax: string;
  description: string;
}

export const COMMANDS: CommandDef[] = [
  { name: "open",     syntax: "/open <file>",                description: "Import a video file into the project" },
  { name: "trim",     syntax: "/trim <index> <start> <end>", description: "Trim a clip by 1-based index" },
  { name: "move",     syntax: "/move <from> <to>",           description: "Move a clip to a new position (1-based indices)" },
  { name: "split",    syntax: "/split <clip> <time>",        description: "Split a clip at a source time into two clips" },
  { name: "timeline", syntax: "/timeline",                   description: "Show the current timeline" },
  { name: "export",   syntax: "/export <output>",            description: "Export the timeline to a file" },
  { name: "help",     syntax: "/help",                       description: "Show this help message" },
  { name: "quit",     syntax: "/quit",                       description: "Exit CutCLI" },
];

export function buildHelpText(): string {
  const lines = ["Available commands:", ""];
  const maxSyntax = Math.max(...COMMANDS.map((c) => c.syntax.length));
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.syntax.padEnd(maxSyntax + 2)}${cmd.description}`);
  }
  return lines.join("\n");
}

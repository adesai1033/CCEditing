import { paint, glyphs } from "../../ui/theme.js";

export interface CommandDef {
  name: string;
  syntax: string;
  description: string;
  /** /help section this command is listed under. */
  group: "Project" | "Editing" | "History" | "Agent" | "Session";
}

export const COMMANDS: CommandDef[] = [
  { name: "open",     group: "Project", syntax: "/open <file>",                description: "Import a video file into the project" },
  { name: "timeline", group: "Project", syntax: "/timeline",                   description: "Show the current timeline" },
  { name: "export",   group: "Project", syntax: "/export <output>",            description: "Export the timeline to a file" },
  { name: "preview",  group: "Project", syntax: "/preview [clip | start end]", description: "Render and play the timeline (or a clip / range)" },
  { name: "trim",     group: "Editing", syntax: "/trim <index> <start> <end>", description: "Trim a clip by 1-based index" },
  { name: "move",     group: "Editing", syntax: "/move <from> <to>",           description: "Move a clip to a new position (1-based indices)" },
  { name: "split",    group: "Editing", syntax: "/split <clip> <time>",        description: "Split a clip at a source time into two clips" },
  { name: "delete",   group: "Editing", syntax: "/delete <clip>",              description: "Remove a clip from the timeline" },
  { name: "label",    group: "Editing", syntax: "/label <clip> [text]",        description: "Annotate a clip (omit text to show); the agent can act on it" },
  { name: "unlabel",  group: "Editing", syntax: "/unlabel <clip>",             description: "Clear a clip's annotation" },
  { name: "undo",     group: "History", syntax: "/undo",                       description: "Undo the most recent change" },
  { name: "redo",     group: "History", syntax: "/redo",                       description: "Redo the most recently undone change" },
  { name: "auto",     group: "Agent",   syntax: "/auto [on|off]",              description: "Toggle agent approve-all mode" },
  { name: "critic",   group: "Agent",   syntax: "/critic [on|off]",            description: "Toggle plan review before confirmation (default on)" },
  { name: "compact",  group: "Agent",   syntax: "/compact",                    description: "Compact conversation history (also automatic when it grows)" },
  { name: "resume",   group: "Agent",   syntax: "/resume",                     description: "Resume this project's saved conversation" },
  { name: "clear",    group: "Agent",   syntax: "/clear",                      description: "Reset agent conversation memory (state untouched)" },
  { name: "cost",     group: "Session", syntax: "/cost",                       description: "Show session token usage by role (director / scouts / critic)" },
  { name: "help",     group: "Session", syntax: "/help",                       description: "Show this help message" },
  { name: "quit",     group: "Session", syntax: "/quit",                       description: "Exit CutCLI" },
];

const GROUP_ORDER: CommandDef["group"][] = ["Project", "Editing", "History", "Agent", "Session"];

export function buildHelpText(): string {
  const maxSyntax = Math.max(...COMMANDS.map((c) => c.syntax.length));
  const lines = [paint.heading("Available commands:")];

  for (const group of GROUP_ORDER) {
    const cmds = COMMANDS.filter((c) => c.group === group);
    if (cmds.length === 0) continue;
    lines.push("", paint.muted(`  ${group}`));
    for (const cmd of cmds) {
      lines.push(`    ${paint.emphasis(cmd.syntax.padEnd(maxSyntax + 2))}${paint.muted(cmd.description)}`);
    }
  }

  lines.push("", paint.muted(`  Anything without a leading slash goes to the editing agent ${glyphs.bullet} "cut the pause before I start talking"`));
  return lines.join("\n");
}

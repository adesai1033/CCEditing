import type { ProjectState } from "../../project/types.js";
import { buildHelpText } from "./registry.js";

export interface ReplState {
  project: ProjectState | null;
}

export interface DispatchResult {
  output: string;
  isError: boolean;
  newState?: ReplState;
  shouldExit?: boolean;
}

export function dispatch(raw: string, state: ReplState): DispatchResult {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("/")) {
    return {
      output: "Unknown input. Type /help to see available commands.",
      isError: true,
    };
  }

  const [token, ...args] = trimmed.slice(1).split(/\s+/);
  const cmd = token?.toLowerCase();

  // Suppress unused-variable warning for args until 3C-3 wires them
  void args;

  switch (cmd) {
    case "help":
      return { output: buildHelpText(), isError: false };

    case "quit":
      return { output: "Goodbye.", isError: false, shouldExit: true };

    case "open":
      return { output: "[/open not yet implemented]", isError: false };

    case "trim":
      return { output: "[/trim not yet implemented]", isError: false };

    case "timeline":
      return { output: "[/timeline not yet implemented]", isError: false };

    case "export":
      return { output: "[/export not yet implemented]", isError: false };

    default:
      return {
        output: `Unknown command: /${cmd}. Type /help for available commands.`,
        isError: true,
      };
  }
}

import path from "node:path";
import { existsSync } from "node:fs";
import type { ProjectState } from "../project/types.js";
import { createProject, loadProject, saveProject } from "../project/io.js";

/** The canonical project file location: always `.cutcli.json` in the CWD. */
export function projectFilePath(): string {
  return path.join(process.cwd(), ".cutcli.json");
}

/** Load an existing project from CWD, or create a fresh one named after the CWD basename. */
export async function loadOrCreateProject(): Promise<
  | { ok: true; state: ProjectState; existed: boolean }
  | { ok: false; error: string }
> {
  const filePath = projectFilePath();
  if (existsSync(filePath)) {
    try {
      const state = await loadProject(filePath);
      return { ok: true, state, existed: true };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error).message };
    }
  }
  const name = path.basename(process.cwd());
  return { ok: true, state: createProject(name), existed: false };
}

/** Save the project to the standard CWD location. */
export async function saveProjectToStandardPath(
  state: ProjectState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await saveProject(state, projectFilePath());
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

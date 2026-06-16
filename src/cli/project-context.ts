import path from "node:path";
import { existsSync } from "node:fs";
import { createProject, loadProject, saveProject } from "../project/io.js";
import { createSession, type ProjectSession } from "../project/session.js";

/** The canonical project file location: always `.cutcli.json` in the CWD. */
export function projectFilePath(): string {
  return path.join(process.cwd(), ".cutcli.json");
}

/** Load an existing project session from CWD, or create a fresh one named after the CWD basename. */
export async function loadOrCreateProject(): Promise<
  | { ok: true; session: ProjectSession; existed: boolean }
  | { ok: false; error: string }
> {
  const filePath = projectFilePath();
  if (existsSync(filePath)) {
    try {
      const session = await loadProject(filePath);
      return { ok: true, session, existed: true };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error).message };
    }
  }
  const name = path.basename(process.cwd());
  return { ok: true, session: createSession(createProject(name)), existed: false };
}

/** Save the project session to the standard CWD location. */
export async function saveProjectToStandardPath(
  session: ProjectSession,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await saveProject(session, projectFilePath());
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

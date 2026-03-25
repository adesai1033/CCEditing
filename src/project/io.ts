import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ProjectState, SourceFile } from "./types.js";

const SUPPORTED_VERSION = 1;

// ── Create ────────────────────────────────────────────────────────────────────

export function createProject(name: string): ProjectState {
  const ts = new Date().toISOString();
  return {
    version: SUPPORTED_VERSION,
    name,
    createdAt: ts,
    updatedAt: ts,
    sources: [],
    timeline: { clips: [] },
  };
}

// ── Save ──────────────────────────────────────────────────────────────────────

export async function saveProject(state: ProjectState, filePath: string): Promise<void> {
  const json = JSON.stringify(state, null, 2);
  await writeFile(filePath, json, "utf-8");
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadProject(filePath: string): Promise<ProjectState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new Error(`Project file not found: ${filePath}`);
    throw new Error(`Failed to read project file: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Project file is not valid JSON: ${filePath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Project file has unexpected structure: ${filePath}`);
  }

  const state = parsed as Record<string, unknown>;

  if (typeof state["version"] !== "number") {
    throw new Error(`Project file is missing a version field: ${filePath}`);
  }
  if (state["version"] !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported project version ${state["version"]} (expected ${SUPPORTED_VERSION})`
    );
  }

  if (typeof state["name"] !== "string") {
    throw new Error(`Project file is missing required field "name": ${filePath}`);
  }
  if (!Array.isArray(state["sources"])) {
    throw new Error(`Project file is missing required field "sources": ${filePath}`);
  }
  if (typeof state["timeline"] !== "object" || state["timeline"] === null || !Array.isArray((state["timeline"] as Record<string, unknown>)["clips"])) {
    throw new Error(`Project file is missing required field "timeline.clips": ${filePath}`);
  }

  return parsed as ProjectState;
}

// ── Source validation ─────────────────────────────────────────────────────────

export async function validateSources(
  state: ProjectState
): Promise<{ valid: SourceFile[]; missing: SourceFile[] }> {
  const results = await Promise.all(
    state.sources.map(async (source) => {
      try {
        await access(source.filePath, constants.F_OK);
        return { source, exists: true };
      } catch {
        return { source, exists: false };
      }
    })
  );

  return {
    valid:   results.filter((r) => r.exists).map((r) => r.source),
    missing: results.filter((r) => !r.exists).map((r) => r.source),
  };
}

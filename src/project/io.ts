import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ProjectState, SourceFile, Clip, Timeline } from "./types.js";

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
    timeline: { headId: null, tailId: null, clips: {} },
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

  const timeline = state["timeline"] as Record<string, unknown> | undefined;
  if (typeof timeline !== "object" || timeline === null) {
    throw new Error(`Project file is missing required field "timeline": ${filePath}`);
  }

  // Migrate old array-based format to linked list
  if (Array.isArray(timeline["clips"])) {
    return migrateArrayTimeline(state, timeline["clips"] as OldClip[]);
  }

  if (typeof timeline["clips"] !== "object" || timeline["clips"] === null || Array.isArray(timeline["clips"])) {
    throw new Error(`Project file has invalid timeline.clips: ${filePath}`);
  }
  if (!("headId" in timeline) || !("tailId" in timeline)) {
    throw new Error(`Project file is missing timeline.headId/tailId: ${filePath}`);
  }

  return parsed as ProjectState;
}

// ── Migration ─────────────────────────────────────────────────────────────────

// Shape of a clip in the old array-based format (no prevId/nextId)
interface OldClip {
  id: string;
  sourceId: string;
  inPoint: number;
  outPoint: number;
  label: string;
}

function migrateArrayTimeline(
  state: Record<string, unknown>,
  oldClips: OldClip[]
): ProjectState {
  const clips: Record<string, Clip> = {};
  let headId: string | null = null;
  let tailId: string | null = null;

  for (let i = 0; i < oldClips.length; i++) {
    const old = oldClips[i]!;
    const prevId = i > 0 ? oldClips[i - 1]!.id : null;
    const nextId = i < oldClips.length - 1 ? oldClips[i + 1]!.id : null;
    clips[old.id] = { ...old, prevId, nextId };
    if (i === 0) headId = old.id;
    if (i === oldClips.length - 1) tailId = old.id;
  }

  const timeline: Timeline = { headId, tailId, clips };
  return { ...(state as unknown as ProjectState), timeline };
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

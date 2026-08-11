import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ProjectState, SourceFile, Clip, Timeline } from "./types.js";
import type { ProjectSession, Snapshot } from "./session.js";
import { createSession } from "./session.js";

// v4 (3E-3): clips gained an optional `userLabel` (the `/label` annotation) and
// sources gained an optional `analyses.scoutContribution`. Both are additive and
// optional, so pre-v4 projects load unchanged — every existing clip simply has
// no user label. No field transforms are needed; the bump records the schema
// change and lets older readers reject files they don't understand.
const SUPPORTED_VERSION = 4;

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

/**
 * Persist a session. The file is the state fields flattened at the top level,
 * plus undo/redo arrays as siblings. Each snapshot stores a full ProjectState.
 */
export async function saveProject(session: ProjectSession, filePath: string): Promise<void> {
  const payload = {
    ...session.state,
    version: SUPPORTED_VERSION,
    undo: session.undo,
    redo: session.redo,
  };
  const json = JSON.stringify(payload, null, 2);
  await writeFile(filePath, json, "utf-8");
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadProject(filePath: string): Promise<ProjectSession> {
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

  const file = parsed as Record<string, unknown>;

  if (typeof file["version"] !== "number") {
    throw new Error(`Project file is missing a version field: ${filePath}`);
  }

  const version = file["version"] as number;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`Unsupported project version ${version} (expected ${SUPPORTED_VERSION})`);
  }

  if (typeof file["name"] !== "string") {
    throw new Error(`Project file is missing required field "name": ${filePath}`);
  }
  if (!Array.isArray(file["sources"])) {
    throw new Error(`Project file is missing required field "sources": ${filePath}`);
  }

  const timeline = file["timeline"] as Record<string, unknown> | undefined;
  if (typeof timeline !== "object" || timeline === null) {
    throw new Error(`Project file is missing required field "timeline": ${filePath}`);
  }

  // Migrate ancient array-based timeline (predates v1's linked list)
  let state: ProjectState;
  if (Array.isArray(timeline["clips"])) {
    state = migrateArrayTimeline(file, timeline["clips"] as OldClip[]);
  } else {
    if (typeof timeline["clips"] !== "object" || timeline["clips"] === null || Array.isArray(timeline["clips"])) {
      throw new Error(`Project file has invalid timeline.clips: ${filePath}`);
    }
    if (!("headId" in timeline) || !("tailId" in timeline)) {
      throw new Error(`Project file is missing timeline.headId/tailId: ${filePath}`);
    }
    // Extract just the ProjectState fields from the flat envelope
    state = extractState(file);
  }

  // v1 had no history. v2's stacks are optional in case the file was written
  // by an older v2-compatible tool that skipped them.
  if (version === 1) {
    return createSession(state);
  }

  const undo = parseSnapshotArray(file["undo"], "undo", filePath);
  const redo = parseSnapshotArray(file["redo"], "redo", filePath);
  return { state, undo, redo };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractState(file: Record<string, unknown>): ProjectState {
  return {
    version: SUPPORTED_VERSION,
    name: file["name"] as string,
    createdAt: file["createdAt"] as string,
    updatedAt: file["updatedAt"] as string,
    sources: ensureAnalyses(file["sources"] as SourceFile[]),
    timeline: file["timeline"] as Timeline,
  };
}

// v1/v2 sources have no `analyses` field. Default to `{}` so callers can
// always treat the field as present.
function ensureAnalyses(sources: SourceFile[]): SourceFile[] {
  return sources.map((s) => (s.analyses ? s : { ...s, analyses: {} }));
}

function parseSnapshotArray(value: unknown, field: string, filePath: string): Snapshot[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Project file field "${field}" must be an array: ${filePath}`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Project file ${field}[${i}] is not an object: ${filePath}`);
    }
    const s = entry as Record<string, unknown>;
    if (typeof s["label"] !== "string") {
      throw new Error(`Project file ${field}[${i}] is missing "label": ${filePath}`);
    }
    if (typeof s["state"] !== "object" || s["state"] === null) {
      throw new Error(`Project file ${field}[${i}] is missing "state": ${filePath}`);
    }
    return { state: s["state"] as ProjectState, label: s["label"] };
  });
}

// ── Migration ─────────────────────────────────────────────────────────────────

interface OldClip {
  id: string;
  sourceId: string;
  inPoint: number;
  outPoint: number;
  label: string;
}

function migrateArrayTimeline(
  file: Record<string, unknown>,
  oldClips: OldClip[],
): ProjectState {
  const clips: Record<string, Clip> = {};
  let headId: string | null = null;
  let tailId: string | null = null;

  for (let i = 0; i < oldClips.length; i++) {
    const old = oldClips[i]!;
    const prevId = i > 0 ? oldClips[i - 1]!.id : null;
    const nextId = i < oldClips.length - 1 ? oldClips[i + 1]!.id : null;
    clips[old.id] = { ...old, prevId, nextId, splitGroupId: null };
    if (i === 0) headId = old.id;
    if (i === oldClips.length - 1) tailId = old.id;
  }

  const timeline: Timeline = { headId, tailId, clips };
  return {
    version: SUPPORTED_VERSION,
    name: file["name"] as string,
    createdAt: file["createdAt"] as string,
    updatedAt: file["updatedAt"] as string,
    sources: ensureAnalyses(file["sources"] as SourceFile[]),
    timeline,
  };
}

// ── Source validation ─────────────────────────────────────────────────────────

export async function validateSources(
  state: ProjectState,
): Promise<{ valid: SourceFile[]; missing: SourceFile[] }> {
  const results = await Promise.all(
    state.sources.map(async (source) => {
      try {
        await access(source.filePath, constants.F_OK);
        return { source, exists: true };
      } catch {
        return { source, exists: false };
      }
    }),
  );

  return {
    valid:   results.filter((r) => r.exists).map((r) => r.source),
    missing: results.filter((r) => !r.exists).map((r) => r.source),
  };
}

import type { ProjectState, ProjectSync } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";
import { audioEnvelope, groupSources, type SyncInput } from "../../media/sync.js";
import { memoized } from "../prefetch.js";

/**
 * `sync_sources` — which sources were recorded at the same moment, and how
 * far apart (media/sync.ts). The basis of a multicam story edit: a synced
 * angle shown under a line shows what was happening while that line was said.
 */

export interface SyncSourcesInput {
  /** The source whose sound carries the story; others are measured against it. */
  referenceSourceId?: string;
  force?: boolean;
}

export interface SyncSourcesOutput {
  reference: string;
  synced: Array<{ sourceId: string; fileName: string; offset: number; evidence: string; meaning: string }>;
  unsynced: Array<{ sourceId: string; fileName: string; reason: string }>;
  cached: boolean;
}

/** Envelopes are memoized per file, so re-measuring with another reference is cheap. */
const envelopeOf = (filePath: string) => memoized("envelope", filePath, () => audioEnvelope(filePath));

/** The source most likely to carry the story: the one with the most transcript lines, else the longest with audio. */
export function defaultReference(state: ProjectState): string | null {
  const audible = state.sources.filter((s) => s.audioCodec);
  if (audible.length === 0) return null;
  const byLines = [...audible].sort((a, b) =>
    (b.analyses.transcript?.segments.length ?? 0) - (a.analyses.transcript?.segments.length ?? 0) || b.duration - a.duration);
  return byLines[0]!.id;
}

/** Measure (or re-measure) sync with `referenceId` as the reference. */
export async function measureProjectSync(state: ProjectState, referenceId: string): Promise<ProjectSync> {
  const inputs: SyncInput[] = await Promise.all(state.sources.map(async (s) => ({
    id: s.id,
    fileName: s.fileName,
    envelope: s.audioCodec ? await envelopeOf(s.filePath).catch(() => null) : null,
    transcript: s.analyses.transcript?.segments,
  })));
  const ref = inputs.find((i) => i.id === referenceId)!;
  const g = groupSources(ref, inputs.filter((i) => i.id !== referenceId));
  return {
    referenceSourceId: g.referenceSourceId,
    offsets: Object.fromEntries(Object.entries(g.offsets).map(([id, o]) => [id, { offset: o.offset, evidence: o.evidence }])),
    unsynced: g.unsynced,
    measuredAt: g.measuredAt,
  };
}

/** True when the stored sync already covers every source with this reference. */
export function syncIsCurrent(state: ProjectState, referenceId: string): boolean {
  const s = state.sync;
  if (!s || s.referenceSourceId !== referenceId) return false;
  const known = new Set([...Object.keys(s.offsets), ...s.unsynced.map((u) => u.id)]);
  return state.sources.every((src) => known.has(src.id));
}

function describe(state: ProjectState, sync: ProjectSync, cached: boolean): SyncSourcesOutput {
  const name = (id: string) => state.sources.find((s) => s.id === id)?.fileName ?? id;
  const ref = name(sync.referenceSourceId);
  return {
    reference: ref,
    synced: Object.entries(sync.offsets)
      .filter(([id]) => id !== sync.referenceSourceId)
      .map(([id, o]) => ({
        sourceId: id,
        fileName: name(id),
        offset: o.offset,
        evidence: o.evidence,
        meaning: `${name(id)} at time T + ${o.offset.toFixed(2)} s shows what was happening when ${ref} was at T`,
      })),
    unsynced: sync.unsynced.map((u) => ({ sourceId: u.id, fileName: name(u.id), reason: u.reason })),
    cached,
  };
}

export async function executeSyncSources(state: ProjectState, input: SyncSourcesInput): Promise<ToolResult<SyncSourcesOutput>> {
  const referenceId = input.referenceSourceId ?? defaultReference(state);
  if (!referenceId) return { ok: false, error: "No source has audio, so nothing can be synced by sound." };
  if (!state.sources.some((s) => s.id === referenceId)) return { ok: false, error: `Source not found: ${referenceId}` };
  if (!input.force && syncIsCurrent(state, referenceId)) return { ok: true, result: describe(state, state.sync!, true) };
  let sync: ProjectSync;
  try {
    sync = await measureProjectSync(state, referenceId);
  } catch (err: unknown) {
    return { ok: false, error: `Sync measurement failed: ${(err as Error).message}` };
  }
  return { ok: true, result: describe(state, sync, false), stateUpdate: { ...state, sync, updatedAt: new Date().toISOString() } };
}

const schema: ToolSchema = {
  name: "sync_sources",
  description:
    "Measure which sources were recorded AT THE SAME TIME (several cameras or a screen recording " +
    "capturing one live event) by matching their audio, and the offset between each and the reference. " +
    "A synced source shows what was happening at any moment of the reference — use it to choose angles " +
    "in propose_program (the frames are lined up for you). Unsynced sources (no shared sound) have to be " +
    "placed by content. Cached; the reference defaults to the source with the most dialogue.",
  input_schema: {
    type: "object",
    properties: {
      referenceSourceId: { type: "string", description: "The source carrying the story's sound (the spine). Optional." },
      force: { type: "boolean", description: "Re-measure, ignoring the cache." },
    },
  },
};

export const syncSourcesTool: Tool<SyncSourcesInput, SyncSourcesOutput> = { execute: executeSyncSources, schema };

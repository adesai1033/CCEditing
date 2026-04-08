import type { ProjectState, SourceFile, Clip, Timeline, MutationResult } from "./types.js";
import { clipsInOrder, sourceFileFromMediaInfo } from "./types.js";
import type { MediaInfo } from "../media/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function touch(state: ProjectState): ProjectState {
  return { ...state, updatedAt: now() };
}

function findClip(state: ProjectState, clipId: string): Clip | undefined {
  return state.timeline.clips[clipId];
}

function findSource(state: ProjectState, sourceId: string): SourceFile | undefined {
  return state.sources.find((s) => s.id === sourceId);
}

// Return a new clips record with one entry replaced/added.
function setClip(clips: Record<string, Clip>, clip: Clip): Record<string, Clip> {
  return { ...clips, [clip.id]: clip };
}

// Remove a clip entry from the record immutably.
function deleteClip(clips: Record<string, Clip>, clipId: string): Record<string, Clip> {
  const next = { ...clips };
  delete next[clipId];
  return next;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Import a source file into the project.
 * Creates a SourceFile from MediaInfo and appends a full-duration clip to the
 * tail of the timeline in O(1).
 */
export function addSource(state: ProjectState, mediaInfo: MediaInfo): MutationResult {
  const source = sourceFileFromMediaInfo(mediaInfo);
  const clipId = crypto.randomUUID();

  const clip: Clip = {
    id: clipId,
    sourceId: source.id,
    inPoint: 0,
    outPoint: source.duration,
    label: source.fileName,
    prevId: state.timeline.tailId,
    nextId: null,
  };

  let clips = setClip(state.timeline.clips, clip);

  // Wire the old tail to point forward to the new clip
  if (state.timeline.tailId) {
    const oldTail = clips[state.timeline.tailId]!;
    clips = setClip(clips, { ...oldTail, nextId: clipId });
  }

  return {
    ok: true,
    state: touch({
      ...state,
      sources: [...state.sources, source],
      timeline: {
        headId: state.timeline.headId ?? clipId,
        tailId: clipId,
        clips,
      },
    }),
  };
}

/**
 * Adjust a clip's in-point and/or out-point.
 */
export function trimClip(
  state: ProjectState,
  clipId: string,
  opts: { inPoint?: number; outPoint?: number }
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  const source = findSource(state, clip.sourceId);
  if (!source) return { ok: false, error: `Source not found for clip: ${clipId}` };

  const inPoint  = opts.inPoint  ?? clip.inPoint;
  const outPoint = opts.outPoint ?? clip.outPoint;

  if (inPoint < 0) {
    return { ok: false, error: `In-point cannot be negative` };
  }
  if (outPoint > source.duration) {
    return { ok: false, error: `Out-point (${outPoint}s) exceeds source duration (${source.duration}s)` };
  }
  if (inPoint >= outPoint) {
    return { ok: false, error: `In-point (${inPoint}s) must be before out-point (${outPoint}s)` };
  }

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        ...state.timeline,
        clips: setClip(state.timeline.clips, { ...clip, inPoint, outPoint }),
      },
    }),
  };
}

/**
 * Remove a clip from the timeline. The source file is kept.
 * Rewires neighbours in O(1).
 */
export function removeClip(state: ProjectState, clipId: string): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  let clips = deleteClip(state.timeline.clips, clipId);

  if (clip.prevId) {
    clips = setClip(clips, { ...clips[clip.prevId]!, nextId: clip.nextId });
  }
  if (clip.nextId) {
    clips = setClip(clips, { ...clips[clip.nextId]!, prevId: clip.prevId });
  }

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        headId: state.timeline.headId === clipId ? clip.nextId : state.timeline.headId,
        tailId: state.timeline.tailId === clipId ? clip.prevId : state.timeline.tailId,
        clips,
      },
    }),
  };
}

/**
 * Move a clip to a new 0-based index in the timeline.
 * Removal is O(1); finding the insertion point is O(n).
 */
export function reorderClip(
  state: ProjectState,
  clipId: string,
  newIndex: number
): MutationResult {
  const ordered = clipsInOrder(state.timeline);
  const currentIndex = ordered.findIndex((c) => c.id === clipId);
  if (currentIndex === -1) return { ok: false, error: `Clip not found: ${clipId}` };

  if (newIndex < 0 || newIndex >= ordered.length) {
    return { ok: false, error: `Index ${newIndex + 1} out of range (1–${ordered.length})` };
  }
  if (currentIndex === newIndex) return { ok: true, state };

  const clip = state.timeline.clips[clipId]!;

  // Step 1: detach clip from its current position
  let clips = deleteClip(state.timeline.clips, clipId);
  if (clip.prevId) clips = setClip(clips, { ...clips[clip.prevId]!, nextId: clip.nextId });
  if (clip.nextId) clips = setClip(clips, { ...clips[clip.nextId]!, prevId: clip.prevId });

  let headId = state.timeline.headId === clipId ? clip.nextId : state.timeline.headId;
  let tailId = state.timeline.tailId === clipId ? clip.prevId : state.timeline.tailId;

  // Step 2: find insertion point in the post-removal order
  const orderedAfter = ordered.filter((c) => c.id !== clipId);

  if (newIndex === 0) {
    // Insert before current head
    if (headId) clips = setClip(clips, { ...clips[headId]!, prevId: clipId });
    clips = setClip(clips, { ...clip, prevId: null, nextId: headId });
    headId = clipId;
    if (tailId === null) tailId = clipId;
  } else {
    // Insert after the clip currently sitting at (newIndex - 1) in the
    // post-removal order. We read nextId from the mutated `clips` record (not
    // from the stale orderedAfter snapshot) so that we get the already-rewired
    // pointer in the case where insertAfter was a direct neighbour of the
    // removed clip and had its nextId updated in the detach step above.
    const insertAfter = orderedAfter[newIndex - 1]!;
    const insertAfterNextId = clips[insertAfter.id]!.nextId;

    clips = setClip(clips, { ...clips[insertAfter.id]!, nextId: clipId });
    if (insertAfterNextId) {
      clips = setClip(clips, { ...clips[insertAfterNextId]!, prevId: clipId });
    }
    clips = setClip(clips, { ...clip, prevId: insertAfter.id, nextId: insertAfterNextId });

    if (insertAfterNextId === null) tailId = clipId;
  }

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: { headId, tailId, clips },
    }),
  };
}

/**
 * Change a clip's display label.
 */
export function renameClip(
  state: ProjectState,
  clipId: string,
  label: string
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  if (!label.trim()) return { ok: false, error: `Label cannot be empty` };

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        ...state.timeline,
        clips: setClip(state.timeline.clips, { ...clip, label: label.trim() }),
      },
    }),
  };
}

/**
 * Remove a source file and all clips that reference it.
 */
export function removeSource(state: ProjectState, sourceId: string): MutationResult {
  const source = findSource(state, sourceId);
  if (!source) return { ok: false, error: `Source not found: ${sourceId}` };

  // Remove all clips referencing this source, in order, reusing removeClip logic
  const toRemove = clipsInOrder(state.timeline)
    .filter((c) => c.sourceId === sourceId)
    .map((c) => c.id);

  let current = state;
  for (const id of toRemove) {
    const result = removeClip(current, id);
    if (!result.ok) return result;
    current = result.state;
  }

  return {
    ok: true,
    state: touch({
      ...current,
      sources: current.sources.filter((s) => s.id !== sourceId),
    }),
  };
}

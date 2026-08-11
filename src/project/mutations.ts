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
    splitGroupId: null,
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
 * Split a clip at a source-time split point into two consecutive clips.
 * The original clip is shortened to [inPoint, splitPoint]; a new clip covering
 * [splitPoint, outPoint] is inserted immediately after it in O(1).
 * splitPoint must be strictly between the clip's inPoint and outPoint.
 */
export function splitClip(
  state: ProjectState,
  clipId: string,
  splitPoint: number
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  if (splitPoint < 0) {
    return { ok: false, error: `Split point cannot be negative` };
  }
  if (splitPoint <= clip.inPoint) {
    return { ok: false, error: `Split point (${splitPoint}s) must be after clip in-point (${clip.inPoint}s)` };
  }
  if (splitPoint >= clip.outPoint) {
    return { ok: false, error: `Split point (${splitPoint}s) must be before clip out-point (${clip.outPoint}s)` };
  }

  // All siblings from the same original clip share a splitGroupId so the
  // display layer can render them as 2a/2b/2c without shifting other indices.
  const groupId = clip.splitGroupId ?? crypto.randomUUID();
  const newId = crypto.randomUUID();

  const second: Clip = {
    id: newId,
    sourceId: clip.sourceId,
    inPoint: splitPoint,
    outPoint: clip.outPoint,
    label: clip.label,
    prevId: clip.id,
    nextId: clip.nextId,
    splitGroupId: groupId,
    // Both halves of a split inherit the user label: a "good take" that gets
    // split is still, in both halves, part of that take. The user can /unlabel
    // a half if a split was made specifically to discard part of it.
    ...(clip.userLabel !== undefined ? { userLabel: clip.userLabel } : {}),
  };

  // Shorten original clip, assign its groupId, and wire it to the new second clip
  let clips = setClip(state.timeline.clips, { ...clip, outPoint: splitPoint, nextId: newId, splitGroupId: groupId });
  clips = setClip(clips, second);

  // The clip that came after the original now follows the second clip
  if (clip.nextId) {
    clips = setClip(clips, { ...clips[clip.nextId]!, prevId: newId });
  }

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        headId: state.timeline.headId,
        tailId: state.timeline.tailId === clipId ? newId : state.timeline.tailId,
        clips,
      },
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
 * Set (or replace) a clip's user label — the `/label` annotation (3E-3).
 * This is user data, distinct from the display `label`, and is NOT routed
 * through applyPlan/Operations: labels are never agent-written and don't belong
 * in the edit-operation vocabulary. Empty/whitespace text is rejected; use
 * clearClipUserLabel to remove a label.
 */
export function setClipUserLabel(
  state: ProjectState,
  clipId: string,
  text: string,
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: `Label cannot be empty` };

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        ...state.timeline,
        clips: setClip(state.timeline.clips, { ...clip, userLabel: trimmed }),
      },
    }),
  };
}

/**
 * Clear a clip's user label (the `/unlabel` command).
 */
export function clearClipUserLabel(state: ProjectState, clipId: string): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  const next = { ...clip };
  delete next.userLabel;

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        ...state.timeline,
        clips: setClip(state.timeline.clips, next),
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

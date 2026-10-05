import type { ProjectState, SourceFile, Clip, MutationResult, Overlay, OverlayAnchor, OverlayFit, Transition, TransitionType } from "./types.js";
import { clipsInOrder, overlaysOf, layoutTimeline, sourceFileFromMediaInfo, OVERLAY_ANCHORS, OVERLAY_FITS, TRANSITION_TYPES, DEFAULT_TRANSITION_TYPE } from "./types.js";
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
  splitPoint: number,
  newClipId?: string,
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };
  if (newClipId !== undefined) {
    const id = newClipId.trim();
    if (!id) return { ok: false, error: `newClipId cannot be empty` };
    if (state.timeline.clips[id] || overlaysOf(state.timeline).some((o) => o.id === id)) {
      return { ok: false, error: `newClipId "${id}" is already in use` };
    }
  }

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
  // A caller-chosen id lets later operations in the SAME plan address the
  // new half (the agent can't know a random UUID before the plan runs).
  const newId = newClipId?.trim() || crypto.randomUUID();

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
    // Edge effects follow their edge: the out-transition and fade-out belong
    // to the second half; the fade-in stays with the first.
    ...(clip.transitionOut !== undefined ? { transitionOut: clip.transitionOut } : {}),
    ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
  };

  // Shorten original clip, assign its groupId, and wire it to the new second clip
  const firstHalf: Clip = { ...clip, outPoint: splitPoint, nextId: newId, splitGroupId: groupId };
  delete firstHalf.transitionOut;
  delete firstHalf.fadeOut;
  let clips = setClip(state.timeline.clips, firstHalf);
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
      timeline: {
        ...current.timeline,
        overlays: overlaysOf(current.timeline).filter((o) => o.sourceId !== sourceId),
      },
    }),
  };
}

// ── Transitions & fades ───────────────────────────────────────────────────────

/**
 * Set the transition from a clip into the one that follows it. The clip must
 * have a successor, and the overlap must fit inside both clips. A crossfade
 * and a fade-to-black on the same edge contradict each other, so setting one
 * rejects if the other is present (clear it first).
 */
export function setTransition(
  state: ProjectState,
  clipId: string,
  transition: { type?: TransitionType; duration: number },
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };
  const type = transition.type ?? DEFAULT_TRANSITION_TYPE;
  if (!TRANSITION_TYPES.includes(type)) {
    return { ok: false, error: `Unknown transition "${type}" (use one of ${TRANSITION_TYPES.join(", ")})` };
  }
  if (!Number.isFinite(transition.duration) || transition.duration <= 0) {
    return { ok: false, error: `Transition duration must be positive (got ${transition.duration}s)` };
  }
  if (!clip.nextId) return { ok: false, error: `Clip is the last on the timeline — a transition needs a following clip (use a fade out instead)` };
  const next = findClip(state, clip.nextId)!;
  const room = Math.min(clip.outPoint - clip.inPoint, next.outPoint - next.inPoint);
  if (transition.duration > room) {
    return { ok: false, error: `Transition (${transition.duration}s) is longer than the shorter of the two clips (${room}s)` };
  }
  if (clip.fadeOut) return { ok: false, error: `Clip already fades out — clear it first (/fade <clip> out 0)` };
  if (next.fadeIn) return { ok: false, error: `The next clip fades in — clear it first (/fade <clip> in 0)` };

  const t: Transition = { type, duration: transition.duration };
  return {
    ok: true,
    state: touch({
      ...state,
      timeline: { ...state.timeline, clips: setClip(state.timeline.clips, { ...clip, transitionOut: t }) },
    }),
  };
}

/** Back to a hard cut after the clip. */
export function removeTransition(state: ProjectState, clipId: string): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };
  const next = { ...clip };
  delete next.transitionOut;
  return {
    ok: true,
    state: touch({ ...state, timeline: { ...state.timeline, clips: setClip(state.timeline.clips, next) } }),
  };
}

/**
 * Set a fade from black (edge "in") or to black (edge "out") on a clip, with
 * a matching audio fade. Duration 0 clears it. Rejects a fade on an edge that
 * already carries a crossfade.
 */
export function setFade(
  state: ProjectState,
  clipId: string,
  edge: "in" | "out",
  duration: number,
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };
  if (!Number.isFinite(duration) || duration < 0) {
    return { ok: false, error: `Fade duration cannot be negative (got ${duration}s)` };
  }
  const clipDur = clip.outPoint - clip.inPoint;
  const other = edge === "in" ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0);
  if (duration + other > clipDur) {
    return { ok: false, error: `Fades (${duration + other}s) exceed the clip's length (${clipDur}s)` };
  }
  if (duration > 0) {
    if (edge === "out" && clip.transitionOut && clip.nextId) {
      return { ok: false, error: `Clip already transitions into the next one — remove it first (/transition <clip> none)` };
    }
    if (edge === "in" && clip.prevId && findClip(state, clip.prevId)?.transitionOut) {
      return { ok: false, error: `The previous clip transitions into this one — remove it first (/transition <clip> none)` };
    }
  }

  const next: Clip = { ...clip };
  if (edge === "in") { if (duration > 0) next.fadeIn = duration; else delete next.fadeIn; }
  else               { if (duration > 0) next.fadeOut = duration; else delete next.fadeOut; }
  return {
    ok: true,
    state: touch({ ...state, timeline: { ...state.timeline, clips: setClip(state.timeline.clips, next) } }),
  };
}

// ── Story-editing primitives ──────────────────────────────────────────────────

/**
 * Where a moment of a source currently plays on the timeline: the first
 * main-track clip of `sourceId` whose range contains `time`, mapped through
 * the layout (so trims, removed pauses and crossfades are all accounted for).
 * This is how an overlay is pinned to a LINE OF DIALOGUE rather than to a
 * timeline second that shifts whenever the dialogue is tightened.
 */
export function timelineTimeOf(
  state: ProjectState,
  sourceId: string,
  time: number,
): { ok: true; at: number } | { ok: false; error: string } {
  const source = findSource(state, sourceId);
  if (!source) return { ok: false, error: `Source not found: ${sourceId}` };
  for (const p of layoutTimeline(state.timeline).clips) {
    const c = p.clip;
    if (c.sourceId === sourceId && time >= c.inPoint - 1e-6 && time < c.outPoint + 1e-6) {
      return { ok: true, at: p.start + Math.max(0, time - c.inPoint) };
    }
  }
  return {
    ok: false,
    error: `${source.fileName} at ${time}s is not on the main track (it was cut or never placed) — anchor to a moment that plays`,
  };
}

/**
 * Put a range of any source on the main track at a 0-based index (the
 * agent's way to use a source more than once, or to bring one back after it
 * was deleted). `newClipId` names it for later operations in the same plan.
 */
export function insertClip(
  state: ProjectState,
  sourceId: string,
  inPoint: number,
  outPoint: number,
  index: number,
  newClipId?: string,
): MutationResult {
  const source = findSource(state, sourceId);
  if (!source) return { ok: false, error: `Source not found: ${sourceId}` };
  if (inPoint < 0) return { ok: false, error: `In-point cannot be negative` };
  if (outPoint > source.duration + 1e-6) return { ok: false, error: `Out-point (${outPoint}s) exceeds source duration (${source.duration}s)` };
  if (inPoint >= outPoint) return { ok: false, error: `In-point (${inPoint}s) must be before out-point (${outPoint}s)` };
  const ordered = clipsInOrder(state.timeline);
  if (!Number.isInteger(index) || index < 0 || index > ordered.length) {
    return { ok: false, error: `Index ${index} out of range (0–${ordered.length})` };
  }
  const id = newClipId?.trim() || crypto.randomUUID();
  if (state.timeline.clips[id] || overlaysOf(state.timeline).some((o) => o.id === id)) {
    return { ok: false, error: `newClipId "${id}" is already in use` };
  }

  const prev = index > 0 ? ordered[index - 1]! : null;
  const next = index < ordered.length ? ordered[index]! : null;
  const clip: Clip = {
    id, sourceId, inPoint, outPoint: Math.min(outPoint, source.duration), label: source.fileName,
    prevId: prev?.id ?? null, nextId: next?.id ?? null, splitGroupId: null,
  };
  let clips = setClip(state.timeline.clips, clip);
  if (prev) clips = setClip(clips, { ...clips[prev.id]!, nextId: id });
  if (next) clips = setClip(clips, { ...clips[next.id]!, prevId: id });
  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        ...state.timeline,
        headId: prev ? state.timeline.headId : id,
        tailId: next ? state.timeline.tailId : id,
        clips,
      },
    }),
  };
}

/**
 * Keep only the given source ranges of a clip — the tightening primitive.
 * The clip becomes one consecutive clip per range (same split group, so they
 * display as 1a, 1b, …), dropping dead air, pauses and flubbed lines between
 * them in one step. Ranges must lie inside the clip, be in order and not
 * overlap. Edge effects follow their edge: the fade-in stays on the first
 * piece; the fade-out and the transition into the next clip move to the last.
 */
export function keepRanges(
  state: ProjectState,
  clipId: string,
  ranges: Array<{ start: number; end: number }>,
): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };
  if (ranges.length === 0) return { ok: false, error: `keepRanges needs at least one range (delete the clip instead)` };
  for (const [i, r] of ranges.entries()) {
    if (!(r.end > r.start)) return { ok: false, error: `Range ${i + 1} (${r.start}–${r.end}s) is empty` };
    if (r.start < clip.inPoint - 1e-6 || r.end > clip.outPoint + 1e-6) {
      return { ok: false, error: `Range ${i + 1} (${r.start}–${r.end}s) is outside the clip (${clip.inPoint}–${clip.outPoint}s)` };
    }
    if (i > 0 && r.start < ranges[i - 1]!.end - 1e-6) {
      return { ok: false, error: `Ranges must be in order and not overlap (range ${i + 1} starts before range ${i} ends)` };
    }
  }

  const groupId = ranges.length > 1 ? (clip.splitGroupId ?? crypto.randomUUID()) : clip.splitGroupId;
  const pieces: Clip[] = ranges.map((r, i) => {
    const piece: Clip = {
      ...clip,
      id: i === 0 ? clip.id : crypto.randomUUID(),
      inPoint: Math.max(clip.inPoint, r.start),
      outPoint: Math.min(clip.outPoint, r.end),
      splitGroupId: groupId,
    };
    if (i > 0) delete piece.fadeIn;
    if (i < ranges.length - 1) { delete piece.fadeOut; delete piece.transitionOut; }
    return piece;
  });
  pieces.forEach((p, i) => {
    p.prevId = i === 0 ? clip.prevId : pieces[i - 1]!.id;
    p.nextId = i === pieces.length - 1 ? clip.nextId : pieces[i + 1]!.id;
  });

  let clips = state.timeline.clips;
  for (const p of pieces) clips = setClip(clips, p);
  const last = pieces[pieces.length - 1]!;
  if (clip.nextId) clips = setClip(clips, { ...clips[clip.nextId]!, prevId: last.id });
  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        ...state.timeline,
        tailId: state.timeline.tailId === clipId ? last.id : state.timeline.tailId,
        clips,
      },
    }),
  };
}

// ── Overlays ──────────────────────────────────────────────────────────────────

/**
 * Register a source file WITHOUT placing a clip on the main track — the
 * import path for overlay footage. Idempotent on file path: overlaying a file
 * that is already a project source (via /open or an earlier overlay) reuses
 * that source rather than duplicating it. Returns the source either way.
 */
export function importSource(
  state: ProjectState,
  mediaInfo: MediaInfo,
): { state: ProjectState; source: SourceFile } {
  const existing = state.sources.find((s) => s.filePath === mediaInfo.filePath);
  if (existing) return { state, source: existing };
  const source = sourceFileFromMediaInfo(mediaInfo);
  return { state: touch({ ...state, sources: [...state.sources, source] }), source };
}

export interface OverlayPlacement {
  at?: number;
  inPoint?: number;
  outPoint?: number;
  anchor?: OverlayAnchor;
  x?: number;
  y?: number;
  scale?: number;
  /** Full-frame cutaway mode; null on an update returns to picture-in-picture. */
  fit?: OverlayFit | null;
}

/** Defaults for a freshly added overlay: a quarter-width picture-in-picture, top-right. */
export const OVERLAY_DEFAULTS = {
  at: 0,
  anchor: "top-right" as OverlayAnchor,
  x: 0.97,
  y: 0.03,
  scale: 0.25,
} as const;

function validateOverlayGeometry(o: Pick<Overlay, "at" | "inPoint" | "outPoint" | "anchor" | "x" | "y" | "scale" | "fit">, sourceDuration: number): string | null {
  if (o.fit !== undefined && !OVERLAY_FITS.includes(o.fit)) return `Unknown fit "${o.fit}" (use ${OVERLAY_FITS.join(" or ")})`;
  if (!Number.isFinite(o.at) || o.at < 0) return `Overlay start time cannot be negative`;
  if (o.inPoint < 0) return `In-point cannot be negative`;
  if (o.outPoint > sourceDuration) return `Out-point (${o.outPoint}s) exceeds source duration (${sourceDuration}s)`;
  if (o.inPoint >= o.outPoint) return `In-point (${o.inPoint}s) must be before out-point (${o.outPoint}s)`;
  if (!OVERLAY_ANCHORS.includes(o.anchor)) return `Unknown anchor "${o.anchor}" (use one of ${OVERLAY_ANCHORS.join(", ")})`;
  if (!Number.isFinite(o.scale) || o.scale <= 0 || o.scale > 1) return `Scale must be between 0 and 1 (got ${o.scale})`;
  // Positions may run past the edges (partly off-screen is a legitimate look)
  // but not absurdly: beyond [-1, 2] the overlay is entirely invisible.
  if (!Number.isFinite(o.x) || o.x < -1 || o.x > 2) return `x must be between -1 and 2 (got ${o.x})`;
  if (!Number.isFinite(o.y) || o.y < -1 || o.y > 2) return `y must be between -1 and 2 (got ${o.y})`;
  return null;
}

/**
 * Add an overlay of `sourceId` to the overlay track (on top of any existing
 * overlays). Unspecified range defaults to the whole source; unspecified
 * geometry to OVERLAY_DEFAULTS.
 */
export function addOverlay(
  state: ProjectState,
  sourceId: string,
  placement: OverlayPlacement = {},
  label?: string,
): MutationResult {
  const source = findSource(state, sourceId);
  if (!source) return { ok: false, error: `Source not found: ${sourceId}` };

  const overlay: Overlay = {
    id: crypto.randomUUID(),
    sourceId,
    inPoint: placement.inPoint ?? 0,
    outPoint: placement.outPoint ?? source.duration,
    at: placement.at ?? OVERLAY_DEFAULTS.at,
    anchor: placement.anchor ?? OVERLAY_DEFAULTS.anchor,
    x: placement.x ?? OVERLAY_DEFAULTS.x,
    y: placement.y ?? OVERLAY_DEFAULTS.y,
    scale: placement.scale ?? OVERLAY_DEFAULTS.scale,
    label: (label ?? source.fileName).trim() || source.fileName,
    ...(placement.fit ? { fit: placement.fit } : {}),
  };
  const problem = validateOverlayGeometry(overlay, source.duration);
  if (problem) return { ok: false, error: problem };

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: { ...state.timeline, overlays: [...overlaysOf(state.timeline), overlay] },
    }),
  };
}

/**
 * Change any subset of an overlay's timing or geometry (move, resize, retime,
 * re-anchor). Fields not given are kept.
 */
export function updateOverlay(
  state: ProjectState,
  overlayId: string,
  placement: OverlayPlacement,
): MutationResult {
  const overlays = overlaysOf(state.timeline);
  const idx = overlays.findIndex((o) => o.id === overlayId);
  if (idx === -1) return { ok: false, error: `Overlay not found: ${overlayId}` };
  const current = overlays[idx]!;
  const source = findSource(state, current.sourceId);
  if (!source) return { ok: false, error: `Source not found for overlay: ${overlayId}` };

  const next: Overlay = {
    ...current,
    at: placement.at ?? current.at,
    inPoint: placement.inPoint ?? current.inPoint,
    outPoint: placement.outPoint ?? current.outPoint,
    anchor: placement.anchor ?? current.anchor,
    x: placement.x ?? current.x,
    y: placement.y ?? current.y,
    scale: placement.scale ?? current.scale,
  };
  if (placement.fit === null) delete next.fit;
  else if (placement.fit !== undefined) next.fit = placement.fit;
  const problem = validateOverlayGeometry(next, source.duration);
  if (problem) return { ok: false, error: problem };

  const updated = overlays.slice();
  updated[idx] = next;
  return {
    ok: true,
    state: touch({ ...state, timeline: { ...state.timeline, overlays: updated } }),
  };
}

/** Remove an overlay from the track. Its source stays in the project. */
export function removeOverlay(state: ProjectState, overlayId: string): MutationResult {
  const overlays = overlaysOf(state.timeline);
  if (!overlays.some((o) => o.id === overlayId)) return { ok: false, error: `Overlay not found: ${overlayId}` };
  return {
    ok: true,
    state: touch({
      ...state,
      timeline: { ...state.timeline, overlays: overlays.filter((o) => o.id !== overlayId) },
    }),
  };
}

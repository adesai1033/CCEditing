import type { ProjectState, SourceFile, Clip, MutationResult } from "./types.js";
import type { MediaInfo } from "../media/types.js";
import { sourceFileFromMediaInfo } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function touch(state: ProjectState): ProjectState {
  return { ...state, updatedAt: now() };
}

function findClip(state: ProjectState, clipId: string): Clip | undefined {
  return state.timeline.clips.find((c) => c.id === clipId);
}

function findSource(state: ProjectState, sourceId: string): SourceFile | undefined {
  return state.sources.find((s) => s.id === sourceId);
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Import a source file into the project.
 * Creates a SourceFile from MediaInfo, adds it to sources, and places a clip
 * covering the full duration at the end of the timeline.
 */
export function addSource(state: ProjectState, mediaInfo: MediaInfo): MutationResult {
  const source = sourceFileFromMediaInfo(mediaInfo);

  const clip: Clip = {
    id: crypto.randomUUID(),
    sourceId: source.id,
    inPoint: 0,
    outPoint: source.duration,
    label: source.fileName,
  };

  return {
    ok: true,
    state: touch({
      ...state,
      sources: [...state.sources, source],
      timeline: { clips: [...state.timeline.clips, clip] },
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

  const updatedClip: Clip = { ...clip, inPoint, outPoint };
  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        clips: state.timeline.clips.map((c) => (c.id === clipId ? updatedClip : c)),
      },
    }),
  };
}

/**
 * Remove a clip from the timeline. The source file is kept.
 */
export function removeClip(state: ProjectState, clipId: string): MutationResult {
  const clip = findClip(state, clipId);
  if (!clip) return { ok: false, error: `Clip not found: ${clipId}` };

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: {
        clips: state.timeline.clips.filter((c) => c.id !== clipId),
      },
    }),
  };
}

/**
 * Move a clip to a new index in the timeline.
 */
export function reorderClip(
  state: ProjectState,
  clipId: string,
  newIndex: number
): MutationResult {
  const clips = state.timeline.clips;
  const currentIndex = clips.findIndex((c) => c.id === clipId);
  if (currentIndex === -1) return { ok: false, error: `Clip not found: ${clipId}` };

  if (newIndex < 0 || newIndex >= clips.length) {
    return { ok: false, error: `Index ${newIndex} out of range (0–${clips.length - 1})` };
  }

  const reordered = [...clips];
  const [moved] = reordered.splice(currentIndex, 1);
  reordered.splice(newIndex, 0, moved!);

  return {
    ok: true,
    state: touch({
      ...state,
      timeline: { clips: reordered },
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
        clips: state.timeline.clips.map((c) =>
          c.id === clipId ? { ...c, label } : c
        ),
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

  return {
    ok: true,
    state: touch({
      ...state,
      sources: state.sources.filter((s) => s.id !== sourceId),
      timeline: {
        clips: state.timeline.clips.filter((c) => c.sourceId !== sourceId),
      },
    }),
  };
}

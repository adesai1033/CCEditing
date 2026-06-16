import type { ProjectState, MutationResult } from "./types.js";
import type { MediaInfo } from "../media/types.js";
import { addSource, trimClip, splitClip, reorderClip, removeClip } from "./mutations.js";

// A point-in-time snapshot of project state, tagged with the action that
// produced it. The label describes the *action being undone* — when we push
// the previous state to the undo stack, we tag it with what's about to happen,
// so undo can report "Undid: <label>".
export interface Snapshot {
  state: ProjectState;
  label: string;
}

// Wraps a ProjectState with undo/redo stacks. Mutations and history live here,
// not on ProjectState, so the state model stays a pure data shape.
export interface ProjectSession {
  state: ProjectState;
  undo: Snapshot[];
  redo: Snapshot[];
}

// The unified operation vocabulary. Every state change — slash command or
// agent turn — is one of these. The agent's propose_edit_plan tool emits this
// shape directly so its output flows straight into applyPlan.
export type Operation =
  | { type: "addSource"; mediaInfo: MediaInfo }
  | { type: "trim"; clipId: string; inPoint?: number; outPoint?: number }
  | { type: "split"; clipId: string; splitPoint: number }
  | { type: "move"; clipId: string; newIndex: number }
  | { type: "delete"; clipId: string };

export type ApplyResult =
  | { ok: true; session: ProjectSession }
  | { ok: false; error: string; failedAt: number };

export type UndoResult =
  | { ok: true; session: ProjectSession; label: string }
  | { ok: false; reason: "nothing-to-undo" };

export type RedoResult =
  | { ok: true; session: ProjectSession; label: string }
  | { ok: false; reason: "nothing-to-redo" };

export function createSession(state: ProjectState): ProjectSession {
  return { state, undo: [], redo: [] };
}

/**
 * Apply a plan (list of operations) atomically against the session's state.
 * One snapshot is pushed for the whole plan, labeled with `label`. If any
 * operation fails, the plan is aborted: no snapshot is pushed, no state
 * change persists, and failedAt indicates which op (0-indexed) broke.
 *
 * Empty plans are a no-op (no snapshot, no redo clear) — they don't pollute
 * history.
 *
 * This is the *only* sanctioned path that mutates session state. Slash
 * commands pass a one-element ops array; the agent passes many ops in one
 * call labeled with the user's natural-language prompt.
 */
export function applyPlan(
  session: ProjectSession,
  label: string,
  ops: Operation[],
): ApplyResult {
  if (ops.length === 0) return { ok: true, session };

  let running = session.state;
  for (let i = 0; i < ops.length; i++) {
    const result = executeOperation(running, ops[i]!);
    if (!result.ok) return { ok: false, error: result.error, failedAt: i };
    running = result.state;
  }

  return {
    ok: true,
    session: {
      state: running,
      undo: [...session.undo, { state: session.state, label }],
      redo: [],
    },
  };
}

function executeOperation(state: ProjectState, op: Operation): MutationResult {
  switch (op.type) {
    case "addSource":
      return addSource(state, op.mediaInfo);
    case "trim":
      return trimClip(state, op.clipId, { inPoint: op.inPoint, outPoint: op.outPoint });
    case "split":
      return splitClip(state, op.clipId, op.splitPoint);
    case "move":
      return reorderClip(state, op.clipId, op.newIndex);
    case "delete":
      return removeClip(state, op.clipId);
  }
}

/**
 * Pop the most recent undo snapshot back onto the state and push the current
 * state onto the redo stack (preserving the label so redo can describe what
 * it's restoring).
 */
export function undoSession(session: ProjectSession): UndoResult {
  if (session.undo.length === 0) return { ok: false, reason: "nothing-to-undo" };
  const prev = session.undo[session.undo.length - 1]!;
  return {
    ok: true,
    label: prev.label,
    session: {
      state: prev.state,
      undo: session.undo.slice(0, -1),
      redo: [...session.redo, { state: session.state, label: prev.label }],
    },
  };
}

/**
 * Inverse of undoSession: pop the most recent redo snapshot and push the
 * current state onto the undo stack.
 */
export function redoSession(session: ProjectSession): RedoResult {
  if (session.redo.length === 0) return { ok: false, reason: "nothing-to-redo" };
  const next = session.redo[session.redo.length - 1]!;
  return {
    ok: true,
    label: next.label,
    session: {
      state: next.state,
      undo: [...session.undo, { state: session.state, label: next.label }],
      redo: session.redo.slice(0, -1),
    },
  };
}

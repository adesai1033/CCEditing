import type { ProjectState, MutationResult } from "./types.js";

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

export type ApplyResult =
  | { ok: true; session: ProjectSession }
  | { ok: false; error: string };

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
 * Run a mutation against the session's current state. On success: push the
 * previous state to the undo stack (tagged with `label`), clear the redo stack,
 * and return a session with the new state. On failure: return the mutation's
 * error and leave the session untouched.
 *
 * This is the *only* sanctioned path that mutates session state — every
 * dispatch site (CLI + REPL) routes through here so history stays consistent.
 */
export function applyMutation(
  session: ProjectSession,
  label: string,
  fn: (state: ProjectState) => MutationResult,
): ApplyResult {
  const result = fn(session.state);
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    session: {
      state: result.state,
      undo: [...session.undo, { state: session.state, label }],
      redo: [],
    },
  };
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

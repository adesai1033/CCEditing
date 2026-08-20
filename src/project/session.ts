import { z } from "zod";
import type { ProjectState, MutationResult } from "./types.js";
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
// agent turn — is one of these. The agent's propose_edit_plan tool emits a
// SUBSET of this shape (everything except addSource) so its output flows
// straight into applyPlan.
//
// This zod schema is the single source of truth: the TS Operation type is
// derived from it, and the agent's tool JSON Schema is derived from a subset
// of it via zod-to-json-schema. Adding a field here updates both downstream.

// addSource carries the full MediaInfo from the probe. MediaInfo is a
// closed shape defined elsewhere; we don't restate its fields in zod, we
// just accept it as an opaque object on the operation. (The agent's
// propose_edit_plan does NOT include addSource — file imports stay in /open
// — so this branch is only used by the CLI/REPL slash dispatchers, which
// always construct it with a real MediaInfo. No schema validation needed.)
const AddSourceOp = z.object({
  type: z.literal("addSource"),
  mediaInfo: z.unknown(),
});

export const TrimOpSchema = z.object({
  type: z.literal("trim"),
  clipId: z.string(),
  inPoint: z.number().optional(),
  outPoint: z.number().optional(),
});

export const SplitOpSchema = z.object({
  type: z.literal("split"),
  clipId: z.string(),
  splitPoint: z.number(),
});

export const MoveOpSchema = z.object({
  type: z.literal("move"),
  clipId: z.string(),
  newIndex: z.number().int(),
});

export const DeleteOpSchema = z.object({
  type: z.literal("delete"),
  clipId: z.string(),
});

export const OperationSchema = z.discriminatedUnion("type", [
  AddSourceOp,
  TrimOpSchema,
  SplitOpSchema,
  MoveOpSchema,
  DeleteOpSchema,
]);

export type Operation = z.infer<typeof OperationSchema>;

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

  const result = applyOperations(session.state, ops);
  if (!result.ok) return { ok: false, error: result.error, failedAt: result.failedAt };

  return {
    ok: true,
    session: {
      state: result.state,
      undo: [...session.undo, { state: session.state, label }],
      redo: [],
    },
  };
}

export type OperationsResult =
  | { ok: true; state: ProjectState }
  | { ok: false; error: string; failedAt: number };

/**
 * Apply operations sequentially against a bare state and return the resulting
 * state — no session, no undo entry, no persistence. This is the single
 * implementation of operation semantics: applyPlan wraps it to commit, and
 * preview (3H) calls it to compute a scratch post-plan state that is rendered
 * and discarded. There must never be a second implementation — a preview that
 * diverges from the real apply is worse than no preview.
 */
export function applyOperations(state: ProjectState, ops: Operation[]): OperationsResult {
  let running = state;
  for (let i = 0; i < ops.length; i++) {
    const result = executeOperation(running, ops[i]!);
    if (!result.ok) return { ok: false, error: result.error, failedAt: i };
    running = result.state;
  }
  return { ok: true, state: running };
}

function executeOperation(state: ProjectState, op: Operation): MutationResult {
  switch (op.type) {
    case "addSource":
      // mediaInfo is typed as `unknown` on the zod schema (see note above);
      // slash dispatchers always pass a real MediaInfo, so the cast is safe.
      return addSource(state, op.mediaInfo as Parameters<typeof addSource>[1]);
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

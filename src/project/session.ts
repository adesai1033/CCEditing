import { z } from "zod";
import type { ProjectState, MutationResult, OverlayAnchor, OverlayFit, TransitionType } from "./types.js";
import { OVERLAY_ANCHORS, OVERLAY_FITS, TRANSITION_TYPES } from "./types.js";
import {
  addSource, trimClip, splitClip, reorderClip, removeClip,
  importSource, addOverlay, updateOverlay, removeOverlay,
  setTransition, removeTransition, setFade,
  timelineTimeOf, insertClip, keepRanges,
} from "./mutations.js";
import type { MediaInfo } from "../media/types.js";

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
  newClipId: z.string().optional().describe(
    "Id for the second half, so LATER operations in the same plan can reference it " +
    "(any unique string, e.g. \"elderly-part2\"). Omit if nothing else in the plan touches it.",
  ),
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

// ── Overlay track ─────────────────────────────────────────────────────────────
//
// Geometry fields are shared by add + update. All optional: an add falls back
// to OVERLAY_DEFAULTS / the whole source, an update keeps what it doesn't name.
const OverlayAnchorSchema = z.enum(OVERLAY_ANCHORS as unknown as [string, ...string[]]);

const OverlayPlacementFields = {
  at: z.number().optional().describe("Timeline time (seconds) where the overlay starts."),
  inPoint: z.number().optional().describe("Start within the overlay's source (seconds)."),
  outPoint: z.number().optional().describe("End within the overlay's source (seconds)."),
  anchor: OverlayAnchorSchema.optional().describe("Which point of the overlay is pinned at (x, y)."),
  x: z.number().optional().describe("Anchor position as a fraction of the frame width (0 = left, 1 = right)."),
  y: z.number().optional().describe("Anchor position as a fraction of the frame height (0 = top, 1 = bottom)."),
  scale: z.number().optional().describe("Overlay width as a fraction of the frame width, 0–1 (aspect kept)."),
  fit: z.enum(OVERLAY_FITS as unknown as [string, ...string[]]).nullable().optional().describe(
    "Full-frame CUTAWAY instead of picture-in-picture: \"cover\" fills the frame (crops overflow), " +
    "\"contain\" fits inside it on black. The main track's audio keeps playing underneath. " +
    "anchor/x/y/scale are ignored. null (on update) returns to picture-in-picture.",
  ),
  atSource: z.object({
    sourceId: z.string(),
    time: z.number(),
  }).optional().describe(
    "Start the overlay when this moment of a MAIN-TRACK source plays (e.g. the second a line of dialogue " +
    "begins), instead of giving `at`. Resolved when the operation applies, after earlier operations in " +
    "the plan — so it stays on the line even after the dialogue is tightened. Use one of `at` or `atSource`.",
  ),
};

// The agent's shape: overlay an EXISTING project source by id.
export const AddOverlayOpSchema = z.object({
  type: z.literal("addOverlay"),
  sourceId: z.string().describe("The source to overlay (a `sourceId` from query_timeline)."),
  ...OverlayPlacementFields,
});

// The slash-command shape: additionally accepts a freshly probed file, which
// is imported as a source (no main-track clip) in the same operation so the
// import and the overlay are one undo entry. mediaInfo is opaque here for the
// same reason as AddSourceOp's.
const AddOverlayFromFileOp = z.object({
  type: z.literal("addOverlayFromFile"),
  mediaInfo: z.unknown(),
  ...OverlayPlacementFields,
});

export const UpdateOverlayOpSchema = z.object({
  type: z.literal("updateOverlay"),
  overlayId: z.string(),
  ...OverlayPlacementFields,
});

export const RemoveOverlayOpSchema = z.object({
  type: z.literal("removeOverlay"),
  overlayId: z.string(),
});

// ── Transitions & fades ───────────────────────────────────────────────────────

// ── Story-editing primitives ──────────────────────────────────────────────────

export const InsertClipOpSchema = z.object({
  type: z.literal("insertClip"),
  sourceId: z.string().describe("Any project source (query_timeline `sources`)."),
  inPoint: z.number(),
  outPoint: z.number(),
  index: z.number().int().describe("0-based position on the main track; equal to the clip count appends."),
  newClipId: z.string().optional().describe("Name for the new clip so later operations in this plan can reference it."),
});

export const KeepRangesOpSchema = z.object({
  type: z.literal("keepRanges"),
  clipId: z.string(),
  ranges: z.array(z.object({ start: z.number(), end: z.number() })).min(1).describe(
    "Source-time ranges to KEEP, in order, inside the clip. Everything between them is removed and the " +
    "pieces play back to back. Use it to cut dead air, long pauses and repeated or flubbed lines.",
  ),
});

export const SetTransitionOpSchema = z.object({
  type: z.literal("setTransition"),
  clipId: z.string().describe("The clip the transition leads OUT of (into the next clip)."),
  duration: z.number().describe("Overlap in seconds; must fit inside both clips."),
  transitionType: z.enum(TRANSITION_TYPES as unknown as [string, ...string[]]).optional()
    .describe("Picture style (default \"fade\", the classic crossfade)."),
});

export const RemoveTransitionOpSchema = z.object({
  type: z.literal("removeTransition"),
  clipId: z.string(),
});

export const SetFadeOpSchema = z.object({
  type: z.literal("setFade"),
  clipId: z.string(),
  edge: z.enum(["in", "out"]).describe("\"in\" fades from black at the clip's start; \"out\" fades to black at its end."),
  duration: z.number().describe("Seconds; 0 removes the fade."),
});

export const OperationSchema = z.discriminatedUnion("type", [
  AddSourceOp,
  TrimOpSchema,
  SplitOpSchema,
  MoveOpSchema,
  DeleteOpSchema,
  SetTransitionOpSchema,
  RemoveTransitionOpSchema,
  SetFadeOpSchema,
  InsertClipOpSchema,
  KeepRangesOpSchema,
  AddOverlayOpSchema,
  AddOverlayFromFileOp,
  UpdateOverlayOpSchema,
  RemoveOverlayOpSchema,
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
      return splitClip(state, op.clipId, op.splitPoint, op.newClipId);
    case "move":
      return reorderClip(state, op.clipId, op.newIndex);
    case "delete":
      return removeClip(state, op.clipId);
    case "addOverlay": {
      const placement = overlayPlacement(state, op);
      return placement.ok ? addOverlay(state, op.sourceId, placement.value) : placement;
    }
    case "addOverlayFromFile": {
      const imported = importSource(state, op.mediaInfo as MediaInfo);
      const placement = overlayPlacement(imported.state, op);
      return placement.ok ? addOverlay(imported.state, imported.source.id, placement.value) : placement;
    }
    case "updateOverlay": {
      const placement = overlayPlacement(state, op);
      return placement.ok ? updateOverlay(state, op.overlayId, placement.value) : placement;
    }
    case "insertClip":
      return insertClip(state, op.sourceId, op.inPoint, op.outPoint, op.index, op.newClipId);
    case "keepRanges":
      return keepRanges(state, op.clipId, op.ranges);
    case "removeOverlay":
      return removeOverlay(state, op.overlayId);
    case "setTransition":
      return setTransition(state, op.clipId, { type: op.transitionType as TransitionType | undefined, duration: op.duration });
    case "removeTransition":
      return removeTransition(state, op.clipId);
    case "setFade":
      return setFade(state, op.clipId, op.edge, op.duration);
  }
}

type OverlayPlacementOp = z.infer<typeof UpdateOverlayOpSchema>;

// The zod enums widen `anchor`/`fit` to string; the mutation validates them.
// `atSource` is resolved against the state AS IT IS NOW — i.e. after every
// earlier operation in the plan — into a concrete timeline `at`.
function overlayPlacement(state: ProjectState, op: Omit<OverlayPlacementOp, "type" | "overlayId">):
  | { ok: true; value: Parameters<typeof addOverlay>[2] & object }
  | { ok: false; error: string } {
  let at = op.at;
  if (op.atSource) {
    if (op.at !== undefined) return { ok: false, error: "Give either `at` or `atSource`, not both" };
    const r = timelineTimeOf(state, op.atSource.sourceId, op.atSource.time);
    if (!r.ok) return r;
    at = r.at;
  }
  return {
    ok: true,
    value: {
      at, inPoint: op.inPoint, outPoint: op.outPoint,
      anchor: op.anchor as OverlayAnchor | undefined,
      x: op.x, y: op.y, scale: op.scale,
      fit: op.fit as OverlayFit | null | undefined,
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

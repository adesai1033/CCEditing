import { z } from "zod";
import {
  TrimOpSchema,
  SplitOpSchema,
  MoveOpSchema,
  DeleteOpSchema,
  AddOverlayOpSchema,
  UpdateOverlayOpSchema,
  RemoveOverlayOpSchema,
  SetTransitionOpSchema,
  RemoveTransitionOpSchema,
  SetFadeOpSchema,
  InsertClipOpSchema,
  KeepRangesOpSchema,
  applyOperations,
  type Operation,
} from "../project/session.js";
import type { ProjectState } from "../project/types.js";
import { clipsInOrder, getClipDisplayRefs, overlaysOf, getOverlayDisplayRefs } from "../project/types.js";
import { formatOverlayPosition, pct } from "../display/overlay-format.js";
import type { ToolSchema } from "./types.js";
import type { CriticConcern } from "./critic.js";

// The agent's operation vocabulary is a structural subset of session.ts's
// Operation: everything except the file-import ops (addSource,
// addOverlayFromFile). File imports stay under /open and /overlay <file>;
// the agent overlays sources the project already has, by sourceId.
// These are the SAME zod schemas used by applyPlan, so the agent's tool input
// cannot drift from what the chokepoint accepts.
export const AgentOperationSchema = z.discriminatedUnion("type", [
  TrimOpSchema,
  SplitOpSchema,
  MoveOpSchema,
  DeleteOpSchema,
  AddOverlayOpSchema,
  UpdateOverlayOpSchema,
  RemoveOverlayOpSchema,
  SetTransitionOpSchema,
  RemoveTransitionOpSchema,
  SetFadeOpSchema,
  InsertClipOpSchema,
  KeepRangesOpSchema,
]);

export type AgentOperation = z.infer<typeof AgentOperationSchema>;

export const ProposeEditPlanInputSchema = z.object({
  summary: z
    .string()
    .describe("One-sentence summary of what this plan accomplishes."),
  operations: z
    .array(AgentOperationSchema)
    .describe("Ordered list of operations applied atomically as one undo entry."),
});

export type ProposeEditPlanInput = z.infer<typeof ProposeEditPlanInputSchema>;

// Derive the Anthropic tool input_schema from the zod schema using zod 4's
// native JSON Schema export. We strip the `$schema` field and force the
// `additionalProperties: false` Anthropic expects on object schemas.
function buildInputSchema(): ToolSchema["input_schema"] {
  const raw = z.toJSONSchema(ProposeEditPlanInputSchema) as Record<string, unknown> & {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    type: "object",
    properties: (raw.properties ?? {}) as Record<string, unknown>,
    required: raw.required,
  };
}

export const proposeEditPlanSchema: ToolSchema = {
  name: "propose_edit_plan",
  description:
    "Submit an edit plan for user confirmation and execution. Call this " +
    "only when you have a concrete plan whose ranges you have verified " +
    "(via describe_segment or detect_scenes); for ambiguity, reply with " +
    "plain text instead. Each operation becomes part of one undo entry " +
    "labeled with the user's original prompt.",
  input_schema: buildInputSchema(),
};

// ── Confirmation render ───────────────────────────────────────────────────────

export interface PlanForConfirmation {
  summary: string;
  operations: Operation[];
  renderedLines: string[];
  /** 3G: critic concerns still outstanding when the revision cap (or the tool
   *  budget) was exhausted. Shown at the confirm gate so the user arbitrates
   *  with the flags visible. Absent on approved / unreviewed plans. */
  outstandingConcerns?: CriticConcern[];
}

/**
 * Translate the agent's UUID-and-seconds plan into human-readable lines
 * using display refs and MM:SS. Used by the confirmation UI and by the
 * agent loop's "Applied: ..." render.
 */
export function renderPlanForConfirmation(
  state: ProjectState,
  plan: { operations: AgentOperation[]; summary: string },
): PlanForConfirmation {
  const refs = getClipDisplayRefs(state.timeline);
  const clipMap = new Map(clipsInOrder(state.timeline).map((c) => [c.id, c]));
  const oRefs = getOverlayDisplayRefs(state.timeline);
  const overlayMap = new Map(overlaysOf(state.timeline).map((o) => [o.id, o]));
  const sourceMap = new Map(state.sources.map((s) => [s.id, s]));

  // Clips the plan itself creates (a split's named second half) don't exist
  // yet; show them by the ref they'll have once the plan is applied.
  const after = applyOperations(state, plan.operations as Operation[]);
  const afterRefs = after.ok ? getClipDisplayRefs(after.state.timeline) : new Map<string, string>();
  const afterClips = after.ok ? after.state.timeline.clips : {};

  const ref = (id: string): string =>
    refs.get(id) ?? (afterRefs.has(id) ? `new ${afterRefs.get(id)}` : id.slice(0, 8));
  const refLabel = (id: string): string => {
    const c = clipMap.get(id) ?? afterClips[id];
    return c ? `${c.label}` : "(unknown clip)";
  };
  const oRef = (id: string): string => oRefs.get(id) ?? id.slice(0, 8);
  const oLabel = (id: string): string => overlayMap.get(id)?.label ?? "(unknown overlay)";
  // Geometry words for a plan line: only what the op actually sets.
  const geometry = (op: { anchor?: string; x?: number; y?: number; scale?: number; at?: number; inPoint?: number; outPoint?: number; fit?: string | null; atSource?: { sourceId: string; time: number } }): string => {
    const bits: string[] = [];
    if (op.at !== undefined) bits.push(`at ${formatTime(op.at)}`);
    if (op.atSource) {
      const name = sourceMap.get(op.atSource.sourceId)?.fileName ?? "(unknown source)";
      bits.push(`when ${name} reaches ${formatTime(op.atSource.time)}`);
    }
    if (op.inPoint !== undefined || op.outPoint !== undefined) {
      bits.push(`source ${op.inPoint !== undefined ? formatTime(op.inPoint) : "(start)"}–${op.outPoint !== undefined ? formatTime(op.outPoint) : "(end)"}`);
    }
    if (op.fit) {
      bits.push(`full-frame cutaway (${op.fit})`);
    } else {
      if (op.fit === null) bits.push("back to picture-in-picture");
      if (op.anchor !== undefined || op.x !== undefined || op.y !== undefined) {
        bits.push(formatOverlayPosition({ anchor: (op.anchor ?? "top-left") as never, x: op.x ?? 0, y: op.y ?? 0 }));
      }
      if (op.scale !== undefined) bits.push(`${pct(op.scale)} wide`);
    }
    return bits.join(", ");
  };

  const renderedLines = plan.operations.map((op): string => {
    switch (op.type) {
      case "trim": {
        const inStr = op.inPoint !== undefined ? formatTime(op.inPoint) : "(start)";
        const outStr = op.outPoint !== undefined ? formatTime(op.outPoint) : "(end)";
        return `Trim clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → ${inStr}–${outStr}`;
      }
      case "split": {
        const named = op.newClipId !== undefined && afterRefs.has(op.newClipId)
          ? ` → second half [new ${afterRefs.get(op.newClipId)}]`
          : "";
        return `Split clip [${ref(op.clipId)}] ${refLabel(op.clipId)} at ${formatTime(op.splitPoint)}${named}`;
      }
      case "move":
        return op.atSource
          ? `Move clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → where ${sourceMap.get(op.atSource.sourceId)?.fileName ?? "(unknown source)"} reaches ${formatTime(op.atSource.time)}`
          : `Move clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → position ${(op.newIndex ?? 0) + 1}`;
      case "delete":
        return `Delete clip [${ref(op.clipId)}] ${refLabel(op.clipId)}`;
      case "addOverlay": {
        const src = sourceMap.get(op.sourceId)?.fileName ?? "(unknown source)";
        const g = geometry(op);
        return `Overlay ${src}${g ? ` → ${g}` : ""}`;
      }
      case "updateOverlay": {
        const g = geometry(op);
        return `Adjust overlay [${oRef(op.overlayId)}] ${oLabel(op.overlayId)}${g ? ` → ${g}` : ""}`;
      }
      case "removeOverlay":
        return `Remove overlay [${oRef(op.overlayId)}] ${oLabel(op.overlayId)}`;
      case "insertClip": {
        const src = sourceMap.get(op.sourceId)?.fileName ?? "(unknown source)";
        const where = op.atSource
          ? `where ${sourceMap.get(op.atSource.sourceId)?.fileName ?? "(unknown source)"} reaches ${formatTime(op.atSource.time)}`
          : `position ${(op.index ?? 0) + 1}`;
        return `Insert ${src} ${formatTime(op.inPoint)}–${formatTime(op.outPoint)} → ${where}`;
      }
      case "keepRanges": {
        // Only a clip that exists before the plan has a known "before" length;
        // one created earlier in the same plan doesn't (its after-state is a piece).
        const clip = clipMap.get(op.clipId);
        const before = clip ? clip.outPoint - clip.inPoint : 0;
        const kept = op.ranges.reduce((t, r) => t + (r.end - r.start), 0);
        const removed = before > 0 ? `, ${Math.round(before - kept)}s cut` : "";
        return `Tighten clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → keep ${op.ranges.length} range${op.ranges.length === 1 ? "" : "s"} (${Math.round(kept)}s${removed})`;
      }
      case "setTransition": {
        const next = clipMap.get(op.clipId)?.nextId;
        const into = next ? ` into [${ref(next)}]` : "";
        return `Transition clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → ${op.transitionType ?? "fade"} ${Number(op.duration.toFixed(2))}s${into}`;
      }
      case "removeTransition":
        return `Cut clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → hard cut into the next clip`;
      case "setFade":
        return op.duration > 0
          ? `Fade clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → ${op.edge} ${Number(op.duration.toFixed(2))}s`
          : `Unfade clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → remove fade ${op.edge}`;
    }
  });

  return {
    summary: plan.summary,
    operations: plan.operations as Operation[],
    renderedLines,
  };
}

function formatTime(seconds: number): string {
  // Round to tenths FIRST so 61.98 carries to 1:02.0 rather than "1:01.10".
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const total = Math.floor(tenths / 10);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const frac = tenths % 10;
  return `${m}:${String(s).padStart(2, "0")}${frac > 0 ? `.${frac}` : ""}`;
}

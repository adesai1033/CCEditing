import { z } from "zod";
import {
  TrimOpSchema,
  SplitOpSchema,
  MoveOpSchema,
  DeleteOpSchema,
  type Operation,
} from "../project/session.js";
import type { ProjectState } from "../project/types.js";
import { clipsInOrder, getClipDisplayRefs } from "../project/types.js";
import type { ToolSchema } from "./types.js";

// The agent's operation vocabulary is a structural subset of session.ts's
// Operation: everything except addSource. File imports stay under /open.
// This is the SAME zod schemas used by applyPlan, so the agent's tool input
// cannot drift from what the chokepoint accepts.
export const AgentOperationSchema = z.discriminatedUnion("type", [
  TrimOpSchema,
  SplitOpSchema,
  MoveOpSchema,
  DeleteOpSchema,
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

  const ref = (id: string): string => refs.get(id) ?? id.slice(0, 8);
  const refLabel = (id: string): string => {
    const c = clipMap.get(id);
    return c ? `${c.label}` : "(unknown clip)";
  };

  const renderedLines = plan.operations.map((op): string => {
    switch (op.type) {
      case "trim": {
        const inStr = op.inPoint !== undefined ? formatTime(op.inPoint) : "(start)";
        const outStr = op.outPoint !== undefined ? formatTime(op.outPoint) : "(end)";
        return `Trim clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → ${inStr}–${outStr}`;
      }
      case "split":
        return `Split clip [${ref(op.clipId)}] ${refLabel(op.clipId)} at ${formatTime(op.splitPoint)}`;
      case "move":
        return `Move clip [${ref(op.clipId)}] ${refLabel(op.clipId)} → position ${op.newIndex + 1}`;
      case "delete":
        return `Delete clip [${ref(op.clipId)}] ${refLabel(op.clipId)}`;
    }
  });

  return {
    summary: plan.summary,
    operations: plan.operations as Operation[],
    renderedLines,
  };
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const frac = seconds - total;
  const fracStr = frac > 0.001 ? `.${Math.round(frac * 10)}` : "";
  return `${m}:${String(s).padStart(2, "0")}${fracStr}`;
}

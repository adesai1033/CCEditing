import { z } from "zod";
import { OVERLAY_ANCHORS } from "../project/types.js";
import type { ToolSchema } from "./types.js";

/**
 * `propose_program` — the director's terminal tool for STORY edits: the
 * edit described as an editor would (spine, what to keep, which angle the
 * viewer sees when), compiled to operations by src/edit/program.ts.
 * propose_edit_plan stays for small, direct edits.
 */

const range = z.object({ start: z.number(), end: z.number() });

export const ProgramShotSchema = z.object({
  from: z.number().describe("Spine seconds where this shot starts (inside a kept range)."),
  to: z.number().describe("Spine seconds where it ends. A shot may span several kept ranges; it stays in sync across the cuts."),
  angle: z.string().describe("sourceId of what the viewer sees."),
  sourceIn: z.number().optional().describe(
    "ONLY for a source that is not synced with the spine: where in that source the shot starts. Synced angles never take this — their frames are lined up for you.",
  ),
  framing: z.enum(["full", "fill", "pip"]).optional().describe(
    "full (default): the whole picture in the frame, nothing cropped. fill: fill the frame, cropping the edges. pip: a window over the picture beneath.",
  ),
  pip: z.object({
    anchor: z.enum(OVERLAY_ANCHORS as unknown as [string, ...string[]]).optional(),
    scale: z.number().optional().describe("Window width as a fraction of the frame width."),
  }).optional(),
});

export const ProgramSchema = z.object({
  spine: z.string().describe("sourceId whose SOUND carries the story; it plays continuously."),
  keep: z.array(range).min(1).describe("Stretches of the spine to keep, in order (spine seconds)."),
  shots: z.array(ProgramShotSchema).describe(
    "What the viewer sees over spans of spine time, in stacking order (later shots on top). Time not covered shows the spine.",
  ),
  fade: z.object({ in: z.number().optional(), out: z.number().optional() }).optional()
    .describe("Optional fade from/to black at the very start/end (seconds)."),
});

export const ProposeProgramInputSchema = z.object({
  summary: z.string().describe("One sentence: the story this cut tells."),
  program: ProgramSchema,
});

export type ProposeProgramInput = z.infer<typeof ProposeProgramInputSchema>;

function buildInputSchema(): ToolSchema["input_schema"] {
  const raw = z.toJSONSchema(ProposeProgramInputSchema) as Record<string, unknown> & {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return { type: "object", properties: (raw.properties ?? {}) as Record<string, unknown>, required: raw.required };
}

export const proposeProgramSchema: ToolSchema = {
  name: "propose_program",
  description:
    "Submit a STORY edit as a program: the spine (whose sound carries the story), the stretches of it to " +
    "keep, and which angle the viewer sees over which span of it. Synced angles (sync_sources) are lined up " +
    "with the spine automatically — choose them by what the viewer should see while those lines play. The " +
    "program replaces the whole timeline. A reviewer watches a draft of the cut and may send notes back to " +
    "revise; then the user confirms. Use propose_edit_plan instead for small, direct edits.",
  input_schema: buildInputSchema(),
};

import type { ProjectState } from "../../project/types.js";
import { clipsInOrder, getClipDisplayRefs } from "../../project/types.js";
import type { Tool, ToolSchema, ToolResult } from "../types.js";

export interface QueryTimelineInput {} // intentionally empty
export interface QueryTimelineOutput {
  totalDuration: number;
  clips: Array<{
    id: string;            // UUID — operations use this
    ref: string;           // display ref ("1", "2a") — for user-facing output
    sourceId: string;
    sourceFileName: string;
    inPoint: number;
    outPoint: number;
    duration: number;
    label: string;
    sourceDescription: string | null;  // populated if describe_clip has run
  }>;
}

async function execute(state: ProjectState, _input: QueryTimelineInput): Promise<ToolResult<QueryTimelineOutput>> {
  const ordered = clipsInOrder(state.timeline);
  const refs = getClipDisplayRefs(state.timeline);
  const sourceMap = new Map(state.sources.map((s) => [s.id, s]));

  const clips = ordered.map((c) => {
    const source = sourceMap.get(c.sourceId);
    return {
      id: c.id,
      ref: refs.get(c.id) ?? "?",
      sourceId: c.sourceId,
      sourceFileName: source?.fileName ?? "(missing)",
      inPoint: c.inPoint,
      outPoint: c.outPoint,
      duration: c.outPoint - c.inPoint,
      label: c.label,
      sourceDescription: source?.analyses.description?.text ?? null,
    };
  });

  const totalDuration = clips.reduce((s, c) => s + c.duration, 0);

  return { ok: true, result: { totalDuration, clips } };
}

const schema: ToolSchema = {
  name: "query_timeline",
  description:
    "Returns the current timeline as an ordered list of clips with display refs " +
    "(e.g. '1', '2a'), source filenames, in/out points, durations, and cached " +
    "Gemini descriptions if available. Call this first when planning edits so " +
    "you know what clips exist and what content they hold.",
  input_schema: { type: "object", properties: {} },
};

export const queryTimeline: Tool<QueryTimelineInput, QueryTimelineOutput> = { execute, schema };

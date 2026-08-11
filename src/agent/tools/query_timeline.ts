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
    sourceDuration: number;       // duration of the source file (clip is a window into this)
    inPoint: number;
    outPoint: number;
    duration: number;
    label: string;
    userLabel: string | null;           // user's /label annotation, if any
    sourceDescription: string | null;  // populated if describe_clip has run
    // Media constraints — lets the agent reject impossible requests (e.g.
    // "remove the silent part" on a source with audioCodec === null) and
    // flag mismatches when combining clips of different resolution/fps.
    width: number;
    height: number;
    fps: number;
    videoCodec: string;
    audioPresent: boolean;
    audioCodec: string | null;
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
      sourceDuration: source?.duration ?? 0,
      inPoint: c.inPoint,
      outPoint: c.outPoint,
      duration: c.outPoint - c.inPoint,
      label: c.label,
      userLabel: c.userLabel ?? null,
      sourceDescription: source?.analyses.description?.text ?? null,
      width: source?.width ?? 0,
      height: source?.height ?? 0,
      fps: source?.fps ?? 0,
      videoCodec: source?.videoCodec ?? "",
      audioPresent: source?.audioCodec !== null && source?.audioCodec !== undefined,
      audioCodec: source?.audioCodec ?? null,
    };
  });

  const totalDuration = clips.reduce((s, c) => s + c.duration, 0);

  return { ok: true, result: { totalDuration, clips } };
}

const schema: ToolSchema = {
  name: "query_timeline",
  description:
    "Returns the current timeline as an ordered list of clips with display refs " +
    "(e.g. '1', '2a'), source filenames, in/out points, durations, any user " +
    "`/label` annotations, cached Gemini descriptions if available, plus media " +
    "constraints per source (resolution, " +
    "fps, codecs, audio presence). Call this first when planning edits so you " +
    "know what clips exist, what content they hold, and what's technically possible.",
  input_schema: { type: "object", properties: {} },
};

export const queryTimeline: Tool<QueryTimelineInput, QueryTimelineOutput> = { execute, schema };

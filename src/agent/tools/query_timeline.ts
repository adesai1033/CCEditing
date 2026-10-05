import type { ProjectState } from "../../project/types.js";
import { getClipDisplayRefs, overlaysOf, getOverlayDisplayRefs, layoutTimeline } from "../../project/types.js";
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
    timelineStart: number;        // where the clip begins in timeline time (crossfades overlap)
    // Edge effects (effective values). transitionOut leads into the NEXT clip.
    transitionOut: { type: string; duration: number } | null;
    fadeIn: number;               // seconds, 0 = none
    fadeOut: number;
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
  // Every project source (a clip's or an overlay's) — addOverlay takes one of these ids.
  sources: Array<{ id: string; fileName: string; duration: number; width: number; height: number }>;
  // The overlay track (picture-in-picture), bottom → top. Times: `at` is
  // timeline time; inPoint/outPoint are within the overlay's source.
  overlays: Array<{
    id: string;            // UUID — updateOverlay/removeOverlay use this
    ref: string;           // "o1", "o2" — user-facing
    sourceId: string;
    sourceFileName: string;
    at: number;
    inPoint: number;
    outPoint: number;
    duration: number;
    anchor: string;
    x: number;
    y: number;
    scale: number;
    fit: string | null;    // "cover"/"contain" = full-frame cutaway; null = picture-in-picture
    label: string;
  }>;
}

async function execute(state: ProjectState, _input: QueryTimelineInput): Promise<ToolResult<QueryTimelineOutput>> {
  const layout = layoutTimeline(state.timeline);
  const refs = getClipDisplayRefs(state.timeline);
  const sourceMap = new Map(state.sources.map((s) => [s.id, s]));

  const clips = layout.clips.map((p) => {
    const c = p.clip;
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
      timelineStart: p.start,
      transitionOut: p.transitionOut,
      fadeIn: p.fadeIn,
      fadeOut: p.fadeOut,
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

  const totalDuration = layout.duration;

  const sources = state.sources.map((s) => ({
    id: s.id, fileName: s.fileName, duration: s.duration, width: s.width, height: s.height,
  }));
  const oRefs = getOverlayDisplayRefs(state.timeline);
  const overlays = overlaysOf(state.timeline).map((o) => ({
    id: o.id,
    ref: oRefs.get(o.id) ?? "?",
    sourceId: o.sourceId,
    sourceFileName: sourceMap.get(o.sourceId)?.fileName ?? "(missing)",
    at: o.at,
    inPoint: o.inPoint,
    outPoint: o.outPoint,
    duration: o.outPoint - o.inPoint,
    anchor: o.anchor,
    x: o.x,
    y: o.y,
    scale: o.scale,
    fit: o.fit ?? null,
    label: o.label,
  }));

  return { ok: true, result: { totalDuration, clips, sources, overlays } };
}

const schema: ToolSchema = {
  name: "query_timeline",
  description:
    "Returns the current timeline as an ordered list of clips with display refs " +
    "(e.g. '1', '2a'), source filenames, in/out points, durations, any user " +
    "`/label` annotations, cached Gemini descriptions if available, plus media " +
    "constraints per source (resolution, " +
    "fps, codecs, audio presence), each clip's timeline start and edge effects " +
    "(transition into the next clip, fades), the project's sources (for addOverlay), and " +
    "the overlay track. Call this first when planning edits so you " +
    "know what clips exist, what content they hold, and what's technically possible.",
  input_schema: { type: "object", properties: {} },
};

export const queryTimeline: Tool<QueryTimelineInput, QueryTimelineOutput> = { execute, schema };

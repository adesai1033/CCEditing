import type { ProjectState } from "../project/types.js";
import type { ToolResult, ToolSchema } from "./types.js";

import { queryTimeline } from "./tools/query_timeline.js";
import { describeClip } from "./tools/describe_clip.js";
import { describeSegment } from "./tools/describe_segment.js";
import { findVisualMoment } from "./tools/find_visual_moment.js";
import { detectScenes } from "./tools/detect_scenes.js";
import { transcribeAudio } from "./tools/transcribe_audio.js";
import { detectSilence } from "./tools/detect_silence.js";

// NOTE: this module is on the SCOUT path and must stay write-free — it imports
// no write function and no propose_edit_plan. Terminal schemas (propose) are
// injected by the director's registry.ts via `registerTerminalSchema`, so a
// scout building on `buildPerceptionRegistry` can never see them.

/**
 * Wrapped execute signature — every tool gets `(state, input)` and returns
 * a ToolResult. propose_edit_plan is NOT dispatched here; it's handled
 * specially by the loop because it requires confirmation.
 */
export type ToolExecute = (state: ProjectState, input: unknown) => Promise<ToolResult<unknown>>;

export interface ToolEntry {
  schema: ToolSchema;
  execute: ToolExecute;
}

/**
 * The tool registry, split into two dispatch buckets:
 *
 *  - perception tools — read-only capability tools. This is the SCOUT-SAFE set
 *    (3E-3): a scout gets exactly these, so it can perceive but never plan,
 *    write, or spawn further scouts. `perceptionSchemas()` returns them.
 *  - director-only tools — dispatchable tools reserved for the single director
 *    (currently just `survey_sources`, which fans out scouts and must never be
 *    reachable from inside a scout). Registered via `registerDirectorTool`.
 *
 * `get()` resolves either bucket for dispatch; callers that must stay read-only
 * (the scout) restrict themselves to `perceptionSchemas()` names rather than
 * relying on `get()` to withhold anything.
 */
export class ToolRegistry {
  private readonly perception = new Map<string, ToolEntry>();
  private readonly director = new Map<string, ToolEntry>();
  // Schema-only terminals (propose_edit_plan) the loop dispatches directly.
  // Injected by registry.ts so this scout-safe module stays write-free.
  private readonly terminals: ToolSchema[] = [];

  /** Register a read-only perception tool (scout-safe). */
  register<I, O>(tool: { schema: ToolSchema; execute: (state: ProjectState, input: I) => Promise<ToolResult<O>> }): void {
    this.perception.set(tool.schema.name, { schema: tool.schema, execute: tool.execute as ToolExecute });
  }

  /** Register a director-only dispatchable tool (e.g. survey_sources). */
  registerDirectorTool<I, O>(tool: { schema: ToolSchema; execute: (state: ProjectState, input: I) => Promise<ToolResult<O>> }): void {
    this.director.set(tool.schema.name, { schema: tool.schema, execute: tool.execute as ToolExecute });
  }

  /** Register a schema-only terminal (dispatched by the loop, not here). */
  registerTerminalSchema(schema: ToolSchema): void {
    this.terminals.push(schema);
  }

  get(name: string): ToolEntry | undefined {
    return this.perception.get(name) ?? this.director.get(name);
  }

  has(name: string): boolean {
    return this.perception.has(name) || this.director.has(name);
  }

  /** Schemas for the read-only perception tools — the scout's entire tool set. */
  perceptionSchemas(): ToolSchema[] {
    return Array.from(this.perception.values()).map((e) => e.schema);
  }

  /** Schemas for director-only dispatchable tools (survey_sources). */
  directorToolSchemas(): ToolSchema[] {
    return Array.from(this.director.values()).map((e) => e.schema);
  }

  /**
   * Everything the director sends to the model: perception tools, director-only
   * tools, and any registered terminal schemas (propose_edit_plan) — the latter
   * schema-only, dispatched by the loop rather than this registry.
   */
  allSchemas(): ToolSchema[] {
    return [...this.perceptionSchemas(), ...this.directorToolSchemas(), ...this.terminals];
  }
}

/**
 * The read-only perception registry: the seven capability tools and nothing
 * else. This is what a scout runs against — no survey_sources (can't recurse),
 * no propose_edit_plan (can't write). The director builds on top of this via
 * buildDefaultRegistry (registry.ts).
 */
export function buildPerceptionRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(queryTimeline);
  r.register(describeClip);
  r.register(describeSegment);
  r.register(findVisualMoment);
  r.register(detectScenes);
  r.register(transcribeAudio);
  r.register(detectSilence);
  return r;
}

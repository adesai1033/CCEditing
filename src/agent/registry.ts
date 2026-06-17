import type { ProjectState } from "../project/types.js";
import type { ToolResult, ToolSchema } from "./types.js";

import { queryTimeline } from "./tools/query_timeline.js";
import { describeClip } from "./tools/describe_clip.js";
import { describeSegment } from "./tools/describe_segment.js";
import { findVisualMoment } from "./tools/find_visual_moment.js";
import { detectScenes } from "./tools/detect_scenes.js";
import { proposeEditPlanSchema } from "./propose_edit_plan.js";

/**
 * Wrapped execute signature — every tool gets `(state, input)` and returns
 * a ToolResult. propose_edit_plan is NOT in this registry; it's handled
 * specially by the loop because it requires confirmation.
 */
export type ToolExecute = (state: ProjectState, input: unknown) => Promise<ToolResult<unknown>>;

export interface ToolEntry {
  schema: ToolSchema;
  execute: ToolExecute;
}

/**
 * Single source of truth for which tools the agent has and how to dispatch
 * them. The loop reads `entries` for the API call's `tools` array and looks
 * up `dispatch` for each tool_use block. A future ToolNode in LangGraph or
 * a multi-agent split reads from the same registry.
 */
class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();

  register<I, O>(tool: { schema: ToolSchema; execute: (state: ProjectState, input: I) => Promise<ToolResult<O>> }): void {
    this.tools.set(tool.schema.name, {
      schema: tool.schema,
      execute: tool.execute as ToolExecute,
    });
  }

  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Schemas for tools that the agent dispatches inline (i.e. NOT propose_edit_plan). */
  perceptionSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((e) => e.schema);
  }

  /** Schemas to send to the Anthropic API (perception tools + propose_edit_plan). */
  allSchemas(): ToolSchema[] {
    return [...this.perceptionSchemas(), proposeEditPlanSchema];
  }
}

export function buildDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(queryTimeline);
  r.register(describeClip);
  r.register(describeSegment);
  r.register(findVisualMoment);
  r.register(detectScenes);
  return r;
}

export type { ToolRegistry };

import type { ProjectState } from "../project/types.js";

/**
 * The result of executing a capability tool. On success, `result` is the
 * tool's payload. `stateUpdate` is set when the tool populated the analysis
 * cache (or otherwise mutated source metadata) and the caller should persist
 * it. Cache writes do NOT go through applyPlan — they aren't undoable.
 */
export type ToolResult<T> =
  | { ok: true; result: T; stateUpdate?: ProjectState }
  | { ok: false; error: string };

/**
 * Tool schema shape compatible with Anthropic's tool-use API. Slice 3E-1
 * will register these directly with the SDK.
 *
 * `input_schema` is a JSON Schema object; we keep it typed as `unknown` here
 * to avoid taking a hard dependency on the Anthropic SDK from this module.
 */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Optional per-call context the loop passes to a tool's `execute` (3E-4). Lets
 * a long-running tool surface progress without changing what it returns. Today
 * only `survey_sources` uses it, to report parallel scout lifecycle; other tools
 * ignore the argument. Kept minimal — not a general side-channel.
 */
export interface ToolContext {
  onScoutProgress?: (event: { sourceId: string; status: "started" | "completed" | "failed" }) => void;
}

/**
 * Every tool module exports both an `execute` runtime function and a
 * `schema` describing its inputs. The agent (3E-1) registers all schemas
 * with Claude and dispatches tool calls to the matching execute function.
 * `ctx` is optional and ignored by tools that don't report progress.
 */
export interface Tool<I, O> {
  execute(state: ProjectState, input: I, ctx?: ToolContext): Promise<ToolResult<O>>;
  schema: ToolSchema;
}

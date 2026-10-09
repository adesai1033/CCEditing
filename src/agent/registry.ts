import { ToolRegistry, buildPerceptionRegistry } from "./perception-registry.js";
import { surveySources } from "./tools/survey_sources.js";
import { proposeEditPlanSchema } from "./propose_edit_plan.js";
import { proposeProgramSchema } from "./propose_program.js";

export type { ToolExecute, ToolEntry } from "./perception-registry.js";
export { ToolRegistry };

/**
 * The director's registry: the read-only perception tools (scout-safe) plus the
 * director-only `survey_sources` tool, which fans out scouts internally (3E-3).
 * `survey_sources` is registered as director-only so it is present in the
 * director's tool list but never in a scout's — scouts cannot survey.
 *
 * propose_edit_plan is added by `allSchemas()` (schema-only; the loop dispatches
 * it directly because it needs confirmation).
 */
export function buildDefaultRegistry(): ToolRegistry {
  const r = buildPerceptionRegistry();
  r.registerDirectorTool(surveySources);
  r.registerTerminalSchema(proposeEditPlanSchema);
  r.registerTerminalSchema(proposeProgramSchema);
  return r;
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard for slice 3E-1 design constraint 5: `src/agent/` must
 * NOT import from `src/repl/`. The REPL talks to the agent only through
 * runAgent's interface. Enforcing this here means a future multi-agent
 * refactor doesn't have to disentangle UI plumbing from agent logic.
 *
 * If you're adding a legitimate cross-cutting dependency, add it as a
 * shared module (e.g. `src/agent/types.ts` already exposes ToolResult /
 * ToolSchema) rather than reaching into `src/repl/`.
 */

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const AGENT_DIR = join(REPO_ROOT, "src", "agent");
const SRC_DIR = join(REPO_ROOT, "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...walkTs(p));
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

describe("architecture guard", () => {
  test("src/agent/ does not import from src/repl/", () => {
    const files = walkTs(AGENT_DIR);
    const offenders: string[] = [];
    const replImportRe = /from\s+["']([^"']*\/repl\/[^"']*|\.\.\/repl[^"']*)["']/;
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const line of text.split("\n")) {
        if (replImportRe.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `src/agent/ must not import from src/repl/`);
  });

  // 3E-3 write invariant, extended by 3G: the scout path AND the critic path
  // are read-only. Nothing a scout or the critic can reach may import or call
  // the write chokepoint. Enforced structurally here so a future edit can't
  // quietly hand either the ability to mutate the timeline — the critic judges,
  // the director alone writes.
  test("the scout and critic paths import no write functions (applyPlan / propose_edit_plan)", () => {
    const scoutPath = [
      join(AGENT_DIR, "scout.ts"),
      join(AGENT_DIR, "content-map.ts"),
      join(AGENT_DIR, "perception-registry.ts"),
      join(AGENT_DIR, "indexing.ts"),
      join(AGENT_DIR, "tools", "survey_sources.ts"),
      join(AGENT_DIR, "critic.ts"),
      join(AGENT_DIR, "critic-prompt.ts"),
      // 3H: preview joins the read-only club. It computes scratch states via
      // applyOperations (the pure half) and must never reach the committing
      // applyPlan or the plan tool.
      join(SRC_DIR, "engine", "preview.ts"),
      join(SRC_DIR, "repl", "commands", "preview.ts"),
    ];
    const offenders: string[] = [];
    // Match imports of applyPlan, propose_edit_plan module, or the session write API.
    const writeImportRe = /import[^;]*\b(applyPlan|proposeEditPlanSchema|renderPlanForConfirmation)\b|from\s+["'][^"']*propose_edit_plan[^"']*["']/;
    for (const file of scoutPath) {
      const text = readFileSync(file, "utf-8");
      for (const line of text.split("\n")) {
        if (/^\s*(import|export)\b/.test(line) && writeImportRe.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `scout path must not import write functions`);
  });

  // 3I presentation guard (decision 2): every color, dim treatment, and status
  // glyph in the REPL and display layers comes from src/ui/theme.ts. A raw
  // literal anywhere else re-scatters the styling this slice unified.
  test("no color or status-glyph literals outside the theme module", () => {
    const files = [
      ...walkTs(join(SRC_DIR, "repl")),
      ...walkTs(join(SRC_DIR, "display")),
    ];
    const forbidden = /\bchalk\b|\bdimColor\b|\bcolor=|\bborderColor=|[✓✗⚠✻⟳♦◀▶]/;
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (forbidden.test(lines[i]!)) {
          offenders.push(`${file}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "style literals must live in src/ui/theme.ts only");
  });
});

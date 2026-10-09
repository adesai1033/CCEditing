import type { ChatResponse } from "../agent/providers/types.js";
import { paint } from "../ui/theme.js";

/**
 * `/cost` (3K): a session-scoped readout over the neutral usage shape the
 * seam already normalizes (3E-2.4/3E-5), broken down by role so the open
 * question from 3G/3E-3 — are the critic and the scout fan-out earning their
 * cost? — has a number. Tokens only, deliberately: dollar estimates drift
 * with pricing and would present false authority. Persistence is 3E-8;
 * infrastructure-grade telemetry is 3E-9.
 */

export type CostRole = "director" | "scout" | "critic";

export interface UsageTotals {
  calls: number;
  /** Summed wall time of this role's calls, ms. */
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type CostTotals = Record<CostRole, UsageTotals>;

const ROLES: CostRole[] = ["director", "scout", "critic"];

function emptyUsage(): UsageTotals {
  return { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function emptyTotals(): CostTotals {
  return { director: emptyUsage(), scout: emptyUsage(), critic: emptyUsage() };
}

/** Pure accumulation of one response's usage into the totals. */
export function addUsage(totals: CostTotals, role: CostRole, usage: ChatResponse["usage"], durationMs = 0): CostTotals {
  const prev = totals[role];
  return {
    ...totals,
    [role]: {
      calls: prev.calls + 1,
      durationMs: prev.durationMs + durationMs,
      inputTokens: prev.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: prev.outputTokens + (usage.outputTokens ?? 0),
      reasoningTokens: prev.reasoningTokens + (usage.reasoningTokens ?? 0),
      cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheCreationTokens: prev.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
    },
  };
}

// ── Session store ─────────────────────────────────────────────────────────────
// Display state, session-scoped by design: survives /clear (which resets agent
// memory, not what the session cost) and dies with the process.

let sessionTotals: CostTotals = emptyTotals();

/** One completed model call, for the per-call breakdown in /cost. */
export interface CallRecord {
  role: CostRole;
  model: string;
  durationMs: number;
  outputTokens: number;
  reasoningTokens: number;
  inputTokens: number;
}

/** Recent calls, newest last; bounded so a long session can't grow it forever. */
export const MAX_CALL_RECORDS = 50;
let callLog: CallRecord[] = [];

export function recordUsage(role: CostRole, usage: ChatResponse["usage"], meta?: { durationMs: number; model: string }): void {
  sessionTotals = addUsage(sessionTotals, role, usage, meta?.durationMs ?? 0);
  if (meta) {
    callLog = [...callLog, {
      role, model: meta.model, durationMs: meta.durationMs,
      outputTokens: usage.outputTokens ?? 0, reasoningTokens: usage.reasoningTokens ?? 0, inputTokens: usage.inputTokens ?? 0,
    }].slice(-MAX_CALL_RECORDS);
  }
}

export function getCallLog(): CallRecord[] {
  return callLog;
}

export function getSessionTotals(): CostTotals {
  return sessionTotals;
}

/** Test hook — the store is process-global. */
export function resetSessionTotals(): void {
  sessionTotals = emptyTotals();
  callLog = [];
}

// ── Report ────────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function renderCostReport(totals: CostTotals, calls: CallRecord[] = []): string {
  const header = ["role", "calls", "time", "input", "output", "reasoning", "cache read", "cache write"];
  const rows = ROLES.map((role) => {
    const u = totals[role];
    return [role, fmt(u.calls), secs(u.durationMs), fmt(u.inputTokens), fmt(u.outputTokens), fmt(u.reasoningTokens), fmt(u.cacheReadTokens), fmt(u.cacheCreationTokens)];
  });
  const sum = ROLES.reduce((acc, r) => {
    const u = totals[r];
    acc.calls += u.calls; acc.durationMs += u.durationMs; acc.inputTokens += u.inputTokens; acc.outputTokens += u.outputTokens;
    acc.reasoningTokens += u.reasoningTokens; acc.cacheReadTokens += u.cacheReadTokens; acc.cacheCreationTokens += u.cacheCreationTokens;
    return acc;
  }, emptyUsage());
  rows.push(["total", fmt(sum.calls), secs(sum.durationMs), fmt(sum.inputTokens), fmt(sum.outputTokens), fmt(sum.reasoningTokens), fmt(sum.cacheReadTokens), fmt(sum.cacheCreationTokens)]);

  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const pad = (cells: string[]) =>
    cells.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  ");

  const lines = [
    paint.heading("Session token usage"),
    paint.emphasis("  " + pad(header)),
    paint.muted("  " + widths.map((w) => "─".repeat(w)).join("──")),
  ];
  for (const row of rows) {
    const line = "  " + pad(row);
    lines.push(row[0] === "total" ? paint.emphasis(line) : line);
  }
  lines.push(paint.muted("  Tokens only — no dollar estimate; pricing drifts. Reasoning counts toward output. Time is wall time per call."));
  if (calls.length > 0) {
    lines.push("", paint.heading(`Recent calls (last ${calls.length})`));
    for (const c of calls.slice(-12)) {
      lines.push(paint.muted(`  ${c.role.padEnd(8)} ${secs(c.durationMs).padStart(7)}  out ${fmt(c.outputTokens).padStart(6)}  reasoning ${fmt(c.reasoningTokens).padStart(6)}  ${c.model}`));
    }
  }
  return lines.join("\n");
}

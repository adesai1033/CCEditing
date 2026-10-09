import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { memoized, clearPrefetchMemo, prefetchSource } from "../agent/prefetch.js";
import { modelForRole, withUsageReporting, type CallMeta } from "../agent/providers/default.js";
import { MODEL_DEFAULT } from "../agent/providers/anthropic.js";
import { addUsage, emptyTotals, recordUsage, getCallLog, resetSessionTotals, renderCostReport, getSessionTotals } from "../repl/cost.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../agent/providers/types.js";
import { stripAnsi } from "../ui/theme.js";

let root: string;
before(() => { root = mkdtempSync(join(tmpdir(), "cutcli-speed-test-")); });
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
afterEach(() => clearPrefetchMemo());

describe("prefetch memo", () => {
  test("concurrent and later callers share one call", async () => {
    const f = join(root, "a.mov"); writeFileSync(f, "x");
    let calls = 0;
    const job = () => memoized("transcript", f, async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return "T"; });
    const [a, b] = await Promise.all([job(), job()]);
    assert.equal(await job(), "T");
    assert.deepEqual([a, b, calls], ["T", "T", 1]);
  });

  test("a failure is forgotten so the next caller retries", async () => {
    const f = join(root, "b.mov"); writeFileSync(f, "x");
    let calls = 0;
    const job = () => memoized("beats", f, async () => { calls++; if (calls === 1) throw new Error("503"); return "ok"; });
    await assert.rejects(job());
    await new Promise((r) => setImmediate(r));
    assert.equal(await job(), "ok");
    assert.equal(calls, 2);
  });

  test("a changed file is recomputed; different kinds don't collide", async () => {
    const f = join(root, "c.mov"); writeFileSync(f, "x");
    let n = 0;
    const job = (kind: string) => memoized(kind, f, async () => ++n);
    assert.equal(await job("transcript"), 1);
    assert.equal(await job("beats"), 2);
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.equal(await job("transcript"), 3);
  });

  test("prefetchSource starts only the jobs given, never throws, and can be disabled", async () => {
    const ran: string[] = [];
    const started = prefetchSource({
      transcribe: async () => { ran.push("t"); throw new Error("no key"); },
      mapVisualBeats: async () => { ran.push("b"); return []; },
    });
    assert.deepEqual(started, ["transcribe", "mapVisualBeats"]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ran.sort(), ["b", "t"]);
    process.env["CUTCLI_PREFETCH"] = "0";
    try {
      assert.deepEqual(prefetchSource({ transcribe: async () => ran.push("x") }), []);
    } finally {
      delete process.env["CUTCLI_PREFETCH"];
    }
  });
});

describe("per-role models and call timing", () => {
  test("each role reads its own env var, falling back to the default", () => {
    process.env["CUTCLI_CRITIC_MODEL"] = "claude-haiku-4-5-20251001";
    try {
      assert.equal(modelForRole("critic"), "claude-haiku-4-5-20251001");
      assert.equal(modelForRole("director"), MODEL_DEFAULT);
      assert.equal(modelForRole("scout"), MODEL_DEFAULT);
    } finally {
      delete process.env["CUTCLI_CRITIC_MODEL"];
    }
  });

  test("the usage tap routes the request to its role's model and reports wall time", async () => {
    process.env["CUTCLI_DIRECTOR_MODEL"] = "claude-sonnet-5";
    const seen: ChatRequest[] = [];
    const response: ChatResponse = { content: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 } };
    const inner: ChatProvider = {
      send: async (r) => { seen.push(r); await new Promise((x) => setTimeout(x, 15)); return response; },
      stream: (r) => { seen.push(r); return { [Symbol.asyncIterator]: async function* () {}, finalResponse: async () => response }; },
    };
    const reports: Array<{ role: string; meta: CallMeta }> = [];
    try {
      const p = withUsageReporting(inner, (role, _u, meta) => reports.push({ role, meta }));
      await p.send({ system: [], messages: [], tools: [], maxTokens: 1, role: "director" });
      await p.stream({ system: [], messages: [], tools: [], maxTokens: 1, role: "critic", model: "explicit" }).finalResponse();
    } finally {
      delete process.env["CUTCLI_DIRECTOR_MODEL"];
    }
    assert.equal(seen[0]!.model, "claude-sonnet-5");
    assert.equal(seen[1]!.model, "explicit", "an explicit model wins");
    assert.equal(reports[0]!.meta.model, "claude-sonnet-5");
    assert.ok(reports[0]!.meta.durationMs >= 10, `timed ${reports[0]!.meta.durationMs}ms`);
    assert.equal(reports[1]!.role, "critic");
  });

  test("/cost shows time per role and the recent calls", () => {
    resetSessionTotals();
    recordUsage("director", { inputTokens: 100, outputTokens: 900, reasoningTokens: 800 }, { durationMs: 120_000, model: "claude-sonnet-4-6" });
    recordUsage("critic", { inputTokens: 50, outputTokens: 300 }, { durationMs: 45_500, model: "claude-sonnet-4-6" });
    assert.equal(getCallLog().length, 2);
    const out = stripAnsi(renderCostReport(getSessionTotals(), getCallLog()));
    assert.match(out, /director\s+1\s+120\.0s/);
    assert.match(out, /total\s+2\s+165\.5s/);
    assert.match(out, /Recent calls/);
    assert.match(out, /critic\s+45\.5s.*claude-sonnet-4-6/);
    assert.equal(addUsage(emptyTotals(), "scout", { inputTokens: 1, outputTokens: 1 }).scout.durationMs, 0);
    resetSessionTotals();
  });
});

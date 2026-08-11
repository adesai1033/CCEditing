import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runScout, RECORD_FINDINGS_TOOL } from "../agent/scout.js";
import { buildPerceptionRegistry } from "../agent/perception-registry.js";
import { detectSilence } from "../agent/tools/detect_silence.js";
import type { ChatProvider, ChatResponse, ContentBlock } from "../agent/providers/types.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 60,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4", ...o,
  };
}

function makeState(): { state: ProjectState; sourceId: string } {
  let state = createProject("t");
  const r = addSource(state, makeMediaInfo());
  assert.ok(r.ok);
  state = r.state;
  return { state, sourceId: state.sources[0]!.id };
}

function mockProvider(responses: ChatResponse[]): ChatProvider {
  let i = 0;
  return { send: async () => {
    const r = responses[i++];
    if (!r) throw new Error(`mockProvider exhausted at ${i}`);
    return r;
  } };
}

function toolUse(name: string, input: unknown, id = "tu"): ChatResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } };
}

function recordFindings(input: unknown, id = "rf"): ChatResponse {
  return { content: [{ type: "tool_use", id, name: RECORD_FINDINGS_TOOL, input }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } };
}

const GOOD_FINDINGS = {
  outline: [{ start: 0, end: 30, gist: "intro" }, { start: 30, end: 60, gist: "demo" }],
  keyMoments: [{ time: 12, gist: "the reveal" }],
  silences: [{ start: 0, end: 2 }],
};

// A perception registry whose detect_silence is swapped for a call-recording stub.
function registryWithSpy() {
  const calls: string[] = [];
  const registry = buildPerceptionRegistry();
  registry.register({
    schema: detectSilence.schema,
    execute: async (_state, input) => {
      calls.push(`detect_silence:${JSON.stringify(input)}`);
      return { ok: true, result: { sourceId: "s", silences: [{ start: 0, end: 2, duration: 2 }], hasAudio: true, cached: false } };
    },
  });
  return { registry, calls };
}

// ── Perceive → distill ────────────────────────────────────────────────────────

describe("runScout — perceive one source into a bounded contribution", () => {
  test("calls a perception tool then records distilled findings", async () => {
    const { state, sourceId } = makeState();
    const { registry, calls } = registryWithSpy();
    const provider = mockProvider([
      toolUse("detect_silence", { sourceId }),
      recordFindings(GOOD_FINDINGS),
    ]);

    const r = await runScout(sourceId, state, { provider, registry });

    assert.equal(r.incomplete, false);
    assert.ok(r.contribution);
    assert.equal(r.contribution!.outline.length, 2);
    assert.equal(r.contribution!.keyMoments[0]!.gist, "the reveal");
    assert.deepEqual(calls, [`detect_silence:${JSON.stringify({ sourceId })}`]);
    // The contribution is written into the returned state's analyses for the survey to merge/persist.
    const src = r.state.sources.find((s) => s.id === sourceId)!;
    assert.ok(src.analyses.scoutContribution);
    assert.equal(src.analyses.scoutContribution!.keyMoments[0]!.gist, "the reveal");
  });

  test("over-cap findings are bounded and flagged truncated", async () => {
    const { state, sourceId } = makeState();
    const registry = buildPerceptionRegistry();
    const bigOutline = Array.from({ length: 40 }, (_, i) => ({ start: i, end: i + 1, gist: `beat ${i}` }));
    const provider = mockProvider([recordFindings({ outline: bigOutline, keyMoments: [] })]);

    const r = await runScout(sourceId, state, { provider, registry });

    assert.equal(r.incomplete, false);
    assert.ok(r.contribution!.outline.length <= 12, "outline capped");
    assert.equal(r.contribution!.truncated, true);
  });
});

// ── Read-only ─────────────────────────────────────────────────────────────────

describe("runScout — read-only", () => {
  test("the scout's perception tool set contains no write or survey tools", () => {
    const names = buildPerceptionRegistry().perceptionSchemas().map((s) => s.name);
    assert.ok(!names.includes("propose_edit_plan"), "scout must not see propose_edit_plan");
    assert.ok(!names.includes("survey_sources"), "scout must not see survey_sources (no recursion)");
  });

  test("a write/survey tool call from the model is refused, not dispatched", async () => {
    const { state, sourceId } = makeState();
    const registry = buildPerceptionRegistry();
    // Model tries to write, then (having been refused) records findings.
    const provider = mockProvider([
      toolUse("propose_edit_plan", { operations: [] }),
      recordFindings(GOOD_FINDINGS),
    ]);

    const r = await runScout(sourceId, state, { provider, registry });

    // The scout still completes read-only; the timeline is untouched by it.
    assert.equal(r.incomplete, false);
    assert.deepEqual(r.state.timeline, state.timeline);
  });
});

// ── Degradation ───────────────────────────────────────────────────────────────

describe("runScout — degrades to incomplete, never throws", () => {
  test("provider that throws → incomplete, no throw", async () => {
    const { state, sourceId } = makeState();
    const registry = buildPerceptionRegistry();
    const provider: ChatProvider = { send: async () => { throw new Error("rate limited"); } };

    const r = await runScout(sourceId, state, { provider, registry });
    assert.equal(r.incomplete, true);
    assert.equal(r.contribution, null);
  });

  test("never records findings before budget is exhausted → incomplete", async () => {
    const { state, sourceId } = makeState();
    const { registry } = registryWithSpy();
    // Always calls a perception tool, never record_findings.
    const provider: ChatProvider = {
      send: async () => toolUse("detect_silence", { sourceId }),
    };

    const r = await runScout(sourceId, state, { provider, registry, budget: 3 });
    assert.equal(r.incomplete, true);
    assert.equal(r.contribution, null);
  });

  test("max_output truncation → incomplete", async () => {
    const { state, sourceId } = makeState();
    const registry = buildPerceptionRegistry();
    const provider = mockProvider([
      { content: [{ type: "text", text: "thinking too long" }], stopReason: "max_output", usage: { inputTokens: 0, outputTokens: 8000 } },
    ]);

    const r = await runScout(sourceId, state, { provider, registry });
    assert.equal(r.incomplete, true);
  });

  test("unknown source → incomplete without calling the provider", async () => {
    const { state } = makeState();
    let called = false;
    const provider: ChatProvider = { send: async () => { called = true; return toolUse("x", {}); } };
    const r = await runScout("does-not-exist", state, { provider, registry: buildPerceptionRegistry() });
    assert.equal(r.incomplete, true);
    assert.equal(called, false);
  });
});

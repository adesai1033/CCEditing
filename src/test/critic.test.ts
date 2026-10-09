import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCritic, SUBMIT_REVIEW_TOOL, type CriticInput } from "../agent/critic.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../agent/providers/types.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4",
    fileName: "a.mp4",
    duration: 120,
    width: 1920, height: 1080, fps: 30,
    videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128,
    fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4",
    ...overrides,
  };
}

function makeState(): ProjectState {
  const r = addSource(createProject("t"), makeMediaInfo());
  assert.ok(r.ok);
  return r.state;
}

function makeInput(state: ProjectState): CriticInput {
  return {
    userRequest: "tighten this to about 30 seconds",
    contentMap: {
      sources: [{
        sourceId: state.sources[0]!.id, displayRef: "1", duration: 120,
        outline: [{ start: 0, end: 4, gist: "flat intro" }, { start: 4, end: 120, gist: "the good part" }],
        keyMoments: [{ time: 4, gist: "strongest moment" }],
      }],
      truncated: false,
    },
    plan: {
      summary: "Tighten to 30 seconds opening on the strongest moment.",
      operations: [{ type: "trim", clipId: state.timeline.headId!, inPoint: 4, outPoint: 34 }],
    },
    renderedPlan: ["Trim clip [1] a.mp4 → 0:04–0:34"],
    timelineState: state,
  };
}

// A send-only provider serving canned responses and recording every request.
// The critic must never stream — its pass renders as a single dim line.
function cannedProvider(responses: ChatResponse[]): { provider: ChatProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    requests,
    provider: {
      send: async (req) => {
        requests.push(req);
        const r = responses[i++];
        if (!r) throw new Error(`cannedProvider exhausted at call ${i}`);
        return r;
      },
      stream: () => { throw new Error("the critic must not stream"); },
    },
  };
}

function reviewToolUse(input: unknown): ChatResponse {
  return {
    content: [{ type: "tool_use", id: "tu_review", name: SUBMIT_REVIEW_TOOL, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function proseReply(text: string): ChatResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

// ── Verdict parsing ───────────────────────────────────────────────────────────

describe("runCritic — verdict parsing", () => {
  test("parses an approve verdict", async () => {
    const { provider } = cannedProvider([reviewToolUse({ verdict: "approve", concerns: [] })]);
    const v = await runCritic(makeInput(makeState()), { provider });
    assert.equal(v.verdict, "approve");
    assert.deepEqual(v.concerns, []);
  });

  test("parses a revise verdict with severity and operationIndex", async () => {
    const { provider } = cannedProvider([reviewToolUse({
      verdict: "revise",
      concerns: [
        { severity: "major", operationIndex: 0, issue: "Trim ends mid-word at 34s; the segment boundary is 35.2s." },
        { severity: "minor", issue: "Resulting duration is 30s but the request implied including the closer." },
      ],
    })]);
    const v = await runCritic(makeInput(makeState()), { provider });
    assert.equal(v.verdict, "revise");
    assert.equal(v.concerns.length, 2);
    assert.equal(v.concerns[0]!.severity, "major");
    assert.equal(v.concerns[0]!.operationIndex, 0);
    assert.match(v.concerns[1]!.issue, /duration/);
  });
});

// ── Isolation guard (the key one) ─────────────────────────────────────────────
//
// The critic's whole value is fresh eyes: it sees the request, the map, the
// plan, and the timeline — and NOT the director's conversation. runCritic
// cannot even accept a history; this pins what actually crosses the seam.

describe("runCritic — isolation", () => {
  test("the provider request carries exactly one fresh user message with the review payload", async () => {
    const state = makeState();
    const input = makeInput(state);
    const { provider, requests } = cannedProvider([reviewToolUse({ verdict: "approve", concerns: [] })]);

    await runCritic(input, { provider });

    assert.equal(requests.length, 1);
    const req = requests[0]!;
    // One message, role user — no director history, no prior assistant turns.
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0]!.role, "user");
    const text = req.messages[0]!.content.find((b) => b.type === "text");
    assert.ok(text && text.type === "text");
    // The payload carries the request, the plan (rendered AND structured),
    // the map, and the timeline snapshot.
    assert.match(text.text, /tighten this to about 30 seconds/);
    assert.match(text.text, /Tighten to 30 seconds opening on the strongest moment/);
    assert.match(text.text, /Trim clip \[1\]/);
    assert.match(text.text, /"inPoint": 4/);
    assert.match(text.text, /strongest moment/);
    assert.match(text.text, /## Current timeline/);
  });

  test("the critic's tool set is submit_review alone — no write tools, no perception tools", async () => {
    const { provider, requests } = cannedProvider([reviewToolUse({ verdict: "approve", concerns: [] })]);
    await runCritic(makeInput(makeState()), { provider });
    assert.deepEqual(requests[0]!.tools.map((t) => t.name), [SUBMIT_REVIEW_TOOL]);
  });

  test("review runs with reasoning enabled (decision 7)", async () => {
    const { provider, requests } = cannedProvider([reviewToolUse({ verdict: "approve", concerns: [] })]);
    await runCritic(makeInput(makeState()), { provider });
    assert.deepEqual(requests[0]!.reasoning, { enabled: true, effort: "medium" });
  });

  test("a revise with only minor concerns counts as approve, concerns kept", async () => {
    const { provider } = cannedProvider([reviewToolUse({
      verdict: "revise",
      concerns: [{ severity: "minor", issue: "overlay ends a second early" }],
    })]);
    const v = await runCritic(makeInput(makeState()), { provider });
    assert.equal(v.verdict, "approve");
    assert.equal(v.concerns.length, 1);
  });

  test("a missing content map is stated, not fabricated", async () => {
    const { provider, requests } = cannedProvider([reviewToolUse({ verdict: "approve", concerns: [] })]);
    await runCritic({ ...makeInput(makeState()), contentMap: null }, { provider });
    const text = requests[0]!.messages[0]!.content.find((b) => b.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text, /no content map/);
  });
});

// ── Fail-open behavior ────────────────────────────────────────────────────────
//
// A critic failure must never strand a valid plan: every malformed or errored
// path degrades to approve with a warning, and never throws.

describe("runCritic — fail-open", () => {
  test("malformed verdict input → approve, warning logged, no throw", async () => {
    const { provider } = cannedProvider([reviewToolUse({ verdict: "maybe", concerns: "nope" })]);
    const warnings: string[] = [];
    const v = await runCritic(makeInput(makeState()), { provider, onWarn: (m) => warnings.push(m) });
    assert.equal(v.verdict, "approve");
    assert.deepEqual(v.concerns, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /failing open/);
  });

  test("prose-only reply is nudged once; a valid verdict on the retry is honored", async () => {
    const { provider, requests } = cannedProvider([
      proseReply("The plan looks weak because…"),
      reviewToolUse({ verdict: "revise", concerns: [{ severity: "major", issue: "blown duration target" }] }),
    ]);
    const v = await runCritic(makeInput(makeState()), { provider });
    assert.equal(v.verdict, "revise");
    assert.equal(requests.length, 2);
    // The nudge went back with the prose turn in place.
    const nudge = requests[1]!.messages[requests[1]!.messages.length - 1]!;
    assert.equal(nudge.role, "user");
    assert.match(JSON.stringify(nudge.content), /submit_review/);
  });

  test("prose-only reply twice → approve with warning", async () => {
    const { provider } = cannedProvider([proseReply("Looks fine."), proseReply("Still prose.")]);
    const warnings: string[] = [];
    const v = await runCritic(makeInput(makeState()), { provider, onWarn: (m) => warnings.push(m) });
    assert.equal(v.verdict, "approve");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /never called submit_review/);
  });

  test("provider error → approve with warning, no throw", async () => {
    const provider: ChatProvider = {
      send: async () => { throw new Error("rate limited"); },
      stream: () => { throw new Error("rate limited"); },
    };
    const warnings: string[] = [];
    const v = await runCritic(makeInput(makeState()), { provider, onWarn: (m) => warnings.push(m) });
    assert.equal(v.verdict, "approve");
    assert.match(warnings[0]!, /rate limited/);
  });
});

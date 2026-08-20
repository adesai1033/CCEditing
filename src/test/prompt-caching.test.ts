import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runAgent } from "../agent/loop.js";
import { runScout } from "../agent/scout.js";
import { buildPerceptionRegistry } from "../agent/perception-registry.js";
import { staticSystemPrefix, stateSnapshotSegment } from "../agent/prompt.js";
import type { ChatProvider, ChatRequest, ChatResponse, SystemSegment } from "../agent/providers/types.js";
import { createSession } from "../project/session.js";
import { createProject } from "../project/io.js";
import { addSource, trimClip } from "../project/mutations.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 120,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4", ...o,
  };
}

function makeState(): ProjectState {
  const r = addSource(createProject("t"), makeMediaInfo());
  assert.ok(r.ok);
  return r.state;
}

function endTurn(text: string): ChatResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
}

// A provider that records every ChatRequest and streams/blocks a canned end_turn.
function capturingProvider(): { provider: ChatProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const respond = () => endTurn("OK.");
  return {
    requests,
    provider: {
      send: async (req) => { requests.push(req); return respond(); },
      stream: (req) => {
        requests.push(req);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta" as const, text: "OK." };
            yield { type: "message_complete" as const, stopReason: "end_turn" as const };
          },
          async finalResponse() { return respond(); },
        };
      },
    },
  };
}

function segmentsOf(req: ChatRequest): SystemSegment[] {
  assert.ok(Array.isArray(req.system), "director requests carry segmented system prompts");
  return req.system;
}

// ── The core guard: quiet no-cache made loud ──────────────────────────────────
//
// A caching change that silently doesn't cache looks exactly like success. The
// regression that would cause it here is state leaking back into the cacheable
// prefix. So: run two agent turns with a PROJECT STATE CHANGE between them and
// assert the cacheable segment is byte-identical while the volatile segment
// actually changed.

describe("prompt caching — static prefix stability", () => {
  test("cacheable segment is byte-identical across turns with different project state", async () => {
    const { provider, requests } = capturingProvider();

    // Turn 1 against the initial state.
    const stateA = makeState();
    await runAgent({
      userPrompt: "hello", session: createSession(stateA), messages: [],
      autoApprove: false, confirm: async () => ({ approved: true }), provider,
    });

    // Mutate project state (trim the clip), then turn 2.
    const clipId = stateA.timeline.headId!;
    const trimmed = trimClip(stateA, clipId, { inPoint: 5, outPoint: 60 });
    assert.ok(trimmed.ok);
    await runAgent({
      userPrompt: "hello again", session: createSession(trimmed.state), messages: [],
      autoApprove: false, confirm: async () => ({ approved: true }), provider,
    });

    assert.equal(requests.length, 2);
    const [reqA, reqB] = [segmentsOf(requests[0]!), segmentsOf(requests[1]!)];

    // The cacheable prefix: identical bytes, marked cacheable, first segment.
    assert.equal(reqA[0]!.cacheable, true);
    assert.equal(reqB[0]!.cacheable, true);
    assert.equal(reqA[0]!.text, reqB[0]!.text, "static prefix must be byte-identical across state changes");

    // The volatile segment: NOT cacheable, and it actually changed with state —
    // proving the snapshot moved out of the cached prefix rather than vanishing.
    assert.ok(!reqA[1]!.cacheable && !reqB[1]!.cacheable);
    assert.notEqual(reqA[1]!.text, reqB[1]!.text, "volatile snapshot must reflect the state change");
    assert.match(reqB[1]!.text, /"inPoint": 5/, "snapshot carries the mutated state");
  });

  test("volatile segment carries the timeline snapshot, after the cacheable prefix", async () => {
    const { provider, requests } = capturingProvider();
    const state = makeState();
    await runAgent({
      userPrompt: "hi", session: createSession(state), messages: [],
      autoApprove: false, confirm: async () => ({ approved: true }), provider,
    });

    const segs = segmentsOf(requests[0]!);
    assert.equal(segs.length, 2);
    // Static prefix holds instructions, no state.
    assert.ok(!segs[0]!.text.includes("Current timeline state"));
    assert.ok(!segs[0]!.text.includes(state.timeline.headId!), "no clip ids in the cacheable prefix");
    // Volatile segment holds the snapshot.
    assert.match(segs[1]!.text, /## Current timeline state/);
    assert.ok(segs[1]!.text.includes(state.timeline.headId!), "snapshot lists the clip");
  });
});

// ── Content equivalence: the restructure dropped nothing ─────────────────────

describe("prompt caching — instruction equivalence", () => {
  test("static + volatile concatenated still carries every load-bearing section", async () => {
    const full = staticSystemPrefix() + "\n" + (await stateSnapshotSegment(makeState()));

    // Load-bearing sections from the pre-split prompt.
    assert.match(full, /## Operation vocabulary/);
    assert.match(full, /- trim: \{ type: "trim"/);
    assert.match(full, /## Reasoning/);
    assert.match(full, /## Time format/);
    assert.match(full, /## Clip references/);
    assert.match(full, /survey_sources — distilled content map/);
    assert.match(full, /## Narrative planning/);
    assert.match(full, /## Verification \(REQUIRED before proposing\)/);
    assert.match(full, /Do NOT propose a trim\/split\/move whose boundaries you are guessing/);
    assert.match(full, /## When to propose vs ask/);
    assert.match(full, /## Current timeline state/);
    assert.match(full, /CANNOT import new files/);
  });

  test("the static prefix contains nothing stateful", () => {
    // Called twice → identical (it takes no arguments, but guard against
    // accidental Date.now()/randomness creeping in).
    assert.equal(staticSystemPrefix(), staticSystemPrefix());
  });
});

// ── Scouts inherit the mechanism ──────────────────────────────────────────────

describe("prompt caching — scouts", () => {
  test("two scouts on different sources share a byte-identical cacheable prefix", async () => {
    let state = createProject("t");
    for (const f of ["a.mp4", "b.mp4"]) {
      const r = addSource(state, makeMediaInfo({ fileName: f }));
      assert.ok(r.ok);
      state = r.state;
    }
    const [srcA, srcB] = state.sources.map((s) => s.id);

    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      send: async (req) => {
        requests.push(req);
        // End immediately (scout degrades to incomplete — fine for this test).
        return endTurn("done");
      },
      stream: () => { throw new Error("scouts must not stream"); },
    };
    const registry = buildPerceptionRegistry();

    await runScout(srcA!, state, { provider, registry });
    await runScout(srcB!, state, { provider, registry });

    assert.equal(requests.length, 2);
    const [a, b] = [segmentsOf(requests[0]!), segmentsOf(requests[1]!)];
    assert.equal(a[0]!.cacheable, true);
    assert.equal(a[0]!.text, b[0]!.text, "scout static prefix shared across sources");
    // Per-source segment differs and is uncached.
    assert.notEqual(a[1]!.text, b[1]!.text);
    assert.ok(!a[1]!.cacheable);
    assert.match(a[1]!.text, new RegExp(srcA!));
    assert.match(b[1]!.text, new RegExp(srcB!));
  });
});

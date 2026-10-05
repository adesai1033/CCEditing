import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { clipsInOrder } from "../project/types.js";
import { addSource } from "../project/mutations.js";
import { applyOperations } from "../project/session.js";
import { createProject } from "../project/io.js";
import { staticSystemPrefix } from "../agent/prompt.js";
import { uploadTimeoutMs } from "../agent/backends/gemini.js";
import type { MediaInfo } from "../media/types.js";

function media(name: string, duration: number): MediaInfo {
  return {
    filePath: `/fake/${name}`, fileName: name, duration,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1, bitrate: 1, containerFormat: "mp4",
  };
}

describe("cutaway recipe from the system prompt", () => {
  test("split the main clip, move the insert between the halves, trim it → A, insert, A", () => {
    let state = createProject("t");
    state = (addSource(state, media("Elderly.mov", 143.49)) as { ok: true; state: typeof state }).state;
    state = (addSource(state, media("son.mov", 40)) as { ok: true; state: typeof state }).state;
    const [main, insert] = clipsInOrder(state.timeline);

    const r = applyOperations(state, [
      { type: "split", clipId: main!.id, splitPoint: 56.8 },
      // After the split the order is [main-a, main-b, insert]; index 1 sits between the halves.
      { type: "move", clipId: insert!.id, newIndex: 1 },
      { type: "trim", clipId: insert!.id, inPoint: 12, outPoint: 18 },
    ]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    const order = clipsInOrder(r.state.timeline).map((c) => [c.label, c.inPoint, c.outPoint]);
    assert.deepEqual(order, [
      ["Elderly.mov", 0, 56.8],
      ["son.mov", 12, 18],
      ["Elderly.mov", 56.8, 143.49],
    ]);
  });

  test("the prompt teaches both cutaway patterns and the story-edit method", () => {
    const p = staticSystemPrefix();
    // Cutaway over continuous sound (B-roll) vs. a cutaway with its own sound.
    assert.match(p, /MAIN TRACK'S SOUND KEEPS PLAYING/);
    assert.match(p, /## Cutting away with the cutaway's own sound/);
    assert.match(p, /split the spine at the cut point.*newClipId/s);
    // Story edits: spine, full read, finish the story, concise, matched cutaways.
    assert.match(p, /## Story edits/);
    assert.match(p, /Pick the spine/);
    assert.match(p, /Read the spine's full transcript/);
    assert.match(p, /Finish the story/);
    assert.match(p, /keepRanges on the spine/);
    assert.match(p, /map_visual_beats on every B-roll/);
    assert.match(p, /atSource/);
    // The decision rules that the first story run missed.
    assert.match(p, /Pick the spine BY SOUND/);
    assert.match(p, /means switch the PICTURE to X/);
    assert.match(p, /Read PAST the user's last cue/);
    assert.match(p, /Worked example/);
  });
});

describe("Gemini upload deadline", () => {
  test("has a 2-minute floor and grows with file size", () => {
    assert.equal(uploadTimeoutMs(0), 120_000);
    assert.equal(uploadTimeoutMs(250 * 1024 * 60), 180_000);    // ~15 MB → +60s
    assert.ok(uploadTimeoutMs(2 * 1024 ** 3) > 2 * 60 * 60_000, "a 2 GB file gets over two hours");
  });
});

// ── Split with a caller-named second half ─────────────────────────────────────

import { splitClip } from "../project/mutations.js";
import { renderPlanForConfirmation, AgentOperationSchema } from "../agent/propose_edit_plan.js";
import { formatTime } from "../utils/time.js";

function threeSources() {
  let state = createProject("t");
  for (const [n, d] of [["elderly.MOV", 143.49], ["son.MOV", 138.59], ["computer_use.mov", 146.78]] as const) {
    const r = addSource(state, media(n, d));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

describe("split newClipId", () => {
  test("the whole cutaway — split, trim the named half, move, trim the insert — is ONE plan", () => {
    const state = threeSources();
    const [elderly, son] = clipsInOrder(state.timeline);
    const ops = [
      { type: "split" as const, clipId: elderly!.id, splitPoint: 56.78, newClipId: "elderly-part2" },
      { type: "trim" as const, clipId: "elderly-part2", inPoint: 61.98, outPoint: 65.68 },
      { type: "move" as const, clipId: son!.id, newIndex: 1 },
      { type: "trim" as const, clipId: son!.id, inPoint: 115, outPoint: 138.59 },
    ];
    assert.ok(ops.every((o) => AgentOperationSchema.safeParse(o).success), "the agent may send it");
    const r = applyOperations(state, ops);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(clipsInOrder(r.state.timeline).map((c) => [c.label, c.inPoint, c.outPoint]), [
      ["elderly.MOV", 0, 56.78],
      ["son.MOV", 115, 138.59],
      ["elderly.MOV", 61.98, 65.68],
      ["computer_use.mov", 0, 146.78],
    ]);

    const plan = renderPlanForConfirmation(state, { summary: "s", operations: ops });
    assert.equal(plan.renderedLines[0], "Split clip [1] elderly.MOV at 0:56.8 → second half [new 1b]");
    assert.equal(plan.renderedLines[1], "Trim clip [new 1b] elderly.MOV → 1:02–1:05.7");
  });

  test("a newClipId that collides with an existing clip or overlay is rejected", () => {
    const state = threeSources();
    const [a, b] = clipsInOrder(state.timeline);
    const dup = splitClip(state, a!.id, 10, b!.id);
    assert.ok(!dup.ok && /already in use/.test(dup.error));
    const blank = splitClip(state, a!.id, 10, "  ");
    assert.ok(!blank.ok && /cannot be empty/.test(blank.error));
    const named = splitClip(state, a!.id, 10, "part2");
    assert.ok(named.ok);
    assert.ok(named.state.timeline.clips["part2"]);
  });

  test("without newClipId a split still gets a random id", () => {
    const state = threeSources();
    const r = splitClip(state, clipsInOrder(state.timeline)[0]!.id, 10);
    assert.ok(r.ok);
    assert.match(clipsInOrder(r.state.timeline)[1]!.id, /^[0-9a-f-]{36}$/);
  });
});

describe("time formatting rounds before splitting off tenths", () => {
  test("61.98 is 1:02, never 1:01.10", () => {
    assert.equal(formatTime(61.98), "1:02");
    assert.equal(formatTime(59.96), "1:00");
    assert.equal(formatTime(90.5), "1:30.5");
    assert.equal(formatTime(3599.99), "1:00:00");
  });
});

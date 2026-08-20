import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderTimeline } from "../display/timeline.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { createProject } from "../project/io.js";
import { addSource, trimClip, reorderClip, splitClip, removeClip, setClipUserLabel } from "../project/mutations.js";
import { clipsInOrder } from "../project/types.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/video.mp4",
    fileName: "video.mp4",
    duration: 120,
    width: 1920, height: 1080, fps: 30,
    videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128,
    fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4",
    ...overrides,
  };
}

function makeProject(clips: Array<Partial<MediaInfo>> = [{}]): ProjectState {
  let state = createProject("test");
  for (let i = 0; i < clips.length; i++) {
    const r = addSource(state, makeMediaInfo({ fileName: `clip${i + 1}.mp4`, ...clips[i] }));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

const WIDTH = 80;

// ── renderTimeline ────────────────────────────────────────────────────────────

describe("renderTimeline", () => {
  test("empty timeline renders 3-line box with placeholder message", () => {
    const state = createProject("test");
    const out = strip(renderTimeline(state, WIDTH));
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.ok(out.includes("No clips on timeline"));
  });

  test("non-empty timeline renders 7-line box", () => {
    const state = makeProject();
    const out = strip(renderTimeline(state, WIDTH));
    const lines = out.split("\n");
    assert.equal(lines.length, 7);
  });

  test("box borders are present (rounded, 3I)", () => {
    const state = makeProject();
    const out = strip(renderTimeline(state, WIDTH));
    const lines = out.split("\n");
    assert.ok(lines[0]!.includes("╭"));
    assert.ok(lines[0]!.includes("╮"));
    assert.ok(lines[6]!.includes("╰"));
    assert.ok(lines[6]!.includes("╯"));
  });

  test("every line fits within an 80-column terminal", () => {
    const state = makeProject([{ duration: 45 }, { duration: 90 }, { duration: 15 }]);
    const out = strip(renderTimeline(state, 80));
    for (const line of out.split("\n")) {
      assert.ok(line.length <= 80, `line overflows 80 cols (${line.length}): ${line}`);
    }
  });

  test("every line fits within a narrow 60-column terminal", () => {
    const state = makeProject([{ duration: 45 }, { duration: 90 }]);
    const out = strip(renderTimeline(state, 60));
    for (const line of out.split("\n")) {
      assert.ok(line.length <= 60, `line overflows 60 cols (${line.length}): ${line}`);
    }
  });

  test("clip label appears in bar", () => {
    const state = makeProject([{ fileName: "myvideo.mp4" }]);
    const out = strip(renderTimeline(state, WIDTH));
    assert.ok(out.includes("myvideo.mp4"));
  });

  test("summary line shows correct clip count — singular", () => {
    const state = makeProject([{}]);
    const out = strip(renderTimeline(state, WIDTH));
    assert.match(out, /1 clip[^s]/);
  });

  test("summary line shows correct clip count — plural", () => {
    const state = makeProject([{}, {}]);
    const out = strip(renderTimeline(state, WIDTH));
    assert.match(out, /2 clips/);
  });

  test("summary line shows total duration (2 × 120s = 4:00)", () => {
    const state = makeProject([{ duration: 120 }, { duration: 120 }]);
    const out = strip(renderTimeline(state, WIDTH));
    assert.match(out, /Total: 4:00/);
  });

  test("after reorder, clip labels appear in new order", () => {
    let state = makeProject([{ fileName: "alpha.mp4" }, { fileName: "beta.mp4" }, { fileName: "gamma.mp4" }]);
    // move clip 1 (alpha) to position 3: order becomes beta, gamma, alpha
    const [alpha] = clipsInOrder(state.timeline);
    const r = reorderClip(state, alpha!.id, 2);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderTimeline(state, WIDTH));
    const alphaPos = out.indexOf("alpha");
    const betaPos  = out.indexOf("beta");
    assert.ok(betaPos < alphaPos, "beta should appear before alpha after reorder");
  });

  test("after delete, summary reflects reduced count", () => {
    let state = makeProject([{}, {}, {}]);
    const [first] = clipsInOrder(state.timeline);
    const r = removeClip(state, first!.id);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderTimeline(state, WIDTH));
    assert.match(out, /2 clips/);
    assert.ok(!out.match(/3 clips/));
  });

  test("after split, summary shows 2 clips", () => {
    let state = makeProject([{ duration: 120 }]);
    const [clip] = clipsInOrder(state.timeline);
    const r = splitClip(state, clip!.id, 60);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderTimeline(state, WIDTH));
    assert.match(out, /2 clips/);
  });

  test("after trim, total duration reflects trimmed length", () => {
    // Trim the only clip to 0–60 so total becomes 1:00
    let state = makeProject([{ duration: 120 }]);
    const [clip] = clipsInOrder(state.timeline);
    const r = trimClip(state, clip!.id, { inPoint: 0, outPoint: 60 });
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderTimeline(state, WIDTH));
    assert.match(out, /Total: 1:00/);
  });

  test("viewport with offscreen clips shows offscreen indicators", () => {
    // 3 clips of 60s each (total 180s), viewport only covers middle 60s
    const state = makeProject([{ duration: 60 }, { duration: 60 }, { duration: 60 }]);
    const out = strip(renderTimeline(state, WIDTH, { startTime: 60, viewDuration: 60 }));
    assert.match(out, /◀/);  // clip to the left
    assert.match(out, /▶/);  // clip to the right
  });

  test("all-offscreen viewport shows 'No clips in this view'", () => {
    const state = makeProject([{ duration: 60 }]);
    const out = strip(renderTimeline(state, WIDTH, { startTime: 200, viewDuration: 60 }));
    assert.ok(out.includes("No clips in this view"));
  });
});

// ── renderClipList ────────────────────────────────────────────────────────────

describe("renderClipList", () => {
  test("empty timeline returns empty string", () => {
    assert.equal(renderClipList(createProject("test")), "");
  });

  test("single clip shows [1] ref", () => {
    const state = makeProject();
    const out = strip(renderClipList(state));
    assert.match(out, /\[1\]/);
  });

  test("three clips show [1], [2], [3] refs", () => {
    const state = makeProject([{}, {}, {}]);
    const out = strip(renderClipList(state));
    assert.match(out, /\[1\]/);
    assert.match(out, /\[2\]/);
    assert.match(out, /\[3\]/);
  });

  test("clip labels appear in list", () => {
    const state = makeProject([{ fileName: "foo.mp4" }, { fileName: "bar.mp4" }]);
    const out = strip(renderClipList(state));
    assert.ok(out.includes("foo.mp4"));
    assert.ok(out.includes("bar.mp4"));
  });

  test("in/out times appear for each clip", () => {
    const state = makeProject([{ duration: 120 }]);
    const out = strip(renderClipList(state));
    // clip is 0–120 → rendered as 0:00 → 2:00
    assert.match(out, /0:00/);
    assert.match(out, /2:00/);
  });

  test("after trim, updated in/out times are shown", () => {
    let state = makeProject([{ duration: 120 }]);
    const [clip] = clipsInOrder(state.timeline);
    const r = trimClip(state, clip!.id, { inPoint: 30, outPoint: 90 });
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderClipList(state));
    assert.match(out, /0:30/);
    assert.match(out, /1:30/);
  });

  test("clips appear in timeline order", () => {
    const state = makeProject([{ fileName: "first.mp4" }, { fileName: "second.mp4" }]);
    const out = strip(renderClipList(state));
    assert.ok(out.indexOf("first.mp4") < out.indexOf("second.mp4"));
  });

  test("after reorder, list reflects new order", () => {
    let state = makeProject([{ fileName: "alpha.mp4" }, { fileName: "beta.mp4" }]);
    const [alpha] = clipsInOrder(state.timeline);
    const r = reorderClip(state, alpha!.id, 1);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderClipList(state));
    assert.ok(out.indexOf("beta.mp4") < out.indexOf("alpha.mp4"), "beta should be listed before alpha");
  });

  test("after delete, removed clip is absent", () => {
    let state = makeProject([{ fileName: "keep.mp4" }, { fileName: "remove.mp4" }]);
    const clips = clipsInOrder(state.timeline);
    const r = removeClip(state, clips[1]!.id);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderClipList(state));
    assert.ok(out.includes("keep.mp4"));
    assert.ok(!out.includes("remove.mp4"));
  });

  test("after split, two entries appear with [1a] and [1b] refs", () => {
    let state = makeProject([{ duration: 120 }]);
    const [clip] = clipsInOrder(state.timeline);
    const r = splitClip(state, clip!.id, 60);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderClipList(state));
    assert.match(out, /\[1a\]/);
    assert.match(out, /\[1b\]/);
    assert.ok(!out.match(/\[1\][^ab]/), "bare [1] ref should not appear after split");
  });

  test("clip after a split group keeps its original base index (no shift)", () => {
    // A(1), B(2), C(3) — split B → Ba(2a), Bb(2b), C stays [3] not [4]
    let state = makeProject([{}, {}, {}]);
    const [, b] = clipsInOrder(state.timeline);
    const r = splitClip(state, b!.id, 60);
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderClipList(state));
    assert.match(out, /\[2a\]/);
    assert.match(out, /\[2b\]/);
    assert.match(out, /\[3\]/);
    assert.ok(!out.includes("[4]"), "C should be [3] not [4]");
  });

  test("splitting again produces [1a], [1b], [1c]", () => {
    let state = makeProject([{ duration: 180 }]);
    const [clip] = clipsInOrder(state.timeline);
    const r1 = splitClip(state, clip!.id, 60);
    assert.ok(r1.ok);
    state = r1.state;

    // Split the second half (1b) again at 120
    const second = clipsInOrder(state.timeline)[1]!;
    const r2 = splitClip(state, second.id, 120);
    assert.ok(r2.ok);
    state = r2.state;

    const out = strip(renderClipList(state));
    assert.match(out, /\[1a\]/);
    assert.match(out, /\[1b\]/);
    assert.match(out, /\[1c\]/);
    assert.ok(!out.includes("[2]"), "no phantom [2] should appear");
  });

  test("each entry contains duration in parentheses", () => {
    const state = makeProject([{ duration: 120 }]);
    const out = strip(renderClipList(state));
    assert.match(out, /\(2m\)/);
  });

  test("a user label (3E-3 /label) renders as a trailing chip", () => {
    let state = makeProject([{}, {}]);
    const [first] = clipsInOrder(state.timeline);
    const r = setClipUserLabel(state, first!.id, "good take");
    assert.ok(r.ok);
    state = r.state;

    const out = strip(renderClipList(state));
    assert.match(out, /♦ good take/);
    // Only the labeled clip carries the chip.
    assert.equal(out.split("♦").length - 1, 1);
  });

  test("columns align: every ref column starts at the same offset", () => {
    const state = makeProject([{ fileName: "a.mp4" }, { fileName: "longer-name.mp4" }, { fileName: "b.mp4" }]);
    const out = strip(renderClipList(state));
    const lines = out.split("\n");
    const offsets = new Set(lines.map((l) => l.indexOf("[")));
    assert.equal(offsets.size, 1, "ref brackets must align vertically");
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  clipsInOrder,
  resolveClip,
  getClipDisplayRefs,
  type Timeline,
  type Clip,
  type ProjectState,
} from "../project/types.js";
import {
  addSource,
  trimClip,
  removeClip,
  reorderClip,
  renameClip,
  removeSource,
  splitClip,
} from "../project/mutations.js";
import { createProject } from "../project/io.js";
import type { MediaInfo } from "../media/types.js";

// ── Test fixtures ──────────────────────────────────────────────────────────────

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/video.mp4",
    fileName: "video.mp4",
    duration: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    fileSize: 1_000_000,
    bitrate: 133333,
    audioBitrate: null,
    audioChannels: null,
    containerFormat: "mp4",
    ...overrides,
  };
}

function makeProject(): ProjectState {
  return createProject("test");
}

// Add n clips to a project, each with duration `dur` seconds
function addClips(state: ProjectState, n: number, dur = 60): ProjectState {
  let s = state;
  for (let i = 0; i < n; i++) {
    const r = addSource(s, makeMediaInfo({ fileName: `clip${i + 1}.mp4`, duration: dur }));
    assert.ok(r.ok);
    s = r.state;
  }
  return s;
}

function ids(state: ProjectState): string[] {
  return clipsInOrder(state.timeline).map((c) => c.label);
}

// ── clipsInOrder ──────────────────────────────────────────────────────────────

describe("clipsInOrder", () => {
  test("empty timeline returns []", () => {
    const tl: Timeline = { headId: null, tailId: null, clips: {} };
    assert.deepEqual(clipsInOrder(tl), []);
  });

  test("single clip returns that clip", () => {
    const s = addClips(makeProject(), 1);
    const ordered = clipsInOrder(s.timeline);
    assert.equal(ordered.length, 1);
  });

  test("three clips return in insertion order", () => {
    const s = addClips(makeProject(), 3);
    assert.deepEqual(ids(s), ["clip1.mp4", "clip2.mp4", "clip3.mp4"]);
  });

  test("headId/tailId point to first and last clip", () => {
    const s = addClips(makeProject(), 3);
    const ordered = clipsInOrder(s.timeline);
    assert.equal(s.timeline.headId, ordered[0]!.id);
    assert.equal(s.timeline.tailId, ordered[2]!.id);
  });
});

// ── resolveClip ───────────────────────────────────────────────────────────────

describe("resolveClip", () => {
  test("resolves 1-based integer to first clip", () => {
    const s = addClips(makeProject(), 3);
    const ordered = clipsInOrder(s.timeline);
    assert.equal(resolveClip(s.timeline, "1")?.id, ordered[0]!.id);
    assert.equal(resolveClip(s.timeline, "2")?.id, ordered[1]!.id);
    assert.equal(resolveClip(s.timeline, "3")?.id, ordered[2]!.id);
  });

  test("resolves clip ID directly", () => {
    const s = addClips(makeProject(), 2);
    const ordered = clipsInOrder(s.timeline);
    const id = ordered[1]!.id;
    assert.equal(resolveClip(s.timeline, id)?.id, id);
  });

  test("returns undefined for out-of-range index", () => {
    const s = addClips(makeProject(), 2);
    assert.equal(resolveClip(s.timeline, "5"), undefined);
  });

  test("returns undefined for unknown ID", () => {
    const s = addClips(makeProject(), 2);
    assert.equal(resolveClip(s.timeline, "00000000-0000-0000-0000-000000000000"), undefined);
  });

  test('"0" returns undefined (not a valid 1-based index)', () => {
    const s = addClips(makeProject(), 2);
    assert.equal(resolveClip(s.timeline, "0"), undefined);
  });
});

// ── addSource ─────────────────────────────────────────────────────────────────

describe("addSource", () => {
  test("first clip becomes head and tail", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    assert.equal(s.timeline.headId, clip.id);
    assert.equal(s.timeline.tailId, clip.id);
    assert.equal(clip.prevId, null);
    assert.equal(clip.nextId, null);
  });

  test("second clip is linked after first", () => {
    const s = addClips(makeProject(), 2);
    const [a, b] = clipsInOrder(s.timeline);
    assert.equal(a!.nextId, b!.id);
    assert.equal(b!.prevId, a!.id);
    assert.equal(a!.prevId, null);
    assert.equal(b!.nextId, null);
    assert.equal(s.timeline.headId, a!.id);
    assert.equal(s.timeline.tailId, b!.id);
  });

  test("appending three clips produces correct chain", () => {
    const s = addClips(makeProject(), 3);
    const [a, b, c] = clipsInOrder(s.timeline);
    assert.equal(a!.nextId, b!.id);
    assert.equal(b!.prevId, a!.id);
    assert.equal(b!.nextId, c!.id);
    assert.equal(c!.prevId, b!.id);
  });

  test("sets inPoint=0 and outPoint=source duration", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    assert.equal(clip.inPoint, 0);
    assert.equal(clip.outPoint, 60);
  });

  test("state is immutable — original unchanged", () => {
    const base = makeProject();
    addClips(base, 2);
    assert.equal(base.timeline.headId, null);
  });
});

// ── trimClip ──────────────────────────────────────────────────────────────────

describe("trimClip", () => {
  test("sets new in/out points", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = trimClip(s, clip.id, { inPoint: 5, outPoint: 30 });
    assert.ok(r.ok);
    const updated = r.state.timeline.clips[clip.id]!;
    assert.equal(updated.inPoint, 5);
    assert.equal(updated.outPoint, 30);
  });

  test("preserves linked list pointers", () => {
    const s = addClips(makeProject(), 3);
    const [, b] = clipsInOrder(s.timeline);
    const r = trimClip(s, b!.id, { inPoint: 1, outPoint: 10 });
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.deepEqual(ids(r.state), ["clip1.mp4", "clip2.mp4", "clip3.mp4"]);
    assert.equal(ordered[1]!.inPoint, 1);
    assert.equal(ordered[1]!.outPoint, 10);
  });

  test("rejects inPoint >= outPoint", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = trimClip(s, clip.id, { inPoint: 30, outPoint: 30 });
    assert.ok(!r.ok);
    assert.match(r.error, /must be before/);
  });

  test("rejects outPoint beyond source duration", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = trimClip(s, clip.id, { outPoint: 999 });
    assert.ok(!r.ok);
    assert.match(r.error, /exceeds source duration/);
  });

  test("rejects negative inPoint", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = trimClip(s, clip.id, { inPoint: -1 });
    assert.ok(!r.ok);
    assert.match(r.error, /negative/);
  });

  test("returns error for unknown clip id", () => {
    const s = makeProject();
    const r = trimClip(s, "nonexistent", { inPoint: 0, outPoint: 10 });
    assert.ok(!r.ok);
    assert.match(r.error, /not found/);
  });
});

// ── removeClip ────────────────────────────────────────────────────────────────

describe("removeClip", () => {
  test("removing the only clip empties the timeline", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = removeClip(s, clip.id);
    assert.ok(r.ok);
    assert.equal(r.state.timeline.headId, null);
    assert.equal(r.state.timeline.tailId, null);
    assert.equal(Object.keys(r.state.timeline.clips).length, 0);
  });

  test("removing head updates headId and next.prevId", () => {
    const s = addClips(makeProject(), 3);
    const [a, b] = clipsInOrder(s.timeline);
    const r = removeClip(s, a!.id);
    assert.ok(r.ok);
    assert.equal(r.state.timeline.headId, b!.id);
    assert.equal(r.state.timeline.clips[b!.id]!.prevId, null);
    assert.deepEqual(ids(r.state), ["clip2.mp4", "clip3.mp4"]);
  });

  test("removing tail updates tailId and prev.nextId", () => {
    const s = addClips(makeProject(), 3);
    const [, b, c] = clipsInOrder(s.timeline);
    const r = removeClip(s, c!.id);
    assert.ok(r.ok);
    assert.equal(r.state.timeline.tailId, b!.id);
    assert.equal(r.state.timeline.clips[b!.id]!.nextId, null);
    assert.deepEqual(ids(r.state), ["clip1.mp4", "clip2.mp4"]);
  });

  test("removing middle clip rewires neighbours", () => {
    const s = addClips(makeProject(), 3);
    const [a, b, c] = clipsInOrder(s.timeline);
    const r = removeClip(s, b!.id);
    assert.ok(r.ok);
    assert.equal(r.state.timeline.clips[a!.id]!.nextId, c!.id);
    assert.equal(r.state.timeline.clips[c!.id]!.prevId, a!.id);
    assert.deepEqual(ids(r.state), ["clip1.mp4", "clip3.mp4"]);
  });

  test("returns error for unknown clip id", () => {
    const r = removeClip(makeProject(), "nope");
    assert.ok(!r.ok);
  });
});

// ── reorderClip ───────────────────────────────────────────────────────────────

describe("reorderClip", () => {
  test("move head to tail: [A,B,C] → [B,C,A]", () => {
    const s = addClips(makeProject(), 3);
    const [a] = clipsInOrder(s.timeline);
    const r = reorderClip(s, a!.id, 2);
    assert.ok(r.ok);
    assert.deepEqual(ids(r.state), ["clip2.mp4", "clip3.mp4", "clip1.mp4"]);
    assert.equal(r.state.timeline.tailId, r.state.timeline.clips[a!.id]!.id);
    assert.equal(r.state.timeline.clips[a!.id]!.nextId, null);
  });

  test("move tail to head: [A,B,C] → [C,A,B]", () => {
    const s = addClips(makeProject(), 3);
    const [,, c] = clipsInOrder(s.timeline);
    const r = reorderClip(s, c!.id, 0);
    assert.ok(r.ok);
    assert.deepEqual(ids(r.state), ["clip3.mp4", "clip1.mp4", "clip2.mp4"]);
    assert.equal(r.state.timeline.headId, c!.id);
    assert.equal(r.state.timeline.clips[c!.id]!.prevId, null);
  });

  test("move middle forward: [A,B,C,D] → [A,C,B,D]", () => {
    const s = addClips(makeProject(), 4);
    const [, b] = clipsInOrder(s.timeline);
    const r = reorderClip(s, b!.id, 2);
    assert.ok(r.ok);
    assert.deepEqual(ids(r.state), ["clip1.mp4", "clip3.mp4", "clip2.mp4", "clip4.mp4"]);
  });

  test("move middle backward: [A,B,C,D] → [A,C,B,D] (move C to idx 1)", () => {
    const s = addClips(makeProject(), 4);
    const [,, c] = clipsInOrder(s.timeline);
    const r = reorderClip(s, c!.id, 1);
    assert.ok(r.ok);
    assert.deepEqual(ids(r.state), ["clip1.mp4", "clip3.mp4", "clip2.mp4", "clip4.mp4"]);
  });

  test("same position is a no-op", () => {
    const s = addClips(makeProject(), 3);
    const [, b] = clipsInOrder(s.timeline);
    const r = reorderClip(s, b!.id, 1);
    assert.ok(r.ok);
    assert.deepEqual(ids(r.state), ["clip1.mp4", "clip2.mp4", "clip3.mp4"]);
  });

  test("linked list pointers are consistent after reorder", () => {
    const s = addClips(makeProject(), 4);
    const [a,, c] = clipsInOrder(s.timeline);
    const r = reorderClip(s, c!.id, 0);
    assert.ok(r.ok);
    // Verify every clip's prev/next is consistent with clipsInOrder
    const ordered = clipsInOrder(r.state.timeline);
    for (let i = 0; i < ordered.length; i++) {
      const clip = ordered[i]!;
      assert.equal(clip.prevId, i === 0 ? null : ordered[i - 1]!.id);
      assert.equal(clip.nextId, i === ordered.length - 1 ? null : ordered[i + 1]!.id);
    }
    assert.equal(r.state.timeline.headId, ordered[0]!.id);
    assert.equal(r.state.timeline.tailId, ordered[ordered.length - 1]!.id);
  });

  test("rejects out-of-range index", () => {
    const s = addClips(makeProject(), 2);
    const [a] = clipsInOrder(s.timeline);
    const r = reorderClip(s, a!.id, 5);
    assert.ok(!r.ok);
    assert.match(r.error, /out of range/);
  });

  test("rejects unknown clip id", () => {
    const s = addClips(makeProject(), 2);
    const r = reorderClip(s, "bad-id", 0);
    assert.ok(!r.ok);
    assert.match(r.error, /not found/);
  });
});

// ── renameClip ────────────────────────────────────────────────────────────────

describe("renameClip", () => {
  test("updates label", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = renameClip(s, clip.id, "My Clip");
    assert.ok(r.ok);
    assert.equal(r.state.timeline.clips[clip.id]!.label, "My Clip");
  });

  test("trims whitespace from label", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = renameClip(s, clip.id, "  trimmed  ");
    assert.ok(r.ok);
    assert.equal(r.state.timeline.clips[clip.id]!.label, "trimmed");
  });

  test("rejects empty label", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = renameClip(s, clip.id, "   ");
    assert.ok(!r.ok);
    assert.match(r.error, /empty/);
  });
});

// ── removeSource ──────────────────────────────────────────────────────────────

describe("removeSource", () => {
  test("removes source and its clips", () => {
    const s = addClips(makeProject(), 2);
    const sourceId = s.sources[0]!.id;
    const r = removeSource(s, sourceId);
    assert.ok(r.ok);
    assert.equal(r.state.sources.length, 1);
    assert.equal(clipsInOrder(r.state.timeline).length, 1);
    assert.deepEqual(ids(r.state), ["clip2.mp4"]);
  });

  test("headId/tailId updated when source clips are removed", () => {
    const s = addClips(makeProject(), 2);
    const sourceId = s.sources[0]!.id;
    const r = removeSource(s, sourceId);
    assert.ok(r.ok);
    const remaining = clipsInOrder(r.state.timeline);
    assert.equal(r.state.timeline.headId, remaining[0]!.id);
    assert.equal(r.state.timeline.tailId, remaining[0]!.id);
  });

  test("returns error for unknown sourceId", () => {
    const r = removeSource(makeProject(), "nope");
    assert.ok(!r.ok);
  });
});

// ── createProject ─────────────────────────────────────────────────────────────

describe("createProject", () => {
  test("creates empty linked list timeline", () => {
    const s = createProject("test");
    assert.equal(s.timeline.headId, null);
    assert.equal(s.timeline.tailId, null);
    assert.deepEqual(s.timeline.clips, {});
  });
});

// ── splitClip ─────────────────────────────────────────────────────────────────

describe("splitClip", () => {
  test("splits one clip into two with correct in/out points", () => {
    const s = addClips(makeProject(), 1); // 0–60s
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 30);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(ordered.length, 2);
    assert.equal(ordered[0]!.inPoint, 0);
    assert.equal(ordered[0]!.outPoint, 30);
    assert.equal(ordered[1]!.inPoint, 30);
    assert.equal(ordered[1]!.outPoint, 60);
  });

  test("both halves reference the same source", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 20);
    assert.ok(r.ok);
    const [first, second] = clipsInOrder(r.state.timeline);
    assert.equal(first!.sourceId, clip.sourceId);
    assert.equal(second!.sourceId, clip.sourceId);
  });

  test("first clip keeps original id", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 20);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(ordered[0]!.id, clip.id);
    assert.notEqual(ordered[1]!.id, clip.id);
  });

  test("linked list pointers are consistent after split", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 30);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(ordered[0]!.prevId, null);
    assert.equal(ordered[0]!.nextId, ordered[1]!.id);
    assert.equal(ordered[1]!.prevId, ordered[0]!.id);
    assert.equal(ordered[1]!.nextId, null);
    assert.equal(r.state.timeline.headId, ordered[0]!.id);
    assert.equal(r.state.timeline.tailId, ordered[1]!.id);
  });

  test("splitting middle clip in a 3-clip timeline wires all neighbours", () => {
    const s = addClips(makeProject(), 3);
    const [a, b, c] = clipsInOrder(s.timeline);
    const r = splitClip(s, b!.id, 30);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(ordered.length, 4);
    assert.deepEqual(ordered.map(cl => cl.label), ["clip1.mp4", "clip2.mp4", "clip2.mp4", "clip3.mp4"]);
    // Verify full chain
    for (let i = 0; i < ordered.length; i++) {
      assert.equal(ordered[i]!.prevId, i === 0 ? null : ordered[i - 1]!.id);
      assert.equal(ordered[i]!.nextId, i === ordered.length - 1 ? null : ordered[i + 1]!.id);
    }
    assert.equal(r.state.timeline.headId, a!.id);
    assert.equal(r.state.timeline.tailId, c!.id);
  });

  test("splitting the tail updates tailId to the new second clip", () => {
    const s = addClips(makeProject(), 2);
    const [, b] = clipsInOrder(s.timeline);
    const r = splitClip(s, b!.id, 30);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(r.state.timeline.tailId, ordered[ordered.length - 1]!.id);
    assert.notEqual(r.state.timeline.tailId, b!.id);
  });

  test("splitting the head does not change headId", () => {
    const s = addClips(makeProject(), 2);
    const [a] = clipsInOrder(s.timeline);
    const r = splitClip(s, a!.id, 30);
    assert.ok(r.ok);
    assert.equal(r.state.timeline.headId, a!.id);
  });

  test("rejects split point at or before inPoint", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 0);
    assert.ok(!r.ok);
    assert.match(r.error, /after clip in-point/);
  });

  test("rejects split point at or after outPoint", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 60);
    assert.ok(!r.ok);
    assert.match(r.error, /before clip out-point/);
  });

  test("rejects unknown clip id", () => {
    const r = splitClip(makeProject(), "nope", 10);
    assert.ok(!r.ok);
    assert.match(r.error, /not found/);
  });

  test("split clip can be further split", () => {
    const s = addClips(makeProject(), 1); // 0–60s
    const clip = clipsInOrder(s.timeline)[0]!;
    const r1 = splitClip(s, clip.id, 30); // → [0–30, 30–60]
    assert.ok(r1.ok);
    const second = clipsInOrder(r1.state.timeline)[1]!;
    const r2 = splitClip(r1.state, second.id, 45); // → [0–30, 30–45, 45–60]
    assert.ok(r2.ok);
    const ordered = clipsInOrder(r2.state.timeline);
    assert.equal(ordered.length, 3);
    assert.equal(ordered[0]!.outPoint, 30);
    assert.equal(ordered[1]!.inPoint, 30);
    assert.equal(ordered[1]!.outPoint, 45);
    assert.equal(ordered[2]!.inPoint, 45);
    assert.equal(ordered[2]!.outPoint, 60);
  });

  test("total source coverage is preserved after split", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const totalBefore = clip.outPoint - clip.inPoint;
    const r = splitClip(s, clip.id, 22);
    assert.ok(r.ok);
    const totalAfter = clipsInOrder(r.state.timeline)
      .reduce((sum, c) => sum + (c.outPoint - c.inPoint), 0);
    assert.equal(totalAfter, totalBefore);
  });

  test("rejects negative split point with clear message", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, -5);
    assert.ok(!r.ok);
    assert.match(r.error, /cannot be negative/);
  });

  // ── splitGroupId ────────────────────────────────────────────────────────────

  test("fresh clips have splitGroupId === null", () => {
    const s = addClips(makeProject(), 2);
    for (const clip of clipsInOrder(s.timeline)) {
      assert.equal(clip.splitGroupId, null);
    }
  });

  test("both halves share the same splitGroupId after first split", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 30);
    assert.ok(r.ok);
    const [first, second] = clipsInOrder(r.state.timeline);
    assert.notEqual(first!.splitGroupId, null);
    assert.equal(first!.splitGroupId, second!.splitGroupId);
  });

  test("splitting a split clip keeps all three in the same group", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r1 = splitClip(s, clip.id, 30);
    assert.ok(r1.ok);
    const second = clipsInOrder(r1.state.timeline)[1]!;
    const r2 = splitClip(r1.state, second.id, 45);
    assert.ok(r2.ok);
    const [a, b, c] = clipsInOrder(r2.state.timeline);
    assert.equal(a!.splitGroupId, b!.splitGroupId);
    assert.equal(b!.splitGroupId, c!.splitGroupId);
    assert.notEqual(a!.splitGroupId, null);
  });
});

// ── getClipDisplayRefs ────────────────────────────────────────────────────────

describe("getClipDisplayRefs", () => {
  test("standalone clips get plain integer refs", () => {
    const s = addClips(makeProject(), 3);
    const refs = getClipDisplayRefs(s.timeline);
    const values = clipsInOrder(s.timeline).map((c) => refs.get(c.id));
    assert.deepEqual(values, ["1", "2", "3"]);
  });

  test("split clips get letter suffixes sharing the same base index", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r = splitClip(s, clip.id, 30);
    assert.ok(r.ok);
    const refs = getClipDisplayRefs(r.state.timeline);
    const values = clipsInOrder(r.state.timeline).map((c) => refs.get(c.id));
    assert.deepEqual(values, ["1a", "1b"]);
  });

  test("splitting again yields a, b, c — not ba, bb", () => {
    const s = addClips(makeProject(), 1);
    const clip = clipsInOrder(s.timeline)[0]!;
    const r1 = splitClip(s, clip.id, 20);
    assert.ok(r1.ok);
    const second = clipsInOrder(r1.state.timeline)[1]!;
    const r2 = splitClip(r1.state, second.id, 40);
    assert.ok(r2.ok);
    const refs = getClipDisplayRefs(r2.state.timeline);
    const values = clipsInOrder(r2.state.timeline).map((c) => refs.get(c.id));
    assert.deepEqual(values, ["1a", "1b", "1c"]);
  });

  test("clips after a split group keep their original base index (no shift)", () => {
    // [A, B, C] → split B → [A, Ba, Bb, C]
    // A stays [1], Ba/Bb are [2a]/[2b], C stays [3]
    const s = addClips(makeProject(), 3);
    const [, b] = clipsInOrder(s.timeline);
    const r = splitClip(s, b!.id, 30);
    assert.ok(r.ok);
    const refs = getClipDisplayRefs(r.state.timeline);
    const values = clipsInOrder(r.state.timeline).map((c) => refs.get(c.id));
    assert.deepEqual(values, ["1", "2a", "2b", "3"]);
  });

  test("resolveClip handles split refs '2a' and '2b'", () => {
    const s = addClips(makeProject(), 3);
    const [, b] = clipsInOrder(s.timeline);
    const r = splitClip(s, b!.id, 30);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(resolveClip(r.state.timeline, "2a")?.id, ordered[1]!.id);
    assert.equal(resolveClip(r.state.timeline, "2b")?.id, ordered[2]!.id);
  });

  test("resolveClip '3' resolves to the clip displayed as [3] (not shifted to position 4)", () => {
    const s = addClips(makeProject(), 3);
    const [a, b, c] = clipsInOrder(s.timeline);
    const r = splitClip(s, b!.id, 30);
    assert.ok(r.ok);
    // C is now at position 4 in clipsInOrder but should still resolve as "3"
    assert.equal(resolveClip(r.state.timeline, "3")?.id, c!.id);
  });

  test("resolveClip plain integer '2' resolves to '2a' when clip 2 was split", () => {
    const s = addClips(makeProject(), 3);
    const [, b] = clipsInOrder(s.timeline);
    const r = splitClip(s, b!.id, 30);
    assert.ok(r.ok);
    const ordered = clipsInOrder(r.state.timeline);
    assert.equal(resolveClip(r.state.timeline, "2")?.id, ordered[1]!.id); // 2a
  });
});

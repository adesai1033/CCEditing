import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  clipsInOrder,
  resolveClip,
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

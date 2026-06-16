import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProject, saveProject, loadProject } from "../project/io.js";
import {
  applyPlan,
  createSession,
  redoSession,
  undoSession,
  type Operation,
} from "../project/session.js";
import { addSource } from "../project/mutations.js";
import { clipsInOrder } from "../project/types.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

function freshState(): ProjectState {
  return createProject("test");
}

function withOneClip(): ProjectState {
  const r = addSource(freshState(), makeMediaInfo({ fileName: "a.mp4" }));
  assert.ok(r.ok);
  return r.state;
}

function trim(clipId: string, inPoint: number, outPoint: number): Operation {
  return { type: "trim", clipId, inPoint, outPoint };
}

function del(clipId: string): Operation {
  return { type: "delete", clipId };
}

// ── createSession ─────────────────────────────────────────────────────────────

describe("createSession", () => {
  test("wraps state with empty undo/redo stacks", () => {
    const s = createSession(freshState());
    assert.deepEqual(s.undo, []);
    assert.deepEqual(s.redo, []);
  });
});

// ── applyPlan: single op ──────────────────────────────────────────────────────

describe("applyPlan (single op)", () => {
  test("on success pushes previous state to undo with given label", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const r = applyPlan(session, "trim clip [1]", [trim(clip.id, 0, 30)]);

    assert.ok(r.ok);
    assert.equal(r.session.undo.length, 1);
    assert.equal(r.session.undo[0]!.label, "trim clip [1]");
    assert.equal(r.session.undo[0]!.state, session.state);
    assert.equal(r.session.state.timeline.clips[clip.id]!.outPoint, 30);
  });

  test("on success clears the redo stack", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const r1 = applyPlan(session, "trim", [trim(clip.id, 0, 30)]);
    assert.ok(r1.ok);
    const undone = undoSession(r1.session);
    assert.ok(undone.ok);
    assert.equal(undone.session.redo.length, 1);

    const r2 = applyPlan(undone.session, "delete", [del(clip.id)]);
    assert.ok(r2.ok);
    assert.deepEqual(r2.session.redo, []);
  });

  test("on failure returns the mutation's error and does not push to undo", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const r = applyPlan(session, "trim", [trim(clip.id, 50, 30)]); // invalid

    assert.ok(!r.ok);
    assert.match(r.error, /must be before/);
    assert.equal(r.failedAt, 0);
    assert.equal(session.undo.length, 0);
  });
});

// ── applyPlan: multi-op ───────────────────────────────────────────────────────

describe("applyPlan (multi-op)", () => {
  test("multi-op plan succeeds with a single undo entry", () => {
    // Build a project with 3 clips, then in one plan: trim clip 1, delete clip 2
    let state = freshState();
    for (let i = 1; i <= 3; i++) {
      const r = addSource(state, makeMediaInfo({ fileName: `c${i}.mp4` }));
      assert.ok(r.ok);
      state = r.state;
    }
    const [a, b] = clipsInOrder(state.timeline);
    const session = createSession(state);

    const r = applyPlan(session, "agent: tighten the intro", [
      trim(a!.id, 0, 30),
      del(b!.id),
    ]);

    assert.ok(r.ok);
    assert.equal(r.session.undo.length, 1, "exactly one undo entry for the whole plan");
    assert.equal(r.session.undo[0]!.label, "agent: tighten the intro");
    // Both ops applied
    assert.equal(r.session.state.timeline.clips[a!.id]!.outPoint, 30);
    assert.equal(r.session.state.timeline.clips[b!.id], undefined);
    // Snapshot is the pre-plan state — undo rolls back ALL ops at once
    const undone = undoSession(r.session);
    assert.ok(undone.ok);
    assert.equal(undone.session.state.timeline.clips[a!.id]!.outPoint, 120);
    assert.ok(undone.session.state.timeline.clips[b!.id]);
  });

  test("failure at op #2 aborts the plan — no state change, no snapshot, failedAt === 1", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    // Op #1 is valid; op #2 is invalid (in >= out)
    const r = applyPlan(session, "agent: bad plan", [
      trim(clip.id, 0, 60),
      trim(clip.id, 50, 30),
    ]);

    assert.ok(!r.ok);
    assert.equal(r.failedAt, 1);
    assert.match(r.error, /must be before/);
    // The original session is untouched — no partial state lingering
    assert.equal(session.undo.length, 0);
    assert.equal(session.state.timeline.clips[clip.id]!.outPoint, 120);
  });

  test("multi-op plan label survives undo/redo round-trip", () => {
    let state = freshState();
    for (let i = 1; i <= 2; i++) {
      const r = addSource(state, makeMediaInfo({ fileName: `c${i}.mp4` }));
      assert.ok(r.ok);
      state = r.state;
    }
    const [a, b] = clipsInOrder(state.timeline);
    const session = createSession(state);

    const r = applyPlan(session, "trim both clips", [
      trim(a!.id, 0, 60),
      trim(b!.id, 0, 45),
    ]);
    assert.ok(r.ok);

    const undone = undoSession(r.session);
    assert.ok(undone.ok);
    assert.equal(undone.label, "trim both clips");

    const redone = redoSession(undone.session);
    assert.ok(redone.ok);
    assert.equal(redone.label, "trim both clips");
    assert.equal(redone.session.state.timeline.clips[a!.id]!.outPoint, 60);
    assert.equal(redone.session.state.timeline.clips[b!.id]!.outPoint, 45);
  });

  test("empty plan is a no-op — no snapshot pushed, redo preserved", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    // Populate redo stack first
    const a = applyPlan(session, "trim", [trim(clip.id, 0, 30)]);
    assert.ok(a.ok);
    const undone = undoSession(a.session);
    assert.ok(undone.ok);
    assert.equal(undone.session.redo.length, 1);

    const r = applyPlan(undone.session, "nothing", []);
    assert.ok(r.ok);
    // Session is unchanged — undo length same, redo NOT cleared
    assert.equal(r.session.undo.length, undone.session.undo.length);
    assert.equal(r.session.redo.length, undone.session.redo.length);
  });
});

// ── undoSession / redoSession ─────────────────────────────────────────────────

describe("undoSession", () => {
  test("returns nothing-to-undo on empty stack", () => {
    const r = undoSession(createSession(freshState()));
    assert.ok(!r.ok);
    assert.equal(r.reason, "nothing-to-undo");
  });

  test("restores the previous state and exposes the label", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const after = applyPlan(session, "trim clip [1]", [trim(clip.id, 0, 30)]);
    assert.ok(after.ok);

    const undone = undoSession(after.session);
    assert.ok(undone.ok);
    assert.equal(undone.label, "trim clip [1]");
    assert.equal(undone.session.state.timeline.clips[clip.id]!.outPoint, 120);
    assert.equal(undone.session.undo.length, 0);
    assert.equal(undone.session.redo.length, 1);
  });
});

describe("redoSession", () => {
  test("returns nothing-to-redo on empty stack", () => {
    const r = redoSession(createSession(freshState()));
    assert.ok(!r.ok);
    assert.equal(r.reason, "nothing-to-redo");
  });

  test("re-applies the most recent undo and labels it", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const after = applyPlan(session, "trim clip [1]", [trim(clip.id, 0, 30)]);
    assert.ok(after.ok);
    const undone = undoSession(after.session);
    assert.ok(undone.ok);

    const redone = redoSession(undone.session);
    assert.ok(redone.ok);
    assert.equal(redone.label, "trim clip [1]");
    assert.equal(redone.session.state.timeline.clips[clip.id]!.outPoint, 30);
    assert.equal(redone.session.undo.length, 1);
    assert.equal(redone.session.redo.length, 0);
  });
});

// ── Multi-step round-trips ────────────────────────────────────────────────────

describe("undo/redo round-trips", () => {
  test("three plans + three undos returns to the original state", () => {
    let session = createSession(withOneClip());
    const original = session.state;
    const clip = clipsInOrder(session.state.timeline)[0]!;

    for (const out of [60, 45, 30]) {
      const r = applyPlan(session, `trim → ${out}`, [trim(clip.id, 0, out)]);
      assert.ok(r.ok);
      session = r.session;
    }

    for (let i = 0; i < 3; i++) {
      const u = undoSession(session);
      assert.ok(u.ok);
      session = u.session;
    }

    assert.equal(session.state, original);
    assert.equal(session.undo.length, 0);
    assert.equal(session.redo.length, 3);
  });

  test("undo then mutate discards redo history", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const a = applyPlan(session, "trim → 60", [trim(clip.id, 0, 60)]);
    assert.ok(a.ok);

    const undone = undoSession(a.session);
    assert.ok(undone.ok);
    assert.equal(undone.session.redo.length, 1);

    const b = applyPlan(undone.session, "trim → 45", [trim(clip.id, 0, 45)]);
    assert.ok(b.ok);
    assert.deepEqual(b.session.redo, []);
    const r = redoSession(b.session);
    assert.ok(!r.ok);
  });
});

// ── Persistence round-trip ────────────────────────────────────────────────────

describe("io session persistence", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cutcli-session-io-"));
  });
  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("save+load round-trips state and stacks", async () => {
    const session0 = createSession(withOneClip());
    const clip = clipsInOrder(session0.state.timeline)[0]!;

    const r1 = applyPlan(session0, "trim → 60", [trim(clip.id, 0, 60)]);
    assert.ok(r1.ok);
    const r2 = applyPlan(r1.session, "trim → 30", [trim(clip.id, 0, 30)]);
    assert.ok(r2.ok);
    const undone = undoSession(r2.session);
    assert.ok(undone.ok);

    const filePath = join(dir, "roundtrip.cutcli.json");
    await saveProject(undone.session, filePath);
    const loaded = await loadProject(filePath);

    assert.equal(loaded.state.timeline.clips[clip.id]!.outPoint, 60);
    assert.equal(loaded.undo.length, 1);
    assert.equal(loaded.undo[0]!.label, "trim → 60");
    assert.equal(loaded.redo.length, 1);
    assert.equal(loaded.redo[0]!.label, "trim → 30");
  });

  test("loading a v1 file produces empty undo/redo stacks (backward compat)", async () => {
    const v1: ProjectState = withOneClip();
    const v1File = { ...v1, version: 1 };
    const filePath = join(dir, "legacy-v1.cutcli.json");
    writeFileSync(filePath, JSON.stringify(v1File, null, 2), "utf-8");

    const loaded = await loadProject(filePath);
    assert.deepEqual(loaded.undo, []);
    assert.deepEqual(loaded.redo, []);
    assert.equal(clipsInOrder(loaded.state.timeline).length, 1);
  });
});

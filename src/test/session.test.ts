import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProject, saveProject, loadProject } from "../project/io.js";
import {
  applyMutation,
  createSession,
  redoSession,
  undoSession,
} from "../project/session.js";
import { addSource, trimClip, removeClip } from "../project/mutations.js";
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

// ── createSession ─────────────────────────────────────────────────────────────

describe("createSession", () => {
  test("wraps state with empty undo/redo stacks", () => {
    const s = createSession(freshState());
    assert.deepEqual(s.undo, []);
    assert.deepEqual(s.redo, []);
  });
});

// ── applyMutation ─────────────────────────────────────────────────────────────

describe("applyMutation", () => {
  test("on success pushes previous state to undo with given label", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const r = applyMutation(session, "trim clip [1]", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 30 }),
    );

    assert.ok(r.ok);
    assert.equal(r.session.undo.length, 1);
    assert.equal(r.session.undo[0]!.label, "trim clip [1]");
    assert.equal(r.session.undo[0]!.state, session.state);
    assert.equal(r.session.state.timeline.clips[clip.id]!.outPoint, 30);
  });

  test("on success clears the redo stack", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    // Trim → undo → leaves a populated redo stack
    const r1 = applyMutation(session, "trim", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 30 }),
    );
    assert.ok(r1.ok);
    const undone = undoSession(r1.session);
    assert.ok(undone.ok);
    assert.equal(undone.session.redo.length, 1);

    // New mutation must wipe the redo stack
    const r2 = applyMutation(undone.session, "delete", (s) => removeClip(s, clip.id));
    assert.ok(r2.ok);
    assert.deepEqual(r2.session.redo, []);
  });

  test("on failure returns the mutation's error and does not push to undo", () => {
    const session = createSession(withOneClip());
    const clip = clipsInOrder(session.state.timeline)[0]!;

    const r = applyMutation(session, "trim", (s) =>
      trimClip(s, clip.id, { inPoint: 50, outPoint: 30 }), // invalid
    );

    assert.ok(!r.ok);
    assert.match(r.error, /must be before/);
    // Session is unchanged — the original is still usable
    assert.equal(session.undo.length, 0);
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

    const after = applyMutation(session, "trim clip [1]", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 30 }),
    );
    assert.ok(after.ok);

    const undone = undoSession(after.session);
    assert.ok(undone.ok);
    assert.equal(undone.label, "trim clip [1]");
    // Restored to the original 120s clip
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

    const after = applyMutation(session, "trim clip [1]", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 30 }),
    );
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
  test("three mutations + three undos returns to the original state", () => {
    let session = createSession(withOneClip());
    const original = session.state;
    const clip = clipsInOrder(session.state.timeline)[0]!;

    for (const out of [60, 45, 30]) {
      const r = applyMutation(session, `trim → ${out}`, (s) =>
        trimClip(s, clip.id, { inPoint: 0, outPoint: out }),
      );
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

    const a = applyMutation(session, "trim → 60", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 60 }),
    );
    assert.ok(a.ok);

    const undone = undoSession(a.session);
    assert.ok(undone.ok);
    assert.equal(undone.session.redo.length, 1);

    const b = applyMutation(undone.session, "trim → 45", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 45 }),
    );
    assert.ok(b.ok);
    assert.deepEqual(b.session.redo, []);
    // Now redo should be nothing-to-redo
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

    // One applied mutation and one un-done mutation → both stacks populated
    const r1 = applyMutation(session0, "trim → 60", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 60 }),
    );
    assert.ok(r1.ok);
    const r2 = applyMutation(r1.session, "trim → 30", (s) =>
      trimClip(s, clip.id, { inPoint: 0, outPoint: 30 }),
    );
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
    // Hand-write a minimal v1 file with the original flat shape (no undo/redo)
    const v1: ProjectState = withOneClip();
    const v1File = {
      ...v1,
      version: 1, // explicitly v1
    };
    const filePath = join(dir, "legacy-v1.cutcli.json");
    writeFileSync(filePath, JSON.stringify(v1File, null, 2), "utf-8");

    const loaded = await loadProject(filePath);
    assert.deepEqual(loaded.undo, []);
    assert.deepEqual(loaded.redo, []);
    // State content survives the load
    assert.equal(clipsInOrder(loaded.state.timeline).length, 1);
  });
});

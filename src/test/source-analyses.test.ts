import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProject, saveProject, loadProject } from "../project/io.js";
import { sourceFileFromMediaInfo } from "../project/types.js";
import { addSource } from "../project/mutations.js";
import { createSession, applyPlan } from "../project/session.js";
import type { ProjectState, SourceFile } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

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

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cutcli-analyses-io-"));
});
after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("sourceFileFromMediaInfo", () => {
  test("initializes analyses to an empty object", () => {
    const src = sourceFileFromMediaInfo(makeMediaInfo());
    assert.deepEqual(src.analyses, {});
  });
});

describe("v3 round-trip", () => {
  test("round-trips a fully populated analyses object", async () => {
    let state = createProject("test");
    const r = addSource(state, makeMediaInfo({ fileName: "a.mp4" }));
    assert.ok(r.ok);
    state = r.state;

    // Populate every sub-field of analyses
    const sourceId = state.sources[0]!.id;
    const populated: SourceFile = {
      ...state.sources[0]!,
      analyses: {
        twelveLabs: {
          indexId: "idx_abc",
          videoId: "vid_xyz",
          status: "indexed",
          indexedAt: "2026-06-15T12:00:00Z",
        },
        description: {
          text: "A scenic hike through forest, ending at a summit.",
          model: "gemini-2.5-flash",
          generatedAt: "2026-06-15T12:01:00Z",
        },
        scenes: {
          threshold: 0.4,
          boundaries: [0, 12.5, 33.2, 60.1],
          detectedAt: "2026-06-15T12:02:00Z",
        },
        moments: [
          {
            query: "river crossing",
            hits: [{ start: 25, end: 32, rank: 1 }],
            retrievedAt: "2026-06-15T12:03:00Z",
          },
        ],
      },
    };
    const stateWithAnalyses: ProjectState = {
      ...state,
      sources: [populated],
    };

    const filePath = join(dir, "v3-roundtrip.cutcli.json");
    await saveProject(createSession(stateWithAnalyses), filePath);
    const loaded = await loadProject(filePath);

    const src = loaded.state.sources.find((s) => s.id === sourceId);
    assert.ok(src);
    assert.deepEqual(src.analyses.twelveLabs, populated.analyses.twelveLabs);
    assert.deepEqual(src.analyses.description, populated.analyses.description);
    assert.deepEqual(src.analyses.scenes, populated.analyses.scenes);
    assert.deepEqual(src.analyses.moments, populated.analyses.moments);
  });

  test("undo/redo round-trip preserves analyses on the source", async () => {
    let state = createProject("test");
    const r = addSource(state, makeMediaInfo({ fileName: "b.mp4" }));
    assert.ok(r.ok);
    state = r.state;
    state = {
      ...state,
      sources: [
        {
          ...state.sources[0]!,
          analyses: {
            description: { text: "x", model: "y", generatedAt: "z" },
          },
        },
      ],
    };

    const session = createSession(state);
    const clip = state.timeline.clips[state.timeline.headId!]!;
    const after = applyPlan(session, "trim", [{ type: "trim", clipId: clip.id, inPoint: 0, outPoint: 30 }]);
    assert.ok(after.ok);

    const filePath = join(dir, "undo-analyses.cutcli.json");
    await saveProject(after.session, filePath);
    const loaded = await loadProject(filePath);

    // Analyses survive on both the live state AND the undo snapshot
    assert.equal(loaded.state.sources[0]!.analyses.description?.text, "x");
    assert.equal(loaded.undo[0]!.state.sources[0]!.analyses.description?.text, "x");
  });
});

describe("backward compat with v2 files (no analyses field)", () => {
  test("v2 file loads with analyses: {} defaulted for every source", async () => {
    // Build a v1-ish state, then strip the analyses field to simulate v2
    let state = createProject("test");
    const r = addSource(state, makeMediaInfo({ fileName: "legacy.mp4" }));
    assert.ok(r.ok);
    state = r.state;

    const v2Source = { ...state.sources[0]! };
    delete (v2Source as Partial<SourceFile>).analyses;

    const v2File = {
      ...state,
      version: 2,
      sources: [v2Source],
      undo: [],
      redo: [],
    };
    const filePath = join(dir, "legacy-v2.cutcli.json");
    writeFileSync(filePath, JSON.stringify(v2File, null, 2), "utf-8");

    const loaded = await loadProject(filePath);
    assert.deepEqual(loaded.state.sources[0]!.analyses, {});
  });

  test("v1 file (no version 1 → no analyses, no undo/redo) loads cleanly", async () => {
    let state = createProject("test");
    const r = addSource(state, makeMediaInfo({ fileName: "ancient.mp4" }));
    assert.ok(r.ok);
    state = r.state;

    const v1Source = { ...state.sources[0]! };
    delete (v1Source as Partial<SourceFile>).analyses;

    const v1File = { ...state, version: 1, sources: [v1Source] };
    const filePath = join(dir, "ancient-v1.cutcli.json");
    writeFileSync(filePath, JSON.stringify(v1File, null, 2), "utf-8");

    const loaded = await loadProject(filePath);
    assert.deepEqual(loaded.state.sources[0]!.analyses, {});
    assert.deepEqual(loaded.undo, []);
    assert.deepEqual(loaded.redo, []);
  });
});

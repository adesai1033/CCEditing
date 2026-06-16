import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ProjectState, SourceFile } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

import { queryTimeline } from "../agent/tools/query_timeline.js";
import { executeFindVisualMoment } from "../agent/tools/find_visual_moment.js";
import { executeDescribeClip } from "../agent/tools/describe_clip.js";
import { executeDetectScenes, parseSceneBoundaries } from "../agent/tools/detect_scenes.js";
import type { TwelveLabsBackend } from "../agent/backends/twelvelabs.js";
import type { GeminiBackend } from "../agent/backends/gemini.js";

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

function stateWithOneSource(): { state: ProjectState; source: SourceFile } {
  let state = createProject("test");
  const r = addSource(state, makeMediaInfo());
  assert.ok(r.ok);
  state = r.state;
  return { state, source: state.sources[0]! };
}

// ── query_timeline ────────────────────────────────────────────────────────────

describe("query_timeline", () => {
  test("returns empty list for empty timeline", async () => {
    const state = createProject("test");
    const r = await queryTimeline.execute(state, {});
    assert.ok(r.ok);
    assert.deepEqual(r.result.clips, []);
    assert.equal(r.result.totalDuration, 0);
  });

  test("returns clips with refs, UUIDs, and source descriptions", async () => {
    let { state, source } = stateWithOneSource();
    // Attach a cached description to the source
    state = {
      ...state,
      sources: [{
        ...source,
        analyses: {
          description: { text: "a hike", model: "gemini-2.5-flash", generatedAt: "2026-06-15" },
        },
      }],
    };

    const r = await queryTimeline.execute(state, {});
    assert.ok(r.ok);
    assert.equal(r.result.clips.length, 1);
    const c = r.result.clips[0]!;
    assert.equal(c.ref, "1");
    assert.ok(c.id.length > 0);
    assert.equal(c.sourceFileName, "a.mp4");
    assert.equal(c.sourceDescription, "a hike");
    assert.equal(c.duration, 120);
    assert.equal(r.result.totalDuration, 120);
  });

  test("exposes a schema matching Anthropic tool-use shape", () => {
    assert.equal(queryTimeline.schema.name, "query_timeline");
    assert.equal(queryTimeline.schema.input_schema.type, "object");
    assert.ok(queryTimeline.schema.description.length > 0);
  });
});

// ── find_visual_moment ────────────────────────────────────────────────────────

describe("find_visual_moment", () => {
  test("returns error for unknown sourceId", async () => {
    const { state } = stateWithOneSource();
    const r = await executeFindVisualMoment(state, { sourceId: "nope", query: "x" });
    assert.ok(!r.ok);
    assert.match(r.error, /not found/);
  });

  test("triggers indexing when source is not yet indexed", async () => {
    const { state, source } = stateWithOneSource();
    let indexedFile: string | null = null;
    let searched = false;
    const backend: TwelveLabsBackend = {
      indexVideo: async (filePath) => {
        indexedFile = filePath;
        return { indexId: "idx1", videoId: "vid1" };
      },
      searchMoments: async () => {
        searched = true;
        return [{ start: 5, end: 10, confidence: 0.9 }];
      },
    };

    const r = await executeFindVisualMoment(state, { sourceId: source.id, query: "x" }, backend);
    assert.ok(r.ok);
    assert.equal(indexedFile, source.filePath);
    assert.equal(searched, true);
    assert.deepEqual(r.result.hits, [{ start: 5, end: 10, confidence: 0.9 }]);
    // stateUpdate should contain both the index reference AND the moment cache
    const updatedSrc = r.stateUpdate!.sources[0]!;
    assert.equal(updatedSrc.analyses.twelveLabs?.indexId, "idx1");
    assert.equal(updatedSrc.analyses.twelveLabs?.videoId, "vid1");
    assert.equal(updatedSrc.analyses.moments?.[0]?.query, "x");
  });

  test("cache hit on second call with same query — no backend calls", async () => {
    // Pre-populate source with TwelveLabs index + cached moment
    let { state, source } = stateWithOneSource();
    state = {
      ...state,
      sources: [{
        ...source,
        analyses: {
          twelveLabs: { indexId: "idx1", videoId: "vid1", status: "indexed", indexedAt: "x" },
          moments: [{ query: "ball", hits: [{ start: 1, end: 2, confidence: 0.5 }], retrievedAt: "x" }],
        },
      }],
    };

    let backendCalled = false;
    const backend: TwelveLabsBackend = {
      indexVideo: async () => { backendCalled = true; throw new Error("should not be called"); },
      searchMoments: async () => { backendCalled = true; throw new Error("should not be called"); },
    };

    const r = await executeFindVisualMoment(state, { sourceId: source.id, query: "ball" }, backend);
    assert.ok(r.ok);
    assert.equal(backendCalled, false);
    assert.deepEqual(r.result.hits, [{ start: 1, end: 2, confidence: 0.5 }]);
    // No state update on a pure cache hit
    assert.equal(r.stateUpdate, undefined);
  });

  test("different query against already-indexed source: searches but skips index", async () => {
    let { state, source } = stateWithOneSource();
    state = {
      ...state,
      sources: [{
        ...source,
        analyses: {
          twelveLabs: { indexId: "idx1", videoId: "vid1", status: "indexed", indexedAt: "x" },
        },
      }],
    };

    let indexCalled = false;
    const backend: TwelveLabsBackend = {
      indexVideo: async () => { indexCalled = true; throw new Error("should not be called"); },
      searchMoments: async () => [{ start: 0, end: 1, confidence: 0.7 }],
    };

    const r = await executeFindVisualMoment(state, { sourceId: source.id, query: "tree" }, backend);
    assert.ok(r.ok);
    assert.equal(indexCalled, false);
    // New moment appended to cache
    const moments = r.stateUpdate!.sources[0]!.analyses.moments!;
    assert.equal(moments.length, 1);
    assert.equal(moments[0]!.query, "tree");
  });

  test("propagates indexing error", async () => {
    const { state, source } = stateWithOneSource();
    const backend: TwelveLabsBackend = {
      indexVideo: async () => { throw new Error("upload failed"); },
      searchMoments: async () => [],
    };
    const r = await executeFindVisualMoment(state, { sourceId: source.id, query: "x" }, backend);
    assert.ok(!r.ok);
    assert.match(r.error, /indexing failed/);
    assert.match(r.error, /upload failed/);
  });
});

// ── describe_clip ─────────────────────────────────────────────────────────────

describe("describe_clip", () => {
  test("returns error for unknown sourceId", async () => {
    const { state } = stateWithOneSource();
    const r = await executeDescribeClip(state, { sourceId: "nope" });
    assert.ok(!r.ok);
    assert.match(r.error, /not found/);
  });

  test("populates cache on first call", async () => {
    const { state, source } = stateWithOneSource();
    let calledFor: string | null = null;
    const backend: GeminiBackend = {
      describeVideo: async (filePath) => {
        calledFor = filePath;
        return "A two-minute clip showing a person walking through a forest.";
      },
    };

    const r = await executeDescribeClip(state, { sourceId: source.id }, backend);
    assert.ok(r.ok);
    assert.equal(calledFor, source.filePath);
    assert.equal(r.result.cached, false);
    assert.match(r.result.description, /forest/);
    assert.equal(r.stateUpdate!.sources[0]!.analyses.description?.text, r.result.description);
  });

  test("cache hit on second call — no backend call, cached === true", async () => {
    let { state, source } = stateWithOneSource();
    state = {
      ...state,
      sources: [{
        ...source,
        analyses: {
          description: { text: "stored", model: "gemini-2.5-flash", generatedAt: "x" },
        },
      }],
    };
    let called = false;
    const backend: GeminiBackend = {
      describeVideo: async () => { called = true; throw new Error("should not be called"); },
    };

    const r = await executeDescribeClip(state, { sourceId: source.id }, backend);
    assert.ok(r.ok);
    assert.equal(called, false);
    assert.equal(r.result.cached, true);
    assert.equal(r.result.description, "stored");
    assert.equal(r.stateUpdate, undefined);
  });

  test("propagates backend error", async () => {
    const { state, source } = stateWithOneSource();
    const backend: GeminiBackend = {
      describeVideo: async () => { throw new Error("rate limited"); },
    };
    const r = await executeDescribeClip(state, { sourceId: source.id }, backend);
    assert.ok(!r.ok);
    assert.match(r.error, /rate limited/);
  });
});

// ── detect_scenes ─────────────────────────────────────────────────────────────

describe("detect_scenes", () => {
  test("parseSceneBoundaries extracts pts_time values from showinfo stderr", () => {
    const stderr = `
      [Parsed_showinfo_1 @ 0x7f] n: 0 pts:0 pts_time:0.000000 duration:1 ...
      [Parsed_showinfo_1 @ 0x7f] n: 1 pts:120 pts_time:12.500000 duration:1 ...
      [Parsed_showinfo_1 @ 0x7f] n: 2 pts:300 pts_time:33.200000 duration:1 ...
      [Parsed_showinfo_1 @ 0x7f] n: 3 pts:601 pts_time:60.123456 duration:1 ...
    `;
    const boundaries = parseSceneBoundaries(stderr);
    assert.deepEqual(boundaries, [0, 12.5, 33.2, 60.123456]);
  });

  test("parseSceneBoundaries returns [] when no scene cuts detected", () => {
    assert.deepEqual(parseSceneBoundaries("[some output without pts_time]"), []);
  });

  test("returns error for unknown sourceId", async () => {
    const { state } = stateWithOneSource();
    const r = await executeDetectScenes(state, { sourceId: "nope" });
    assert.ok(!r.ok);
    assert.match(r.error, /not found/);
  });

  test("runs ffmpeg and caches the result on first call", async () => {
    const { state, source } = stateWithOneSource();
    let calledWith: { input: string; threshold: number } | null = null;
    const runner = async (input: string, threshold: number) => {
      calledWith = { input, threshold };
      return "[showinfo] pts_time:5.0 [showinfo] pts_time:25.0";
    };

    const r = await executeDetectScenes(state, { sourceId: source.id }, runner);
    assert.ok(r.ok);
    assert.equal(calledWith!.input, source.filePath);
    assert.equal(calledWith!.threshold, 0.4);
    assert.deepEqual(r.result.boundaries, [5, 25]);
    assert.equal(r.result.cached, false);
    assert.equal(r.stateUpdate!.sources[0]!.analyses.scenes?.threshold, 0.4);
    assert.deepEqual(r.stateUpdate!.sources[0]!.analyses.scenes?.boundaries, [5, 25]);
  });

  test("cache hit when threshold matches", async () => {
    let { state, source } = stateWithOneSource();
    state = {
      ...state,
      sources: [{
        ...source,
        analyses: {
          scenes: { threshold: 0.4, boundaries: [1, 2, 3], detectedAt: "x" },
        },
      }],
    };
    let called = false;
    const runner = async () => { called = true; throw new Error("should not be called"); };
    const r = await executeDetectScenes(state, { sourceId: source.id }, runner);
    assert.ok(r.ok);
    assert.equal(called, false);
    assert.equal(r.result.cached, true);
    assert.deepEqual(r.result.boundaries, [1, 2, 3]);
  });

  test("cache miss when threshold differs — re-runs ffmpeg", async () => {
    let { state, source } = stateWithOneSource();
    state = {
      ...state,
      sources: [{
        ...source,
        analyses: {
          scenes: { threshold: 0.4, boundaries: [1, 2, 3], detectedAt: "x" },
        },
      }],
    };
    let called = false;
    const runner = async () => {
      called = true;
      return "pts_time:10.0";
    };
    const r = await executeDetectScenes(state, { sourceId: source.id, threshold: 0.6 }, runner);
    assert.ok(r.ok);
    assert.equal(called, true);
    assert.deepEqual(r.result.boundaries, [10]);
    assert.equal(r.stateUpdate!.sources[0]!.analyses.scenes?.threshold, 0.6);
  });
});

// ── Tool schemas ──────────────────────────────────────────────────────────────

describe("tool schemas", () => {
  test("every tool exposes a name, description, and input_schema", async () => {
    const { findVisualMoment } = await import("../agent/tools/find_visual_moment.js");
    const { describeClip } = await import("../agent/tools/describe_clip.js");
    const { detectScenes } = await import("../agent/tools/detect_scenes.js");

    for (const tool of [queryTimeline, findVisualMoment, describeClip, detectScenes]) {
      assert.ok(tool.schema.name.length > 0);
      assert.ok(tool.schema.description.length > 30, `${tool.schema.name} description too short`);
      assert.equal(tool.schema.input_schema.type, "object");
    }
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ProjectState, SourceFile } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

import { executeDetectSilence, parseSilences } from "../agent/tools/detect_silence.js";

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

function stateWithOneSource(overrides: Partial<MediaInfo> = {}): { state: ProjectState; source: SourceFile } {
  let state = createProject("test");
  const r = addSource(state, makeMediaInfo(overrides));
  assert.ok(r.ok);
  state = r.state;
  return { state, source: state.sources[0]! };
}

// Real ffmpeg silencedetect stderr shape.
const STDERR = `
[silencedetect @ 0x600001] silence_start: 0
[silencedetect @ 0x600001] silence_end: 3.512 | silence_duration: 3.512
[silencedetect @ 0x600001] silence_start: 41.2
[silencedetect @ 0x600001] silence_end: 44.75 | silence_duration: 3.55
`;

function mockRunner(stderr: string) {
  const calls: Array<{ thresholdDb: number; minDuration: number }> = [];
  const runner = async (_input: string, thresholdDb: number, minDuration: number) => {
    calls.push({ thresholdDb, minDuration });
    return stderr;
  };
  return { runner, calls };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

describe("detect_silence — parsing", () => {
  test("parses silencedetect output into structured ranges", () => {
    assert.deepEqual(parseSilences(STDERR, 120), [
      { start: 0, end: 3.512, duration: 3.512 },
      { start: 41.2, end: 44.75, duration: 3.55 },
    ]);
  });

  test("a silence still open at EOF is closed at the source duration", () => {
    // Trailing dead air is exactly what "cut the silence at the end" means —
    // dropping the unterminated range makes the tool useless for that request.
    const stderr = `
[silencedetect @ 0x1] silence_start: 100.5
`;
    assert.deepEqual(parseSilences(stderr, 120), [
      { start: 100.5, end: 120, duration: 19.5 },
    ]);
  });

  test("empty output yields no ranges", () => {
    assert.deepEqual(parseSilences("", 120), []);
  });

  test("malformed output does not throw", () => {
    assert.doesNotThrow(() => parseSilences("silence_start: banana\nnonsense\n", 120));
  });

  test("a negative start is clamped to zero", () => {
    const stderr = "silence_start: -0.001\nsilence_end: 2 | silence_duration: 2\n";
    assert.deepEqual(parseSilences(stderr, 120), [{ start: 0, end: 2, duration: 2 }]);
  });

  test("a zero-length range is dropped", () => {
    const stderr = "silence_start: 5\nsilence_end: 5 | silence_duration: 0\n";
    assert.deepEqual(parseSilences(stderr, 120), []);
  });
});

// ── Execution + cache ─────────────────────────────────────────────────────────

describe("detect_silence — execute", () => {
  test("returns ranges and caches them via stateUpdate", async () => {
    const { state, source } = stateWithOneSource();
    const { runner } = mockRunner(STDERR);

    const r = await executeDetectSilence(state, { sourceId: source.id }, runner);

    assert.ok(r.ok);
    assert.equal(r.result.silences.length, 2);
    assert.equal(r.result.cached, false);
    assert.equal(r.result.thresholdDb, -35, "documented default");
    assert.equal(r.result.minDuration, 0.5, "documented default");
    assert.equal(r.stateUpdate!.sources[0]!.analyses.silences!.length, 1);
  });

  test("cache hit on identical params does not re-run ffmpeg", async () => {
    const { state, source } = stateWithOneSource();
    const first = await executeDetectSilence(state, { sourceId: source.id }, mockRunner(STDERR).runner);
    assert.ok(first.ok);

    const { runner, calls } = mockRunner(STDERR);
    const second = await executeDetectSilence(first.stateUpdate!, { sourceId: source.id }, runner);

    assert.ok(second.ok);
    assert.equal(calls.length, 0);
    assert.equal(second.result.cached, true);
  });

  test("different thresholdDb does NOT collide with a cached result", async () => {
    const { state, source } = stateWithOneSource();
    const first = await executeDetectSilence(state, { sourceId: source.id, thresholdDb: -35 }, mockRunner(STDERR).runner);
    assert.ok(first.ok);

    const other = "silence_start: 10\nsilence_end: 12 | silence_duration: 2\n";
    const { runner, calls } = mockRunner(other);
    const second = await executeDetectSilence(first.stateUpdate!, { sourceId: source.id, thresholdDb: -50 }, runner);

    assert.ok(second.ok);
    assert.equal(calls.length, 1, "a -35dB result must not answer a -50dB request");
    assert.equal(second.result.cached, false);
    assert.deepEqual(second.result.silences, [{ start: 10, end: 12, duration: 2 }]);
    // Both entries coexist.
    assert.equal(second.stateUpdate!.sources[0]!.analyses.silences!.length, 2);
  });

  test("different minDuration does NOT collide with a cached result", async () => {
    const { state, source } = stateWithOneSource();
    const first = await executeDetectSilence(state, { sourceId: source.id, minDuration: 0.5 }, mockRunner(STDERR).runner);
    assert.ok(first.ok);

    const { runner, calls } = mockRunner(STDERR);
    const second = await executeDetectSilence(first.stateUpdate!, { sourceId: source.id, minDuration: 2 }, runner);

    assert.ok(second.ok);
    assert.equal(calls.length, 1);
    assert.equal(second.result.cached, false);
  });

  test("params are passed through to ffmpeg", async () => {
    const { state, source } = stateWithOneSource();
    const { runner, calls } = mockRunner(STDERR);
    await executeDetectSilence(state, { sourceId: source.id, thresholdDb: -50, minDuration: 1.5 }, runner);
    assert.deepEqual(calls, [{ thresholdDb: -50, minDuration: 1.5 }]);
  });

  test("no audio track returns an empty result, no throw, no ffmpeg", async () => {
    const { state, source } = stateWithOneSource({ audioCodec: null });
    const { runner, calls } = mockRunner(STDERR);

    const r = await executeDetectSilence(state, { sourceId: source.id }, runner);

    assert.ok(r.ok);
    assert.equal(r.result.hasAudio, false);
    assert.deepEqual(r.result.silences, []);
    assert.equal(calls.length, 0);
    assert.match(r.result.note ?? "", /no audio track/);
  });

  test("finding nothing tells the agent how to loosen the search", async () => {
    const { state, source } = stateWithOneSource();
    const r = await executeDetectSilence(state, { sourceId: source.id }, mockRunner("").runner);
    assert.ok(r.ok);
    assert.deepEqual(r.result.silences, []);
    assert.match(r.result.note ?? "", /loosen the threshold/);
  });

  test("ffmpeg failure is a clean error, not a crash", async () => {
    const { state, source } = stateWithOneSource();
    const runner = async () => { throw new Error("ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html"); };
    const r = await executeDetectSilence(state, { sourceId: source.id }, runner);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /ffmpeg not found/);
  });

  test("unknown sourceId is an error", async () => {
    const { state } = stateWithOneSource();
    const r = await executeDetectSilence(state, { sourceId: "nope" }, mockRunner(STDERR).runner);
    assert.equal(r.ok, false);
  });

  test("nonsensical params are rejected before spawning ffmpeg", async () => {
    const { state, source } = stateWithOneSource();
    const { runner, calls } = mockRunner(STDERR);

    const a = await executeDetectSilence(state, { sourceId: source.id, minDuration: 0 }, runner);
    assert.equal(a.ok, false);

    // A positive dB is almost certainly a sign error by the caller.
    const b = await executeDetectSilence(state, { sourceId: source.id, thresholdDb: 35 }, runner);
    assert.equal(b.ok, false);

    assert.equal(calls.length, 0);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ProjectState, SourceFile, TranscriptSegment } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

import {
  executeTranscribeAudio,
  selectWindow,
  selectQuery,
  MAX_SEGMENTS,
} from "../agent/tools/transcribe_audio.js";
import {
  transcribe,
  planChunks,
  stitchChunk,
  tightenWithWords,
  CHUNK_SECONDS,
  type TranscriptionBackend,
  type TranscriptionDeps,
} from "../agent/backends/transcription.js";

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

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 3, text: "Hey everyone, welcome back." },
  { start: 3, end: 7, text: "Today we're talking about the new pricing." },
  { start: 7, end: 11, text: "The price is forty nine dollars a month." },
  { start: 11, end: 15, text: "That includes everything in the pro tier." },
  { start: 15, end: 20, text: "Let me know what you think in the comments." },
];

/** A backend that records whether it was called. */
function mockBackend(result?: { segments: TranscriptSegment[]; duration: number; hasAudio: boolean }) {
  const calls: string[] = [];
  const backend: TranscriptionBackend = {
    transcribe: async (filePath: string) => {
      calls.push(filePath);
      return result ?? { segments: SEGMENTS, duration: 20, hasAudio: true };
    },
  };
  return { backend, calls };
}

/** Seed a state whose source already has a cached transcript. */
function withCachedTranscript(segments: TranscriptSegment[] = SEGMENTS, hasAudio = true): ProjectState {
  const { state, source } = stateWithOneSource();
  return {
    ...state,
    sources: [{
      ...source,
      analyses: {
        ...source.analyses,
        transcript: {
          segments,
          duration: 20,
          hasAudio,
          model: "test-model",
          transcribedAt: "2026-07-16T00:00:00.000Z",
        },
      },
    }],
  };
}

// ── Cache behaviour ───────────────────────────────────────────────────────────

describe("transcribe_audio — cache", () => {
  test("cache miss transcribes, writes stateUpdate, returns a slice", async () => {
    const { state, source } = stateWithOneSource();
    const { backend, calls } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: source.id, query: "price" }, backend);

    assert.ok(r.ok);
    assert.equal(calls.length, 1);
    assert.equal(r.result.cached, false);

    // Full transcript cached, even though only a slice was returned.
    const cached = r.stateUpdate!.sources[0]!.analyses.transcript!;
    assert.equal(cached.segments.length, SEGMENTS.length);
    assert.ok(r.result.segments.length < SEGMENTS.length);
  });

  test("cache hit does not call the backend", async () => {
    const state = withCachedTranscript();
    const { backend, calls } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, query: "price" }, backend);

    assert.ok(r.ok);
    assert.equal(calls.length, 0, "backend must not be called on a cache hit");
    assert.equal(r.result.cached, true);
    assert.equal(r.stateUpdate, undefined);
  });

  test("force: true re-transcribes despite the cache", async () => {
    const state = withCachedTranscript();
    const { backend, calls } = mockBackend();

    const r = await executeTranscribeAudio(
      state,
      { sourceId: state.sources[0]!.id, query: "price", force: true },
      backend,
    );

    assert.ok(r.ok);
    assert.equal(calls.length, 1, "force must bypass the cache");
    assert.equal(r.result.cached, false);
    assert.ok(r.stateUpdate);
  });

  test("unknown sourceId is an error", async () => {
    const { state } = stateWithOneSource();
    const { backend } = mockBackend();
    const r = await executeTranscribeAudio(state, { sourceId: "nope" }, backend);
    assert.equal(r.ok, false);
  });
});

// ── Window mode ───────────────────────────────────────────────────────────────

describe("transcribe_audio — window mode", () => {
  test("returns only segments overlapping the window", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, start: 7, end: 11 }, backend);

    assert.ok(r.ok);
    assert.deepEqual(r.result.segments.map((s) => s.start), [7]);
  });

  test("a segment straddling the boundary is INCLUDED, not dropped", () => {
    // Documented choice: partial overlap counts. Hiding the segment that spans
    // the boundary is how a cut lands mid-word.
    const straddling = selectWindow(SEGMENTS, 5, 8);
    assert.deepEqual(straddling.map((s) => s.start), [3, 7]);
  });

  test("window with only start runs to the end", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();
    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, start: 15 }, backend);
    assert.ok(r.ok);
    assert.deepEqual(r.result.segments.map((s) => s.start), [15]);
  });

  test("end <= start is an error", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();
    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, start: 10, end: 5 }, backend);
    assert.equal(r.ok, false);
  });
});

// ── Query mode ────────────────────────────────────────────────────────────────

describe("transcribe_audio — query mode", () => {
  test("returns matching segments plus surrounding context", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, query: "forty nine" }, backend);

    assert.ok(r.ok);
    // The match is at 7; context pulls in 3 and 11.
    assert.deepEqual(r.result.segments.map((s) => s.start), [3, 7, 11]);
  });

  test("is case-insensitive", () => {
    const hits = selectQuery(SEGMENTS, "PRICING");
    assert.ok(hits.some((s) => s.text.includes("pricing")));
  });

  test("overlapping context windows do not duplicate segments", () => {
    // "the" matches nearly every segment; each must appear at most once.
    const hits = selectQuery(SEGMENTS, "the");
    const starts = hits.map((s) => s.start);
    assert.deepEqual(starts, [...new Set(starts)]);
  });

  test("non-matching query returns empty with a note, not an error", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, query: "zebra" }, backend);

    assert.ok(r.ok, "a miss is a normal outcome");
    assert.deepEqual(r.result.segments, []);
    assert.match(r.result.note ?? "", /No segment matched/);
  });
});

// ── Context discipline ────────────────────────────────────────────────────────

describe("transcribe_audio — context discipline", () => {
  test("no window and no query returns an overview, NOT the full transcript", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id }, backend);

    assert.ok(r.ok);
    assert.ok(
      r.result.segments.length < SEGMENTS.length,
      "an unnarrowed call must never dump every segment",
    );
    assert.equal(r.result.totalSegments, SEGMENTS.length, "but it should say how many exist");
    assert.equal(r.result.truncated, true);
    assert.match(r.result.note ?? "", /Narrow with/);
  });

  test("a transcript shorter than the sample is returned whole, with no narrow-it note", async () => {
    // Caught by a real Gemini run: a 1-segment transcript reported "a
    // 3-segment sample of 1 total" and told the agent to narrow — nothing had
    // been withheld, so that only buys a wasted second call.
    const state = withCachedTranscript([{ start: 0, end: 2.1, text: "Dracarys." }]);
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id }, backend);

    assert.ok(r.ok);
    assert.equal(r.result.segments.length, 1);
    assert.equal(r.result.truncated, false);
    assert.equal(r.result.note, undefined, "nothing was withheld, so do not tell the agent to narrow");
  });

  test("an over-large match is capped and flagged truncated", async () => {
    const many: TranscriptSegment[] = Array.from({ length: 100 }, (_, i) => ({
      start: i, end: i + 1, text: `line ${i} with the word target`,
    }));
    const state = withCachedTranscript(many);
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, query: "target" }, backend);

    assert.ok(r.ok);
    assert.equal(r.result.segments.length, MAX_SEGMENTS);
    assert.equal(r.result.truncated, true);
    assert.equal(r.result.totalSegments, 100);
    assert.match(r.result.note ?? "", /Truncated/);
  });

  test("a small match is not flagged truncated", async () => {
    const state = withCachedTranscript();
    const { backend } = mockBackend();
    const r = await executeTranscribeAudio(state, { sourceId: state.sources[0]!.id, start: 7, end: 11 }, backend);
    assert.ok(r.ok);
    assert.equal(r.result.truncated, false);
  });
});

// ── No audio ──────────────────────────────────────────────────────────────────

describe("transcribe_audio — no audio track", () => {
  test("silent source returns a clean non-error result without calling the backend", async () => {
    const { state, source } = stateWithOneSource({ audioCodec: null });
    const { backend, calls } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: source.id, query: "anything" }, backend);

    assert.ok(r.ok, "no audio is a normal outcome, not an error");
    assert.equal(r.result.hasAudio, false);
    assert.deepEqual(r.result.segments, []);
    assert.match(r.result.note ?? "", /no audio track/);
    assert.equal(calls.length, 0, "must not pay for transcription of a silent source");
  });

  test("the no-audio verdict is cached so it is not rediscovered every turn", async () => {
    const { state, source } = stateWithOneSource({ audioCodec: null });
    const { backend } = mockBackend();

    const r = await executeTranscribeAudio(state, { sourceId: source.id }, backend);

    assert.ok(r.ok);
    assert.equal(r.stateUpdate!.sources[0]!.analyses.transcript!.hasAudio, false);
  });
});

// ── Chunk stitching (highest-value test in the file) ──────────────────────────

describe("transcription backend — chunking", () => {
  test("planChunks covers the whole duration with no gap or overlap", () => {
    const chunks = planChunks(1500, 600);
    assert.deepEqual(chunks.map((c) => [c.start, c.duration]), [[0, 600], [600, 600], [1200, 300]]);
    const covered = chunks.reduce((n, c) => n + c.duration, 0);
    assert.equal(covered, 1500);
  });

  test("a short source is still one chunk (seam logic is never bypassed)", () => {
    assert.equal(planChunks(30, 600).length, 1);
  });

  test("stitchChunk offsets chunk-relative times onto the source timeline", () => {
    const out = stitchChunk({ index: 1, start: 600, duration: 600 }, [
      { start: 0, end: 4, text: "first line of the second chunk" },
      { start: 4, end: 9, text: "second line" },
    ]);
    assert.deepEqual(out, [
      { start: 600, end: 604, text: "first line of the second chunk" },
      { start: 604, end: 609, text: "second line" },
    ]);
  });

  test("stitchChunk drops hallucinated segments past the chunk's own length", () => {
    const out = stitchChunk({ index: 0, start: 0, duration: 10 }, [
      { start: 0, end: 5, text: "real" },
      { start: 50, end: 60, text: "invented past the end of the chunk" },
    ]);
    assert.deepEqual(out.map((s) => s.text), ["real"]);
  });

  test("timestamps are continuous and monotonic ACROSS the chunk seam", async () => {
    // Every chunk's backend returns times relative to itself, starting at 0 —
    // exactly the shape that corrupts cut points if the offset is not added
    // back. 25 minutes => 3 chunks at CHUNK_SECONDS=600.
    const duration = 1500;
    const deps: TranscriptionDeps = {
      hasAudioTrack: async () => true,
      extractAudio: async () => {},
      transcribeChunk: async () => [
        { start: 0, end: 100, text: "chunk-relative first" },
        { start: 100, end: 200, text: "chunk-relative second" },
      ],
    };

    const r = await transcribe("/fake/long.mp4", duration, deps);

    assert.equal(r.hasAudio, true);
    assert.equal(r.segments.length, 6, "3 chunks x 2 segments");

    // The seam: chunk 1's segments must start at 600, not reset to 0.
    assert.deepEqual(
      r.segments.map((s) => s.start),
      [0, 100, 600, 700, 1200, 1300],
      "chunk offsets must be added back onto the source timeline",
    );

    for (let i = 1; i < r.segments.length; i++) {
      assert.ok(
        r.segments[i]!.start >= r.segments[i - 1]!.start,
        `timestamps must be monotonic across the seam (index ${i})`,
      );
    }
  });

  test("the final chunk is clamped to the source duration, not the full chunk length", async () => {
    const deps: TranscriptionDeps = {
      hasAudioTrack: async () => true,
      extractAudio: async () => {},
      transcribeChunk: async () => [{ start: 0, end: 600, text: "runs to the end of its chunk" }],
    };
    // 700s => chunk 0 is full (600), chunk 1 is only 100s long.
    const r = await transcribe("/fake/x.mp4", 700, deps);
    assert.equal(r.segments.at(-1)!.end, 700, "must not report audio past the source's end");
  });

  test("each chunk is extracted for its own window", async () => {
    const windows: Array<[number, number]> = [];
    const deps: TranscriptionDeps = {
      hasAudioTrack: async () => true,
      extractAudio: async (_src, _out, start, duration) => { windows.push([start, duration]); },
      transcribeChunk: async () => [],
    };
    await transcribe("/fake/x.mp4", 1500, deps);
    assert.deepEqual(windows, [[0, 600], [600, 600], [1200, 300]]);
  });

  test("no audio track short-circuits before any extraction", async () => {
    let extracted = false;
    const deps: TranscriptionDeps = {
      hasAudioTrack: async () => false,
      extractAudio: async () => { extracted = true; },
      transcribeChunk: async () => [],
    };
    const r = await transcribe("/fake/silent.mp4", 120, deps);
    assert.deepEqual(r, { segments: [], duration: 0, hasAudio: false });
    assert.equal(extracted, false);
  });

  test("CHUNK_SECONDS is the documented default", () => {
    assert.equal(planChunks(CHUNK_SECONDS + 1).length, 2);
  });
});

// ── Word-level tightening (Whisper) ───────────────────────────────────────────
//
// Whisper's segment timestamps are decoder-driven and drift; its word
// timestamps are DTW-aligned. Tightening is what buys the accuracy that
// motivated moving off an LLM for this in the first place.

describe("transcription backend — word tightening", () => {
  test("segment boundaries snap to the span of their words", () => {
    const out = tightenWithWords(
      [{ start: 0, end: 5, text: "Hello there" }],
      [
        { word: "Hello", start: 0.8, end: 1.2 },
        { word: "there", start: 1.3, end: 1.9 },
      ],
    );
    // The decoder said 0–5; the audio says 0.8–1.9.
    assert.deepEqual(out, [{ start: 0.8, end: 1.9, text: "Hello there" }]);
  });

  test("words are assigned to the segment that contains them", () => {
    const out = tightenWithWords(
      [
        { start: 0, end: 3, text: "first line" },
        { start: 3, end: 6, text: "second line" },
      ],
      [
        { word: "first", start: 0.5, end: 0.9 },
        { word: "line", start: 1.0, end: 1.4 },
        { word: "second", start: 3.6, end: 4.0 },
        { word: "line", start: 4.1, end: 4.8 },
      ],
    );
    assert.deepEqual(out, [
      { start: 0.5, end: 1.4, text: "first line" },
      { start: 3.6, end: 4.8, text: "second line" },
    ]);
  });

  test("a segment whose words cannot be located is left intact, not dropped", () => {
    // A loose boundary is a far better failure than a missing line.
    const segs = [{ start: 10, end: 12, text: "orphaned" }];
    assert.deepEqual(tightenWithWords(segs, [{ word: "elsewhere", start: 50, end: 51 }]), segs);
  });

  test("no words at all is a no-op", () => {
    const segs = [{ start: 0, end: 5, text: "Hello" }];
    assert.deepEqual(tightenWithWords(segs, []), segs);
  });

  test("tightening never widens a segment", () => {
    const segs = [{ start: 1, end: 4, text: "inside" }];
    const out = tightenWithWords(segs, [{ word: "inside", start: 1.5, end: 3.5 }]);
    assert.ok(out[0]!.start >= segs[0]!.start);
    assert.ok(out[0]!.end <= segs[0]!.end);
  });

  test("tightened segments survive chunk stitching with the offset applied", async () => {
    // The two mechanisms compose: word-accurate boundaries, then offset onto
    // the source timeline.
    const deps: TranscriptionDeps = {
      hasAudioTrack: async () => true,
      extractAudio: async () => {},
      transcribeChunk: async () => [{ start: 0.8, end: 1.9, text: "tightened" }],
    };
    const r = await transcribe("/fake/x.mp4", 1200, deps);
    assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[0.8, 1.9], [600.8, 601.9]]);
  });
});

describe("transcription backend — timestamp hygiene", () => {
  test("float32 noise from the API is rounded to milliseconds", () => {
    // Whisper really returns values like 1.0800000429153442; storing that
    // verbatim would litter the project file.
    const out = stitchChunk({ index: 0, start: 0, duration: 600 }, [
      { start: 0, end: 1.0800000429153442, text: "Dracarys!" },
    ]);
    assert.deepEqual(out, [{ start: 0, end: 1.08, text: "Dracarys!" }]);
  });

  test("rounding survives the chunk offset", () => {
    const out = stitchChunk({ index: 1, start: 600, duration: 600 }, [
      { start: 0.0000001, end: 1.0800000429153442, text: "x" },
    ]);
    assert.deepEqual(out, [{ start: 600, end: 601.08, text: "x" }]);
  });
});

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import {
  parsePreviewArgs,
  segmentsForScope,
  scratchStateForPlan,
  previewStateScope,
} from "../repl/commands/preview.js";
import {
  buildPreviewTrimArgs,
  renderPreviewFromSegments,
  openInPlayer,
  playInTerminal,
  TIMG_INSTALL_HINT,
  PREVIEW_SETTINGS,
  type FfmpegRunner,
  type PreviewSegment,
} from "../engine/preview.js";
import { EXPORT_ENCODE, buildTrimArgs } from "../engine/ffmpeg.js";
import { applyPlan, applyOperations, createSession, type Operation } from "../project/session.js";
import { runAgent } from "../agent/loop.js";
import type { ChatProvider, ChatResponse } from "../agent/providers/types.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import { clipsInOrder } from "../project/types.js";
import type { ProjectState } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let workRoot: string;

before(() => { workRoot = mkdtempSync(join(tmpdir(), "cutcli-preview-test-")); });
after(() => { try { rmSync(workRoot, { recursive: true, force: true }); } catch {} });

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

function makeState(n = 1): ProjectState {
  let state = createProject("test");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({
      filePath: `/fake/clip${i + 1}.mp4`, fileName: `clip${i + 1}.mp4`, duration: 120,
    }));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

// A mock FFmpeg runner: records args, creates the output file (last arg) so
// cache-existence checks behave, and emits one progress tick.
function mockFfmpeg(behavior: { abortOnCall?: number; failOnCall?: number } = {}) {
  const calls: string[][] = [];
  const runner: FfmpegRunner = async (args, opts) => {
    calls.push(args);
    const out = args[args.length - 1]!;
    if (calls.length === behavior.abortOnCall) {
      await writeFile(out, "partial");        // simulate a partially-written file
      return { ok: false, code: "ABORTED", error: "cancelled" };
    }
    if (calls.length === behavior.failOnCall) {
      return { ok: false, code: "FFMPEG_FAILED", error: "boom" };
    }
    if (opts?.signal?.aborted) return { ok: false, code: "ABORTED", error: "cancelled" };
    await writeFile(out, "rendered");
    opts?.onOutTime?.(1);
    return { ok: true };
  };
  return { runner, calls };
}

// Real dummy source files (the renderer stats sources for its cache key).
function makeSources(dir: string, names: string[]): string[] {
  return names.map((n) => {
    const p = join(dir, n);
    writeFileSync(p, `dummy-${n}`);
    return p;
  });
}

// ── Scratch plan application (decision 1 — THE invariant) ─────────────────────

describe("scratchStateForPlan", () => {
  test("produces the post-plan state while the session and undo stack stay untouched", () => {
    const state = makeState();
    const session = createSession(state);
    const clipId = state.timeline.headId!;
    const ops: Operation[] = [
      { type: "trim", clipId, inPoint: 4, outPoint: 34 },
      { type: "split", clipId, splitPoint: 20 },
    ];

    const sessionBefore = JSON.stringify(session);
    const scratch = scratchStateForPlan(session.state, ops);

    assert.ok(scratch.ok);
    assert.equal(clipsInOrder(scratch.state.timeline).length, 2, "the scratch state reflects the plan");
    assert.equal(clipsInOrder(scratch.state.timeline)[0]!.inPoint, 4);
    // The core guard: nothing real changed.
    assert.equal(JSON.stringify(session), sessionBefore, "session must be byte-identical after a preview");
    assert.equal(session.undo.length, 0, "no undo entry from a preview");
    assert.equal(session.redo.length, 0);
    assert.equal(clipsInOrder(session.state.timeline).length, 1, "real timeline untouched");
  });

  test("matches real applyPlan output for the same operations (shared logic, no divergence)", () => {
    // Deterministic ops only (split mints a fresh clip UUID per application,
    // so identical INPUTS can't yield byte-identical ids across two runs).
    const state = makeState(2);
    const [c1, c2] = clipsInOrder(state.timeline);
    const ops: Operation[] = [
      { type: "trim", clipId: c1!.id, inPoint: 4, outPoint: 60 },
      { type: "move", clipId: c1!.id, newIndex: 1 },
      { type: "delete", clipId: c2!.id },
    ];

    const scratch = scratchStateForPlan(state, ops);
    const applied = applyPlan(createSession(state), "label", ops);
    assert.ok(scratch.ok && applied.ok);
    assert.deepEqual(scratch.state.timeline, applied.session.state.timeline,
      "scratch state and committed state must be identical");
  });

  test("an invalid operation surfaces a clean can't-preview error", () => {
    const state = makeState();
    const clipId = state.timeline.headId!;
    const r = scratchStateForPlan(state, [
      { type: "trim", clipId, inPoint: 0, outPoint: 30 },
      { type: "trim", clipId, inPoint: 50, outPoint: 20 },   // invalid
    ]);
    assert.ok(!r.ok);
    assert.match(r.error, /can't be previewed/);
    assert.match(r.error, /operation 2/);
  });
});

// ── Scope parsing and segment mapping ─────────────────────────────────────────

describe("preview scope", () => {
  test("no args → timeline; one arg → clip; two args → range; more → usage", () => {
    assert.deepEqual(parsePreviewArgs([]), { ok: true, scope: { type: "timeline" }, terminal: false });
    assert.deepEqual(parsePreviewArgs(["2"]), { ok: true, scope: { type: "clip", ref: "2" }, terminal: false });
    assert.deepEqual(parsePreviewArgs(["0:05", "15"]), { ok: true, scope: { type: "range", start: 5, end: 15 }, terminal: false });
    assert.ok(!parsePreviewArgs(["1", "2", "3"]).ok);
  });

  test("--term selects inline playback in any position and is not a clip ref", () => {
    assert.deepEqual(parsePreviewArgs(["--term"]), { ok: true, scope: { type: "timeline" }, terminal: true });
    assert.deepEqual(parsePreviewArgs(["--term", "2"]), { ok: true, scope: { type: "clip", ref: "2" }, terminal: true });
    assert.deepEqual(parsePreviewArgs(["2", "--term"]), { ok: true, scope: { type: "clip", ref: "2" }, terminal: true });
    assert.deepEqual(parsePreviewArgs(["--terminal", "0:05", "15"]), { ok: true, scope: { type: "range", start: 5, end: 15 }, terminal: true });
    const unknown = parsePreviewArgs(["--nope"]);
    assert.ok(!unknown.ok);
    assert.match(unknown.error, /--nope/);
  });

  test("an inverted range and unparseable times error cleanly", () => {
    const inverted = parsePreviewArgs(["20", "10"]);
    assert.ok(!inverted.ok);
    assert.match(inverted.error, /after its start/);
    assert.ok(!parsePreviewArgs(["abc", "10"]).ok);
  });

  test("timeline scope maps every clip to its source range", () => {
    let state = makeState(2);
    const [c1, c2] = clipsInOrder(state.timeline);
    const trimmed = applyOperations(state, [{ type: "trim", clipId: c2!.id, inPoint: 5, outPoint: 20 }]);
    assert.ok(trimmed.ok);
    state = trimmed.state;

    const r = segmentsForScope(state, { type: "timeline" });
    assert.ok(r.ok);
    assert.deepEqual(r.segments, [
      { input: "/fake/clip1.mp4", start: c1!.inPoint, end: c1!.outPoint },
      { input: "/fake/clip2.mp4", start: 5, end: 20 },
    ]);
  });

  test("clip scope resolves a display ref; unknown refs error with the valid range", () => {
    const state = makeState(2);
    const r = segmentsForScope(state, { type: "clip", ref: "2" });
    assert.ok(r.ok);
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0]!.input, "/fake/clip2.mp4");

    const bad = segmentsForScope(state, { type: "clip", ref: "99" });
    assert.ok(!bad.ok);
    assert.match(bad.error, /not found \(1–2\)/);
  });

  test("range scope slices across clip boundaries in timeline time", () => {
    // clip1: source 0–10 (10s), clip2: source 5–20 (15s). Timeline 0–25.
    let state = makeState(2);
    const [c1, c2] = clipsInOrder(state.timeline);
    const shaped = applyOperations(state, [
      { type: "trim", clipId: c1!.id, inPoint: 0, outPoint: 10 },
      { type: "trim", clipId: c2!.id, inPoint: 5, outPoint: 20 },
    ]);
    assert.ok(shaped.ok);
    state = shaped.state;

    const r = segmentsForScope(state, { type: "range", start: 8, end: 18 });
    assert.ok(r.ok);
    assert.deepEqual(r.segments, [
      { input: "/fake/clip1.mp4", start: 8, end: 10 },   // timeline 8–10
      { input: "/fake/clip2.mp4", start: 5, end: 13 },   // timeline 10–18 → source 5–13
    ]);
  });

  test("a range past the end of the timeline errors; an empty timeline errors", () => {
    const state = makeState(1);
    const past = segmentsForScope(state, { type: "range", start: 500, end: 600 });
    assert.ok(!past.ok);
    assert.match(past.error, /past the end/);

    const empty = segmentsForScope(createProject("empty"), { type: "timeline" });
    assert.ok(!empty.ok);
    assert.match(empty.error, /No clips/);
  });
});

// ── Encoder args (decisions 2 & 3) ────────────────────────────────────────────

describe("preview encoder args", () => {
  const seg: PreviewSegment = { input: "/x/a.mp4", start: 4, end: 34 };
  const args = buildPreviewTrimArgs(seg, "/tmp/out.mp4");

  test("keeps frame-accurate output seeking: -ss AFTER -i, with the exact range", () => {
    assert.ok(args.indexOf("-i") < args.indexOf("-ss"), "-ss must follow -i (output seeking)");
    assert.equal(args[args.indexOf("-ss") + 1], "4");
    assert.equal(args[args.indexOf("-t") + 1], "30");
  });

  test("trades only picture quality: preview crf/preset/scale, audio preserved", () => {
    assert.equal(args[args.indexOf("-crf") + 1], String(PREVIEW_SETTINGS.crf));
    assert.equal(args[args.indexOf("-preset") + 1], PREVIEW_SETTINGS.preset);
    assert.match(args[args.indexOf("-vf") + 1]!, new RegExp(`min\\(${PREVIEW_SETTINGS.maxHeight}`));
    assert.equal(args[args.indexOf("-c:a") + 1], "aac", "audio stream must be kept (decision 3)");
    assert.ok(!args.includes("-an"), "never strip audio");
  });

  test("export args are unchanged by the refactor (full quality, no scaling)", () => {
    const exp = buildTrimArgs({ type: "trim", input: "/x/a.mp4", start: 4, end: 34, output: "/tmp/e.mp4" });
    assert.equal(exp[exp.indexOf("-crf") + 1], String(EXPORT_ENCODE.crf));
    assert.equal(exp[exp.indexOf("-preset") + 1], EXPORT_ENCODE.preset);
    assert.ok(!exp.includes("-vf"), "export never downscales");
    assert.ok(exp.indexOf("-i") < exp.indexOf("-ss"));
  });
});

// ── Render + segment cache (decision 7) ───────────────────────────────────────

describe("renderPreviewFromSegments", () => {
  test("renders each segment then concats; a second render reuses the cache", async () => {
    const dir = mkdtempSync(join(workRoot, "render-"));
    const [srcA, srcB] = makeSources(dir, ["a.mp4", "b.mp4"]);
    const segments: PreviewSegment[] = [
      { input: srcA!, start: 0, end: 10 },
      { input: srcB!, start: 5, end: 20 },
    ];

    const first = mockFfmpeg();
    const r1 = await renderPreviewFromSegments(segments, { ffmpeg: first.runner, workDir: dir });
    assert.ok(r1.ok);
    assert.equal(r1.renderedSegments, 2);
    assert.equal(r1.cachedSegments, 0);
    assert.equal(first.calls.length, 3, "two segment renders + one concat");
    assert.ok(first.calls[2]!.includes("concat"), "final call is the concat join");
    assert.ok(existsSync(r1.path), "output file exists");

    const second = mockFfmpeg();
    const r2 = await renderPreviewFromSegments(segments, { ffmpeg: second.runner, workDir: dir });
    assert.ok(r2.ok);
    assert.equal(r2.cachedSegments, 2, "unchanged segments come from cache");
    assert.equal(r2.renderedSegments, 0);
    assert.equal(second.calls.length, 1, "only the concat runs on a warm cache");
    assert.notEqual(r2.path, r1.path, "each preview gets its own output file");
  });

  test("a changed segment re-renders; unchanged ones stay cached", async () => {
    const dir = mkdtempSync(join(workRoot, "render-"));
    const [src] = makeSources(dir, ["a.mp4"]);
    const seg = { input: src!, start: 0, end: 10 };

    await renderPreviewFromSegments([seg], { ffmpeg: mockFfmpeg().runner, workDir: dir });

    const { runner, calls } = mockFfmpeg();
    const r = await renderPreviewFromSegments(
      [seg, { input: src!, start: 0, end: 12 }],   // second range differs → cache miss
      { ffmpeg: runner, workDir: dir },
    );
    assert.ok(r.ok);
    assert.equal(r.cachedSegments, 1);
    assert.equal(r.renderedSegments, 1);
    assert.equal(calls.length, 2, "one segment render + concat");
  });

  test("progress reaches the callback and ends at 100", async () => {
    const dir = mkdtempSync(join(workRoot, "render-"));
    const [src] = makeSources(dir, ["a.mp4"]);
    const seen: number[] = [];
    const r = await renderPreviewFromSegments([{ input: src!, start: 0, end: 10 }], {
      ffmpeg: mockFfmpeg().runner, workDir: dir, onProgress: (p) => seen.push(p),
    });
    assert.ok(r.ok);
    assert.ok(seen.length >= 2);
    assert.equal(seen[seen.length - 1], 100);
    assert.ok(seen.every((p, i) => i === 0 || p >= seen[i - 1]!), "progress is monotonic");
  });

  test("abort mid-render returns ABORTED and cleans the partial segment out of the cache", async () => {
    const dir = mkdtempSync(join(workRoot, "render-"));
    const [src] = makeSources(dir, ["a.mp4"]);
    const { runner } = mockFfmpeg({ abortOnCall: 1 });

    const r = await renderPreviewFromSegments([{ input: src!, start: 0, end: 10 }], {
      ffmpeg: runner, workDir: dir,
    });
    assert.ok(!r.ok);
    assert.equal(r.code, "ABORTED");
    // The partial file must not poison the cache: a retry re-renders.
    const retry = mockFfmpeg();
    const r2 = await renderPreviewFromSegments([{ input: src!, start: 0, end: 10 }], {
      ffmpeg: retry.runner, workDir: dir,
    });
    assert.ok(r2.ok);
    assert.equal(r2.renderedSegments, 1, "aborted partial was not reused as a cached segment");
  });

  test("a missing source file errors cleanly without invoking ffmpeg", async () => {
    const dir = mkdtempSync(join(workRoot, "render-"));
    const { runner, calls } = mockFfmpeg();
    const r = await renderPreviewFromSegments([{ input: join(dir, "nope.mp4"), start: 0, end: 5 }], {
      ffmpeg: runner, workDir: dir,
    });
    assert.ok(!r.ok);
    assert.equal(r.code, "MISSING_SOURCE");
    assert.equal(calls.length, 0);
  });

  test("no segments → EMPTY, no render", async () => {
    const { runner, calls } = mockFfmpeg();
    const r = await renderPreviewFromSegments([], { ffmpeg: runner, workDir: workRoot });
    assert.ok(!r.ok && r.code === "EMPTY");
    assert.equal(calls.length, 0);
  });
});

// ── Player launch (decision 4) ────────────────────────────────────────────────

describe("openInPlayer", () => {
  test("an unknown platform falls back without throwing", async () => {
    const r = await openInPlayer("/tmp/x.mp4", "freebsd" as NodeJS.Platform);
    assert.equal(r.launched, false);
    assert.match(r.note!, /freebsd/);
  });

  test("a spawn error falls back to { launched: false }", async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      queueMicrotask(() => child.emit("error", new Error("ENOENT: no launcher")));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const r = await openInPlayer("/tmp/x.mp4", "linux", fakeSpawn);
    assert.equal(r.launched, false);
    assert.match(r.note!, /ENOENT/);
  });
});

// ── In-terminal playback (--term) ─────────────────────────────────────────────

describe("playInTerminal", () => {
  type FakeChild = EventEmitter & { stderr: EventEmitter; kill: (sig?: string) => boolean; killed?: string };

  function fakeSpawnWith(script: (child: FakeChild, args: string[]) => void) {
    const spawned: { bin: string; args: string[]; stdio: unknown }[] = [];
    const spawnFn = ((bin: string, args: string[], opts: { stdio: unknown }) => {
      spawned.push({ bin, args, stdio: opts.stdio });
      const child = new EventEmitter() as FakeChild;
      child.stderr = new EventEmitter();
      child.kill = (sig) => { child.killed = sig; queueMicrotask(() => child.emit("close", null, sig)); return true; };
      script(child, args);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawnFn, spawned };
  }
  const captured = () => { const out: string[] = []; return { out, stdout: { write: (s: string) => { out.push(s); return true; } } }; };

  test("enters the alternate screen, plays, and leaves it on success", async () => {
    const { spawnFn, spawned } = fakeSpawnWith((c) => queueMicrotask(() => c.emit("close", 0, null)));
    const { out, stdout } = captured();
    const r = await playInTerminal("/tmp/p.mp4", { spawnFn, stdout });
    assert.deepEqual(r, { ok: true });
    assert.equal(spawned[0]!.bin, "timg");
    assert.ok(spawned[0]!.args.includes("/tmp/p.mp4"));
    assert.ok(spawned[0]!.args.includes("-ph"), "pinned pixelation so timg never probes the terminal");
    assert.deepEqual(spawned[0]!.stdio, ["ignore", "inherit", "pipe"]);   // REPL keeps the keyboard
    assert.match(out[0]!, /\x1b\[\?1049h/);
    assert.match(out[out.length - 1]!, /\x1b\[\?1049l/);
  });

  test("a missing timg binary is a friendly install hint, and the screen is restored", async () => {
    const { spawnFn } = fakeSpawnWith((c) => queueMicrotask(() => {
      const err = new Error("spawn timg ENOENT") as NodeJS.ErrnoException; err.code = "ENOENT"; c.emit("error", err);
    }));
    const { out, stdout } = captured();
    const r = await playInTerminal("/tmp/p.mp4", { spawnFn, stdout });
    assert.ok(!r.ok);
    assert.equal(r.code, "NO_TIMG");
    assert.equal(r.error, TIMG_INSTALL_HINT);
    assert.match(out[out.length - 1]!, /\x1b\[\?1049l/);
  });

  test("a non-zero exit surfaces timg's last stderr line", async () => {
    const { spawnFn } = fakeSpawnWith((c) => queueMicrotask(() => {
      c.stderr.emit("data", Buffer.from("something\nCould not decode file\n"));
      c.emit("close", 1, null);
    }));
    const r = await playInTerminal("/tmp/p.mp4", { spawnFn, stdout: captured().stdout });
    assert.ok(!r.ok);
    assert.equal(r.code, "TIMG_FAILED");
    assert.equal(r.error, "Could not decode file");
  });

  test("an abort kills the child and resolves ABORTED only after it exits", async () => {
    let child: FakeChild | null = null;
    const { spawnFn } = fakeSpawnWith((c) => { child = c; });
    const controller = new AbortController();
    const p = playInTerminal("/tmp/p.mp4", { spawnFn, stdout: captured().stdout, signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const r = await p;
    assert.ok(!r.ok);
    assert.equal(r.code, "ABORTED");
    assert.equal(child!.killed, "SIGTERM");
  });

  test("an already-aborted signal never spawns", async () => {
    const { spawnFn, spawned } = fakeSpawnWith(() => {});
    const controller = new AbortController(); controller.abort();
    const { out, stdout } = captured();
    const r = await playInTerminal("/tmp/p.mp4", { spawnFn, stdout, signal: controller.signal });
    assert.ok(!r.ok && r.code === "ABORTED");
    assert.equal(spawned.length, 0);
    assert.equal(out.length, 0);   // no screen switch for a no-op
  });
});

// ── Orchestration: previewStateScope ──────────────────────────────────────────

describe("previewStateScope", () => {
  const okRender = (result: Partial<{ cachedSegments: number }> = {}) => {
    const rendered: PreviewSegment[][] = [];
    return {
      rendered,
      render: async (segments: PreviewSegment[]) => {
        rendered.push(segments);
        return { ok: true as const, path: "/tmp/preview-1.mp4", cachedSegments: result.cachedSegments ?? 0, renderedSegments: segments.length };
      },
    };
  };

  test("renders the scope and reports the player launch", async () => {
    const state = makeState(1);
    const { render, rendered } = okRender();
    const r = await previewStateScope(state, { type: "timeline" }, {
      render, open: async () => ({ launched: true }),
    });
    assert.ok(r.ok);
    assert.match(r.message, /playing in the system player/);
    assert.match(r.message, /preview-1\.mp4/);
    assert.equal(rendered.length, 1);
  });

  test("a failed player launch falls back to printing the path", async () => {
    const state = makeState(1);
    const r = await previewStateScope(state, { type: "timeline" }, {
      render: okRender().render, open: async () => ({ launched: false, note: "no player" }),
    });
    assert.ok(r.ok);
    assert.match(r.message, /open it manually/);
    assert.match(r.message, /preview-1\.mp4/);
  });

  test("an aborted render is reported as cancelled, not as an error", async () => {
    const state = makeState(1);
    const r = await previewStateScope(state, { type: "timeline" }, {
      render: async () => ({ ok: false as const, code: "ABORTED" as const, error: "cancelled" }),
      open: async () => ({ launched: true }),
    });
    assert.ok(!r.ok);
    assert.equal(r.aborted, true);
    assert.match(r.error, /cancelled/i);
  });

  test("--term plays inline instead of launching the system player, bracketed by onPlayback", async () => {
    const state = makeState(1);
    const events: string[] = [];
    let opened = 0;
    const r = await previewStateScope(state, { type: "timeline" }, {
      render: okRender({ cachedSegments: 1 }).render,
      terminal: true,
      onPlayback: (playing) => { events.push(playing ? "start" : "stop"); },
      play: async (path) => { events.push(`play:${path}`); return { ok: true }; },
      open: async () => { opened += 1; return { launched: true }; },
    });
    assert.ok(r.ok);
    assert.match(r.message, /played in the terminal/);
    assert.match(r.message, /1 segment reused/);
    assert.deepEqual(events, ["start", "play:/tmp/preview-1.mp4", "stop"]);
    assert.equal(opened, 0);
  });

  test("--term without timg fails softly and still hands over the rendered file", async () => {
    const state = makeState(1);
    const events: string[] = [];
    const r = await previewStateScope(state, { type: "timeline" }, {
      render: okRender().render,
      terminal: true,
      onPlayback: (playing) => { events.push(playing ? "start" : "stop"); },
      play: async () => ({ ok: false, code: "NO_TIMG", error: TIMG_INSTALL_HINT }),
    });
    assert.ok(!r.ok);
    assert.equal(r.aborted, undefined);
    assert.match(r.error, /brew install timg/);
    assert.match(r.error, /preview-1\.mp4/);
    assert.deepEqual(events, ["start", "stop"]);   // the REPL is always unfrozen
  });

  test("stopping --term playback is a cancellation, not an error", async () => {
    const r = await previewStateScope(makeState(1), { type: "timeline" }, {
      render: okRender().render,
      terminal: true,
      play: async () => ({ ok: false, code: "ABORTED", error: "cancelled" }),
    });
    assert.ok(!r.ok);
    assert.equal(r.aborted, true);
    assert.match(r.error, /stopped/i);
  });

  test("an empty timeline is a friendly message with no render attempt", async () => {
    const { render, rendered } = okRender();
    const r = await previewStateScope(createProject("empty"), { type: "timeline" }, {
      render, open: async () => ({ launched: true }),
    });
    assert.ok(!r.ok);
    assert.match(r.error, /No clips/);
    assert.equal(rendered.length, 0);
  });
});

// ── Confirm-gate semantics (decision 5) ───────────────────────────────────────
//
// `p` previews the scratch post-plan state and returns to the gate. The gate's
// contract lives in the confirm callback the loop awaits: previewing inside it
// resolves nothing, mutates nothing, and y afterward applies exactly once.

describe("confirm gate previews", () => {
  function providerFor(plan: unknown): ChatProvider {
    const responses: ChatResponse[] = [
      { content: [{ type: "tool_use", id: "tu_plan", name: "propose_edit_plan", input: plan }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
      { content: [{ type: "text", text: "Done." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    let i = 0;
    const next = () => responses[i++]!;
    return {
      send: async () => next(),
      stream: () => ({
        async *[Symbol.asyncIterator]() { /* deltas irrelevant here */ },
        finalResponse: async () => next(),
      }),
    };
  }

  test("repeated previews at the gate mutate nothing; y afterward applies one undo entry", async () => {
    const state = makeState(1);
    const session = createSession(state);
    const clipId = state.timeline.headId!;
    const plan = {
      summary: "Trim.",
      operations: [{ type: "trim", clipId, inPoint: 4, outPoint: 34 }],
    };

    const previews: PreviewSegment[][] = [];
    let sessionSnapshotDuringGate = "";
    const r = await runAgent({
      userPrompt: "trim to the good part",
      session,
      messages: [],
      autoApprove: false,
      provider: providerFor(plan),
      confirm: async (pending) => {
        // Two `p` presses: preview the scratch state twice, then answer y.
        for (let p = 0; p < 2; p++) {
          const scratch = scratchStateForPlan(session.state, pending.operations);
          assert.ok(scratch.ok);
          const out = await previewStateScope(scratch.state, { type: "timeline" }, {
            render: async (segs) => { previews.push(segs); return { ok: true, path: "/tmp/p.mp4", cachedSegments: 0, renderedSegments: segs.length }; },
            open: async () => ({ launched: true }),
          });
          assert.ok(out.ok);
        }
        sessionSnapshotDuringGate = JSON.stringify(session);
        return { approved: true };
      },
    });

    assert.equal(r.isError, false);
    assert.equal(previews.length, 2, "both p presses rendered");
    // The previews rendered the WOULD-BE state (trimmed to 4–34)...
    assert.deepEqual(previews[0], [{ input: "/fake/clip1.mp4", start: 4, end: 34 }]);
    assert.deepEqual(previews[1], previews[0], "the plan is unchanged between previews");
    // ...while the real session stayed pristine until y.
    assert.equal(sessionSnapshotDuringGate, JSON.stringify(createSession(state)),
      "session untouched while previewing at the gate");
    assert.equal(r.session.undo.length, 1, "y afterward applies exactly one undo entry");
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 4);
  });

  test("a preview at the gate followed by n leaves state fully unchanged", async () => {
    const state = makeState(1);
    const session = createSession(state);
    const clipId = state.timeline.headId!;
    const plan = { summary: "Trim.", operations: [{ type: "trim", clipId, inPoint: 4, outPoint: 34 }] };

    const r = await runAgent({
      userPrompt: "trim it",
      session,
      messages: [],
      autoApprove: false,
      provider: providerFor(plan),
      confirm: async (pending) => {
        const scratch = scratchStateForPlan(session.state, pending.operations);
        assert.ok(scratch.ok);
        await previewStateScope(scratch.state, { type: "timeline" }, {
          render: async (segs) => ({ ok: true, path: "/tmp/p.mp4", cachedSegments: 0, renderedSegments: segs.length }),
          open: async () => ({ launched: true }),
        });
        return { approved: false };
      },
    });

    assert.equal(r.isError, false);
    assert.equal(r.session.undo.length, 0);
    assert.equal(clipsInOrder(r.session.state.timeline)[0]!.inPoint, 0, "rejected after preview → untouched");
  });
});

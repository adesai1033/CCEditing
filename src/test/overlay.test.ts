import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  overlaysOf, getOverlayDisplayRefs, resolveOverlay, anchorFractions, clipsInOrder,
  type ProjectState, type Overlay,
} from "../project/types.js";
import {
  addSource, addOverlay, updateOverlay, removeOverlay, removeSource, importSource, OVERLAY_DEFAULTS,
} from "../project/mutations.js";
import { applyPlan, applyOperations, createSession, undoSession, type Operation } from "../project/session.js";
import { createProject, saveProject, loadProject } from "../project/io.js";
import { computeOverlayPlacement, buildOverlayArgs, buildOverlayFilter, EXPORT_ENCODE } from "../engine/ffmpeg.js";
import { clipOverlayToWindow, overlayLayersFor } from "../engine/layers.js";
import type { OverlayLayer } from "../engine/types.js";
import { renderPreviewFromSegments, type FfmpegRunner } from "../engine/preview.js";
import { segmentsForScope, previewStateScope } from "../repl/commands/preview.js";
import { parseFraction, parsePosition, runOverlayCommand, renderOverlayList } from "../repl/commands/overlay.js";
import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { renderPlanForConfirmation, AgentOperationSchema } from "../agent/propose_edit_plan.js";
import { queryTimeline } from "../agent/tools/query_timeline.js";
import { exportTimeline } from "../engine/export.js";
import { stripAnsi } from "../ui/theme.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let workRoot: string;
const originalCwd = process.cwd();

before(() => {
  workRoot = mkdtempSync(join(tmpdir(), "cutcli-overlay-test-"));
  // dispatch persists .cutcli.json to the CWD — keep it out of the repo.
  process.chdir(workRoot);
});
after(() => {
  process.chdir(originalCwd);
  try { rmSync(workRoot, { recursive: true, force: true }); } catch {}
});

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 120,
    width: 1920, height: 1080, fps: 30,
    videoCodec: "h264", audioCodec: "aac", audioChannels: 2, audioBitrate: 128,
    fileSize: 1_000_000, bitrate: 8000, containerFormat: "mp4",
    ...overrides,
  };
}

/** n main-track clips (clip1.mp4 … each 120s) — no overlays. */
function makeState(n = 1): ProjectState {
  let state = createProject("test");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({ filePath: `/fake/clip${i + 1}.mp4`, fileName: `clip${i + 1}.mp4` }));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

/** makeState(n) plus an overlay of clip1's source with the given placement. */
function withOverlay(n: number, placement: Parameters<typeof addOverlay>[2] = {}): ProjectState {
  const state = makeState(n);
  const r = addOverlay(state, state.sources[0]!.id, placement);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.state;
}

const strip = (s: string) => stripAnsi(s);

// ── Model ─────────────────────────────────────────────────────────────────────

describe("overlay model", () => {
  test("overlaysOf tolerates timelines without the track; refs are o1, o2 in stacking order", () => {
    const bare = createProject("x");
    assert.deepEqual(overlaysOf(bare.timeline), []);
    assert.equal(getOverlayDisplayRefs(bare.timeline).size, 0);

    let state = withOverlay(1);
    const again = addOverlay(state, state.sources[0]!.id, { at: 5 });
    assert.ok(again.ok);
    state = again.state;
    const [a, b] = overlaysOf(state.timeline);
    const refs = getOverlayDisplayRefs(state.timeline);
    assert.equal(refs.get(a!.id), "o1");
    assert.equal(refs.get(b!.id), "o2");
  });

  test("resolveOverlay accepts a UUID, 'o2', or a bare index; rejects the rest", () => {
    let state = withOverlay(1);
    const more = addOverlay(state, state.sources[0]!.id, { at: 5 });
    assert.ok(more.ok);
    state = more.state;
    const [a, b] = overlaysOf(state.timeline);
    assert.equal(resolveOverlay(state.timeline, a!.id)?.id, a!.id);
    assert.equal(resolveOverlay(state.timeline, "o2")?.id, b!.id);
    assert.equal(resolveOverlay(state.timeline, "O1")?.id, a!.id);
    assert.equal(resolveOverlay(state.timeline, "2")?.id, b!.id);
    assert.equal(resolveOverlay(state.timeline, "o3"), undefined);
    assert.equal(resolveOverlay(state.timeline, "0"), undefined);
    assert.equal(resolveOverlay(state.timeline, "nope"), undefined);
  });

  test("anchorFractions maps the nine anchors onto the overlay's own frame", () => {
    assert.deepEqual(anchorFractions("top-left"), { ax: 0, ay: 0 });
    assert.deepEqual(anchorFractions("top"), { ax: 0.5, ay: 0 });
    assert.deepEqual(anchorFractions("right"), { ax: 1, ay: 0.5 });
    assert.deepEqual(anchorFractions("center"), { ax: 0.5, ay: 0.5 });
    assert.deepEqual(anchorFractions("bottom-right"), { ax: 1, ay: 1 });
  });
});

// ── Mutations ─────────────────────────────────────────────────────────────────

describe("overlay mutations", () => {
  test("addOverlay defaults to the whole source, top-right, quarter width, at 0", () => {
    const state = withOverlay(1);
    const [o] = overlaysOf(state.timeline);
    assert.equal(o!.inPoint, 0);
    assert.equal(o!.outPoint, 120);
    assert.equal(o!.at, OVERLAY_DEFAULTS.at);
    assert.equal(o!.anchor, "top-right");
    assert.equal(o!.x, OVERLAY_DEFAULTS.x);
    assert.equal(o!.y, OVERLAY_DEFAULTS.y);
    assert.equal(o!.scale, 0.25);
    assert.equal(o!.label, "clip1.mp4");
    // The main track is untouched: still one clip.
    assert.equal(clipsInOrder(state.timeline).length, 1);
  });

  test("addOverlay validates range, scale, position and anchor", () => {
    const state = makeState(1);
    const sid = state.sources[0]!.id;
    const bad = (p: Parameters<typeof addOverlay>[2], re: RegExp) => {
      const r = addOverlay(state, sid, p);
      assert.ok(!r.ok);
      assert.match(r.error, re);
    };
    bad({ inPoint: 10, outPoint: 5 }, /In-point .* before out-point/);
    bad({ outPoint: 500 }, /exceeds source duration/);
    bad({ inPoint: -1 }, /cannot be negative/);
    bad({ at: -2 }, /cannot be negative/);
    bad({ scale: 0 }, /Scale must be between 0 and 1/);
    bad({ scale: 1.5 }, /Scale must be between 0 and 1/);
    bad({ x: 5 }, /x must be between/);
    bad({ anchor: "middle" as never }, /Unknown anchor/);
    const missing = addOverlay(state, "nope", {});
    assert.ok(!missing.ok);
    assert.match(missing.error, /Source not found/);
  });

  test("updateOverlay changes only the named fields and re-validates", () => {
    const state = withOverlay(1);
    const o = overlaysOf(state.timeline)[0]!;
    const moved = updateOverlay(state, o.id, { anchor: "bottom-left", x: 0.03, y: 0.97 });
    assert.ok(moved.ok);
    const after = overlaysOf(moved.state.timeline)[0]!;
    assert.equal(after.anchor, "bottom-left");
    assert.equal(after.scale, 0.25, "scale untouched");
    assert.equal(after.outPoint, 120, "range untouched");

    const tooBig = updateOverlay(state, o.id, { scale: 2 });
    assert.ok(!tooBig.ok);
    const unknown = updateOverlay(state, "nope", { scale: 0.5 });
    assert.ok(!unknown.ok);
    // Immutability: the original state is unchanged.
    assert.equal(overlaysOf(state.timeline)[0]!.anchor, "top-right");
  });

  test("removeOverlay drops the layer; removeSource drops every overlay of that source", () => {
    const state = withOverlay(2);
    const o = overlaysOf(state.timeline)[0]!;
    const removed = removeOverlay(state, o.id);
    assert.ok(removed.ok);
    assert.equal(overlaysOf(removed.state.timeline).length, 0);
    assert.ok(!removeOverlay(state, "nope").ok);

    const srcGone = removeSource(state, state.sources[0]!.id);
    assert.ok(srcGone.ok);
    assert.equal(overlaysOf(srcGone.state.timeline).length, 0);
    assert.equal(clipsInOrder(srcGone.state.timeline).length, 1);
  });

  test("importSource registers a source without a clip and dedupes by path", () => {
    const state = makeState(1);
    const first = importSource(state, makeMediaInfo({ filePath: "/fake/pip.mp4", fileName: "pip.mp4" }));
    assert.equal(first.state.sources.length, 2);
    assert.equal(clipsInOrder(first.state.timeline).length, 1, "no main-track clip added");
    const again = importSource(first.state, makeMediaInfo({ filePath: "/fake/pip.mp4", fileName: "pip.mp4" }));
    assert.equal(again.state.sources.length, 2);
    assert.equal(again.source.id, first.source.id);
    // Already a clip's source → reused too.
    const existing = importSource(state, makeMediaInfo({ filePath: "/fake/clip1.mp4", fileName: "clip1.mp4" }));
    assert.equal(existing.source.id, state.sources[0]!.id);
  });
});

// ── Session operations ────────────────────────────────────────────────────────

describe("overlay operations through applyPlan", () => {
  test("addOverlayFromFile imports + overlays as one undo entry", () => {
    const session = createSession(makeState(1));
    const r = applyPlan(session, "add overlay pip.mp4", [
      { type: "addOverlayFromFile", mediaInfo: makeMediaInfo({ filePath: "/fake/pip.mp4", fileName: "pip.mp4" }), at: 3, scale: 0.4 },
    ]);
    assert.ok(r.ok);
    assert.equal(r.session.state.sources.length, 2);
    assert.equal(clipsInOrder(r.session.state.timeline).length, 1);
    const [o] = overlaysOf(r.session.state.timeline);
    assert.equal(o!.at, 3);
    assert.equal(o!.scale, 0.4);
    assert.equal(o!.label, "pip.mp4");
    assert.equal(r.session.undo.length, 1);

    const undone = undoSession(r.session);
    assert.ok(undone.ok);
    assert.equal(overlaysOf(undone.session.state.timeline).length, 0);
    assert.equal(undone.session.state.sources.length, 1, "the import is undone with the overlay");
  });

  test("addOverlay / updateOverlay / removeOverlay compose in a plan; a failing op aborts the plan", () => {
    const state = makeState(1);
    const sid = state.sources[0]!.id;
    const ops: Operation[] = [
      { type: "addOverlay", sourceId: sid, at: 2, inPoint: 10, outPoint: 20, anchor: "center", x: 0.5, y: 0.5, scale: 0.5 },
    ];
    const one = applyOperations(state, ops);
    assert.ok(one.ok);
    const oid = overlaysOf(one.state.timeline)[0]!.id;
    const two = applyOperations(one.state, [
      { type: "updateOverlay", overlayId: oid, scale: 0.3 },
      { type: "removeOverlay", overlayId: oid },
    ]);
    assert.ok(two.ok);
    assert.equal(overlaysOf(two.state.timeline).length, 0);

    const broken = applyOperations(one.state, [
      { type: "updateOverlay", overlayId: oid, scale: 0.3 },
      { type: "updateOverlay", overlayId: oid, scale: 9 },
    ]);
    assert.ok(!broken.ok);
    assert.equal(broken.failedAt, 1);
  });

  test("the agent vocabulary has addOverlay/updateOverlay/removeOverlay but no file import", () => {
    assert.ok(AgentOperationSchema.safeParse({ type: "addOverlay", sourceId: "s", at: 1, anchor: "bottom-right", x: 0.97, y: 0.97, scale: 0.3 }).success);
    assert.ok(AgentOperationSchema.safeParse({ type: "updateOverlay", overlayId: "o", x: 0.1 }).success);
    assert.ok(AgentOperationSchema.safeParse({ type: "removeOverlay", overlayId: "o" }).success);
    assert.ok(!AgentOperationSchema.safeParse({ type: "addOverlayFromFile", mediaInfo: {} }).success);
    assert.ok(!AgentOperationSchema.safeParse({ type: "addOverlay", sourceId: "s", anchor: "middle" }).success);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("overlay persistence", () => {
  test("save/load round-trips the overlay track", async () => {
    const state = withOverlay(1, { at: 4, anchor: "bottom-left", x: 0.03, y: 0.97, scale: 0.33 });
    const file = join(workRoot, "roundtrip.json");
    await saveProject(createSession(state), file);
    const loaded = await loadProject(file);
    assert.deepEqual(overlaysOf(loaded.state.timeline), overlaysOf(state.timeline));
    assert.equal(loaded.state.version, 6);
  });

  test("a pre-v5 project loads with an empty overlay track", async () => {
    const state = makeState(1);
    const { overlays: _drop, ...timeline } = state.timeline;
    const file = join(workRoot, "v4.json");
    writeFileSync(file, JSON.stringify({ ...state, timeline, version: 4, undo: [], redo: [] }));
    const loaded = await loadProject(file);
    assert.deepEqual(loaded.state.timeline.overlays, []);
    assert.equal(clipsInOrder(loaded.state.timeline).length, 1);
  });
});

// ── Pixel placement & FFmpeg args ─────────────────────────────────────────────

const layer = (over: Partial<OverlayLayer> = {}): OverlayLayer => ({
  input: "/fake/pip.mp4", inPoint: 0, outPoint: 10, at: 0,
  anchor: "top-right", x: 0.97, y: 0.03, scale: 0.25,
  sourceWidth: 1920, sourceHeight: 1080,
  ...over,
});

describe("computeOverlayPlacement", () => {
  test("quarter-width top-right on 1080p: 480×270 pinned by its top-right corner", () => {
    const p = computeOverlayPlacement(layer(), { width: 1920, height: 1080 });
    assert.deepEqual(p, { width: 480, height: 270, x: 1382, y: 32 });
  });

  test("the same fractional geometry scales with the base (480p preview)", () => {
    const p = computeOverlayPlacement(layer(), { width: 854, height: 480 });
    assert.equal(p.width, 214);                    // 213.5 → even
    assert.equal(p.height, 120);                   // 214 * 9/16 = 120.4 → even
    assert.equal(p.x, Math.round(0.97 * 854 - 214));
    assert.equal(p.y, Math.round(0.03 * 480));
  });

  test("center anchors by the overlay's midpoint; bottom-right by its far corner", () => {
    const c = computeOverlayPlacement(layer({ anchor: "center", x: 0.5, y: 0.5, scale: 0.5 }), { width: 1920, height: 1080 });
    assert.deepEqual(c, { width: 960, height: 540, x: 480, y: 270 });
    const br = computeOverlayPlacement(layer({ anchor: "bottom-right", x: 1, y: 1, scale: 0.25 }), { width: 1920, height: 1080 });
    assert.deepEqual(br, { width: 480, height: 270, x: 1440, y: 810 });
  });

  test("keeps the overlay's own aspect (portrait source) and forces even sizes", () => {
    const p = computeOverlayPlacement(layer({ sourceWidth: 1080, sourceHeight: 1920, scale: 0.2 }), { width: 1280, height: 720 });
    assert.equal(p.width, 256);
    assert.equal(p.height, 456);                   // 256 * 16/9 = 455.1 → even
    assert.equal(p.width % 2, 0);
    assert.equal(p.height % 2, 0);
  });
});

describe("buildOverlayArgs", () => {
  test("pre-seeks each layer, stacks them in order, and carries the base audio", () => {
    const args = buildOverlayArgs({
      type: "overlay", base: "/tmp/base.mp4", output: "/tmp/out.mp4",
      layers: [layer({ at: 2, inPoint: 5, outPoint: 8 }), layer({ input: "/fake/b.mp4", at: 0, anchor: "bottom-left", x: 0.03, y: 0.97 })],
    }, { width: 1920, height: 1080 });

    // Inputs: base first, then -ss/-t before each layer's -i.
    assert.deepEqual(args.slice(0, 2), ["-i", "/tmp/base.mp4"]);
    assert.deepEqual(args.slice(2, 8), ["-ss", "5", "-t", "3", "-i", "/fake/pip.mp4"]);
    assert.deepEqual(args.slice(8, 14), ["-ss", "0", "-t", "10", "-i", "/fake/b.mp4"]);

    const filter = args[args.indexOf("-filter_complex") + 1]!;
    assert.match(filter, /\[1:v\]scale=480:270,setpts=PTS-STARTPTS\+2\/TB\[ov0\]/);
    assert.match(filter, /\[0:v\]\[ov0\]overlay=x=1382:y=32:eof_action=pass:enable=between\(t\\,2\\,5\)\[vo0\]/);
    assert.match(filter, /\[vo0\]\[ov1\]overlay=x=58:y=778:eof_action=pass:enable=between\(t\\,0\\,10\),format=yuv420p\[vout\]/);

    const mapIdx = args.indexOf("-map");
    assert.deepEqual(args.slice(mapIdx, mapIdx + 4), ["-map", "[vout]", "-map", "0:a?"]);
    assert.ok(args.includes("-c:a") && args[args.indexOf("-c:a") + 1] === "copy");
    assert.equal(args[args.indexOf("-crf") + 1], String(EXPORT_ENCODE.crf));
    assert.equal(args[args.length - 1], "/tmp/out.mp4");
  });

  test("a single layer gets the final format applied on its own overlay", () => {
    const f = buildOverlayFilter([layer()], { width: 1920, height: 1080 });
    assert.equal((f.match(/overlay=/g) ?? []).length, 1);
    assert.match(f, /,format=yuv420p\[vout\]$/);
  });
});

// ── Window clipping ───────────────────────────────────────────────────────────

describe("overlay layers for a rendered window", () => {
  const ov = (at: number, inPoint: number, outPoint: number): Overlay => ({
    id: "o", sourceId: "s", inPoint, outPoint, at, anchor: "top-right", x: 0.97, y: 0.03, scale: 0.25, label: "o",
  });

  test("clipOverlayToWindow re-bases and trims the source range", () => {
    // Overlay plays timeline 10–20 from source 0–10.
    assert.deepEqual(clipOverlayToWindow(ov(10, 0, 10), 0, Infinity), { at: 10, inPoint: 0, outPoint: 10 });
    assert.deepEqual(clipOverlayToWindow(ov(10, 0, 10), 5, 15), { at: 5, inPoint: 0, outPoint: 5 });     // cut at the end
    assert.deepEqual(clipOverlayToWindow(ov(10, 0, 10), 15, 30), { at: 0, inPoint: 5, outPoint: 10 });   // cut at the start
    assert.deepEqual(clipOverlayToWindow(ov(10, 0, 10), 12, 14), { at: 0, inPoint: 2, outPoint: 4 });    // inside
    assert.equal(clipOverlayToWindow(ov(10, 0, 10), 20, 30), null);                                      // disjoint (touching)
    assert.equal(clipOverlayToWindow(ov(10, 0, 10), 0, 10), null);
  });

  test("overlayLayersFor drops overlays outside the window and errors on a missing source", () => {
    let state = withOverlay(1, { at: 30, inPoint: 0, outPoint: 10 });
    const inside = overlayLayersFor(state, { start: 25, end: 45 });
    assert.ok(inside.ok);
    assert.equal(inside.layers.length, 1);
    assert.equal(inside.layers[0]!.at, 5);
    assert.equal(inside.layers[0]!.sourceWidth, 1920);
    const outside = overlayLayersFor(state, { start: 0, end: 20 });
    assert.ok(outside.ok);
    assert.equal(outside.layers.length, 0);

    state = { ...state, sources: [] };
    const missing = overlayLayersFor(state);
    assert.ok(!missing.ok);
    assert.match(missing.error, /Source file missing for overlay/);
  });

  test("segmentsForScope reports the timeline window each scope covers", () => {
    const state = makeState(3);   // 3 × 120s
    const all = segmentsForScope(state, { type: "timeline" });
    assert.ok(all.ok);
    assert.deepEqual(all.window, { start: 0, end: 360 });
    const clip2 = segmentsForScope(state, { type: "clip", ref: "2" });
    assert.ok(clip2.ok);
    assert.deepEqual(clip2.window, { start: 120, end: 240 });
    const range = segmentsForScope(state, { type: "range", start: 100, end: 9999 });
    assert.ok(range.ok);
    assert.deepEqual(range.window, { start: 100, end: 360 });
  });

  test("previewStateScope hands the renderer only the overlays visible in the scope, re-based", async () => {
    const state = withOverlay(2, { at: 130, inPoint: 0, outPoint: 20 });   // plays on clip 2, timeline 130–150
    const seen: Array<OverlayLayer[] | undefined> = [];
    const render = async (_segs: unknown, opts: { overlays?: OverlayLayer[] }) => {
      seen.push(opts.overlays);
      return { ok: true as const, path: "/tmp/p.mp4", cachedSegments: 0, renderedSegments: 1 };
    };
    const open = async () => ({ launched: true });

    await previewStateScope(state, { type: "clip", ref: "2" }, { render, open });
    await previewStateScope(state, { type: "clip", ref: "1" }, { render, open });
    await previewStateScope(state, { type: "range", start: 140, end: 200 }, { render, open });

    assert.equal(seen[0]![0]!.at, 10, "clip 2 starts at timeline 120, overlay at 130 → 10s in");
    assert.equal(seen[1], undefined, "clip 1 has no overlay in view");
    assert.deepEqual([seen[2]![0]!.at, seen[2]![0]!.inPoint, seen[2]![0]!.outPoint], [0, 10, 20]);
  });
});

// ── Preview compositing pass ──────────────────────────────────────────────────

describe("renderPreviewFromSegments with overlays", () => {
  function mockFfmpeg() {
    const calls: string[][] = [];
    const runner: FfmpegRunner = async (args, opts) => {
      calls.push(args);
      await writeFile(args[args.length - 1]!, "rendered");
      opts?.onOutTime?.(1);
      return { ok: true };
    };
    return { runner, calls };
  }

  test("runs one compositing pass over the joined base and returns the composited file", async () => {
    const dir = mkdtempSync(join(workRoot, "pv-"));
    const src = join(dir, "src.mp4");
    writeFileSync(src, "dummy");
    const { runner, calls } = mockFfmpeg();
    const progress: number[] = [];

    const r = await renderPreviewFromSegments([{ input: src, start: 0, end: 4 }], {
      ffmpeg: runner,
      workDir: dir,
      overlays: [layer({ input: src, inPoint: 1, outPoint: 3, at: 1 })],
      probe: async () => ({ width: 854, height: 480, fps: 24 }),
      onProgress: (p) => progress.push(p),
    });
    assert.ok(r.ok);
    assert.match(r.path, /-ov\.mp4$/);
    assert.ok(existsSync(r.path));
    assert.equal(calls.length, 3, "trim, concat, composite");
    const composite = calls[2]!;
    assert.ok(composite.includes("-filter_complex"));
    assert.match(composite[composite.indexOf("-filter_complex") + 1]!, /scale=214:120/);
    assert.equal(composite[composite.indexOf("-preset") + 1], "ultrafast", "preview knobs, not export");
    assert.equal(progress[progress.length - 1], 100);
    assert.ok(progress.some((p) => p > 60 && p < 100), "the compositing pass reports progress");
  });

  test("without overlays the pipeline is unchanged (two ffmpeg calls)", async () => {
    const dir = mkdtempSync(join(workRoot, "pv2-"));
    const src = join(dir, "src.mp4");
    writeFileSync(src, "dummy");
    const { runner, calls } = mockFfmpeg();
    const r = await renderPreviewFromSegments([{ input: src, start: 0, end: 4 }], { ffmpeg: runner, workDir: dir });
    assert.ok(r.ok);
    assert.equal(calls.length, 2);
  });
});

// ── Command parsing & handling ────────────────────────────────────────────────

describe("/overlay value parsing", () => {
  test("parseFraction reads percents, fractions, and bare numbers", () => {
    assert.equal(parseFraction("25%"), 0.25);
    assert.equal(parseFraction("0.25"), 0.25);
    assert.equal(parseFraction("25"), 0.25);
    assert.equal(parseFraction("1"), 1);
    assert.equal(parseFraction("100%"), 1);
    assert.throws(() => parseFraction("big"), /Invalid value/);
    assert.throws(() => parseFraction("-5%"), /Invalid/);
  });

  test("parsePosition resolves anchors with a margin, or x,y for the top-left corner", () => {
    assert.deepEqual(parsePosition("top-right"), { anchor: "top-right", x: 0.97, y: 0.03 });
    assert.deepEqual(parsePosition("bottom-left", { margin: 0.1 }), { anchor: "bottom-left", x: 0.1, y: 0.9 });
    assert.deepEqual(parsePosition("center"), { anchor: "center", x: 0.5, y: 0.5 });
    assert.deepEqual(parsePosition("CENTER"), { anchor: "center", x: 0.5, y: 0.5 });
    assert.deepEqual(parsePosition("10%,80%"), { anchor: "top-left", x: 0.1, y: 0.8 });
    assert.deepEqual(parsePosition("0.5,0.5", { anchor: "center" }), { anchor: "center", x: 0.5, y: 0.5 });
    assert.throws(() => parsePosition("somewhere"), /Invalid position/);
    assert.throws(() => parsePosition("1,2,3"), /Invalid position/);
  });
});

describe("runOverlayCommand", () => {
  const probe = async (absPath: string) =>
    absPath.endsWith("pip.mp4")
      ? { ok: true as const, data: makeMediaInfo({ filePath: absPath, fileName: "pip.mp4", duration: 30 }) }
      : { ok: false as const, error: `File not found: ${absPath}`, code: "NOT_FOUND" as const };

  test("no args → usage; help → usage without error", async () => {
    const session = createSession(makeState(1));
    const none = await runOverlayCommand([], session);
    assert.ok(none.isError);
    assert.match(none.output, /Usage/);
    const help = await runOverlayCommand(["help"], session);
    assert.ok(!help.isError);
  });

  test("adds an overlay from a clip ref with the clip's range and the given placement", async () => {
    const session = createSession(makeState(2));
    const r = await runOverlayCommand(["2", "--at", "0:05", "--pos", "bottom-left", "--size", "40%", "--from", "10", "--to", "20"], session, { probe });
    assert.ok(!r.isError, r.output);
    assert.ok(r.session);
    const [o] = overlaysOf(r.session!.state.timeline);
    assert.equal(o!.sourceId, session.state.sources[1]!.id);
    assert.deepEqual([o!.at, o!.inPoint, o!.outPoint, o!.anchor, o!.x, o!.y, o!.scale], [5, 10, 20, "bottom-left", 0.03, 0.97, 0.4]);
    assert.match(strip(r.output), /Added overlay \[o1\] clip2\.mp4/);
    assert.match(strip(r.output), /0:05 → 0:15/);
    assert.match(strip(r.output), /bottom-left @ 3%,97%/);
    assert.match(strip(r.output), /40% wide/);
    assert.equal(r.session!.undo.length, 1);
    assert.equal(clipsInOrder(r.session!.state.timeline).length, 2, "main track unchanged");
  });

  test("adds an overlay from a file path, importing it as a source without a clip", async () => {
    const session = createSession(makeState(1));
    const r = await runOverlayCommand(["pip.mp4", "--pos", "10%,80%", "--anchor", "bottom-left"], session, { probe });
    assert.ok(!r.isError, r.output);
    assert.equal(r.session!.state.sources.length, 2);
    assert.equal(clipsInOrder(r.session!.state.timeline).length, 1);
    const [o] = overlaysOf(r.session!.state.timeline);
    assert.deepEqual([o!.anchor, o!.x, o!.y, o!.outPoint, o!.label], ["bottom-left", 0.1, 0.8, 30, "pip.mp4"]);
  });

  test("a target that is neither a clip nor a file is a clear error; unknown flags are rejected", async () => {
    const session = createSession(makeState(1));
    const r = await runOverlayCommand(["nothing.mp4"], session, { probe });
    assert.ok(r.isError);
    assert.match(r.output, /neither a clip on the timeline nor a file/);
    const flag = await runOverlayCommand(["1", "--wat", "3"], session, { probe });
    assert.ok(flag.isError);
    assert.match(flag.output, /Unknown option --wat/);
    const missingValue = await runOverlayCommand(["1", "--size"], session, { probe });
    assert.ok(missingValue.isError);
    assert.match(missingValue.output, /needs a value/);
  });

  test("list / move / size / time / delete address overlays by o-ref", async () => {
    let session = createSession(withOverlay(1, { at: 0, inPoint: 0, outPoint: 10 }));

    const list = await runOverlayCommand(["list"], session);
    assert.match(strip(list.output), /\[o1\]\s+clip1\.mp4\s+0:00 → 0:10/);

    const move = await runOverlayCommand(["move", "o1", "center"], session);
    assert.ok(!move.isError, move.output);
    session = move.session!;
    assert.equal(overlaysOf(session.state.timeline)[0]!.anchor, "center");
    assert.match(strip(move.output), /Moved overlay \[o1\].*center @ 50%,50%/);

    const size = await runOverlayCommand(["size", "1", "50%"], session);
    assert.ok(!size.isError, size.output);
    session = size.session!;
    assert.equal(overlaysOf(session.state.timeline)[0]!.scale, 0.5);

    const time = await runOverlayCommand(["time", "o1", "0:07", "2", "6"], session);
    assert.ok(!time.isError, time.output);
    session = time.session!;
    const o = overlaysOf(session.state.timeline)[0]!;
    assert.deepEqual([o.at, o.inPoint, o.outPoint], [7, 2, 6]);
    assert.match(strip(time.output), /0:07 → 0:11/);

    const badTime = await runOverlayCommand(["time", "o1", "0:07", "2"], session);
    assert.ok(badTime.isError);

    const del = await runOverlayCommand(["delete", "o1"], session);
    assert.ok(!del.isError);
    session = del.session!;
    assert.equal(overlaysOf(session.state.timeline).length, 0);
    assert.equal(session.undo.length, 4);

    const gone = await runOverlayCommand(["move", "o1", "center"], session);
    assert.ok(gone.isError);
    assert.match(gone.output, /No overlays yet/);
    assert.match(renderOverlayList(session.state), /No overlays/);
  });

  test("undo reverts an overlay change", async () => {
    const session = createSession(withOverlay(1));
    const size = await runOverlayCommand(["size", "o1", "0.6"], session);
    const undone = undoSession(size.session!);
    assert.ok(undone.ok);
    assert.equal(undone.label, "resize overlay [o1]");
    assert.equal(overlaysOf(undone.session.state.timeline)[0]!.scale, 0.25);
  });
});

// ── REPL dispatch & display ───────────────────────────────────────────────────

describe("/overlay via dispatch", () => {
  const noProject: ReplState = { session: null, messages: [], autoApprove: false };

  test("requires a project", async () => {
    const r = await dispatch("/overlay 1", noProject);
    assert.ok(r.isError);
    assert.match(r.output, /No project open/);
  });

  test("adds an overlay, persists, and leaves a continuity note for the agent", async () => {
    const state: ReplState = { session: createSession(makeState(2)), messages: [], autoApprove: false };
    const r = await dispatch("/overlay 2 --pos bottom-right --size 30%", state);
    assert.ok(!r.isError, r.output);
    assert.ok(r.newState?.session);
    assert.equal(overlaysOf(r.newState!.session!.state.timeline).length, 1);
    assert.equal(r.newState!.messages.length, 1);
    const note = r.newState!.messages[0]!.content[0];
    assert.ok(note && note.type === "text" && /via slash command: Added overlay \[o1\]/.test(note.text));
    assert.ok(existsSync(join(workRoot, ".cutcli.json")));
    const persisted = JSON.parse(readFileSync(join(workRoot, ".cutcli.json"), "utf-8"));
    assert.equal(persisted.timeline.overlays.length, 1);
  });

  test("/overlay list is read-only (no newState) and /help lists /overlay", async () => {
    const state: ReplState = { session: createSession(withOverlay(1)), messages: [], autoApprove: false };
    const r = await dispatch("/overlay list", state);
    assert.ok(!r.isError);
    assert.equal(r.newState, undefined);
    const help = await dispatch("/help", noProject);
    assert.match(strip(help.output), /\/overlay <file\|clip>/);
  });
});

describe("overlay display", () => {
  test("renderClipList appends an overlays section with timeline span, position, and size", () => {
    const state = withOverlay(1, { at: 5, inPoint: 0, outPoint: 10, anchor: "bottom-right", x: 0.97, y: 0.97, scale: 0.3 });
    const out = strip(renderClipList(state));
    assert.match(out, /overlays/);
    assert.match(out, /\[o1\] +clip1\.mp4 +0:05 → 0:15 +bottom-right @ 97%,97% +· +30% wide/);
  });

  test("renderClipList omits the section when there are no overlays", () => {
    assert.doesNotMatch(strip(renderClipList(makeState(1))), /overlays/);
  });

  test("renderPlanForConfirmation describes overlay operations in human terms", () => {
    const state = withOverlay(1);
    const oid = overlaysOf(state.timeline)[0]!.id;
    const plan = renderPlanForConfirmation(state, {
      summary: "pip",
      operations: [
        { type: "addOverlay", sourceId: state.sources[0]!.id, at: 3, anchor: "bottom-left", x: 0.03, y: 0.97, scale: 0.3 },
        { type: "updateOverlay", overlayId: oid, scale: 0.5 },
        { type: "removeOverlay", overlayId: oid },
      ],
    });
    assert.equal(plan.renderedLines[0], "Overlay clip1.mp4 → at 0:03, bottom-left @ 3%,97%, 30% wide");
    assert.equal(plan.renderedLines[1], "Adjust overlay [o1] clip1.mp4 → 50% wide");
    assert.equal(plan.renderedLines[2], "Remove overlay [o1] clip1.mp4");
  });

  test("query_timeline exposes sources and the overlay track", async () => {
    const state = withOverlay(1, { at: 2, inPoint: 1, outPoint: 4 });
    const r = await queryTimeline.execute(state, {});
    assert.ok(r.ok);
    assert.equal(r.result.sources.length, 1);
    assert.equal(r.result.sources[0]!.id, state.sources[0]!.id);
    assert.equal(r.result.overlays.length, 1);
    assert.deepEqual(
      [r.result.overlays[0]!.ref, r.result.overlays[0]!.at, r.result.overlays[0]!.duration, r.result.overlays[0]!.anchor],
      ["o1", 2, 3, "top-right"],
    );
  });
});

// ── End to end with the real FFmpeg (skipped when it isn't installed) ─────────

function hasFfmpeg(): boolean {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe("exportTimeline with overlays (real ffmpeg)", { skip: !hasFfmpeg() && "ffmpeg not installed" }, () => {
  test("composites a picture-in-picture onto the trimmed main track", async () => {
    const assets = join(originalCwd, "test-assets");
    const base = join(assets, "test.mp4");
    const pip = join(assets, "test_trimmed.mp4");
    if (!existsSync(base) || !existsSync(pip)) return;   // assets absent in this checkout

    const { probeFile } = await import("../media/probe.js");
    const baseInfo = await probeFile(base);
    const pipInfo = await probeFile(pip);
    assert.ok(baseInfo.ok && pipInfo.ok);

    let state = createProject("e2e");
    const added = addSource(state, baseInfo.data);
    assert.ok(added.ok);
    state = added.state;
    const clipId = state.timeline.headId!;
    const shaped = applyOperations(state, [
      { type: "trim", clipId, inPoint: 0, outPoint: 2 },
      { type: "addOverlayFromFile", mediaInfo: pipInfo.data, at: 0.5, inPoint: 0, outPoint: 1, anchor: "bottom-right", x: 0.97, y: 0.97, scale: 0.3 },
    ]);
    assert.ok(shaped.ok);

    const out = join(workRoot, "e2e-out.mp4");
    const r = await exportTimeline(shaped.state, out);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.overlayCount, 1);
    assert.ok(r.outputSize > 0);
    const outInfo = await probeFile(out);
    assert.ok(outInfo.ok);
    assert.equal(outInfo.data.width, baseInfo.data.width, "overlay never changes the frame size");
    assert.equal(outInfo.data.height, baseInfo.data.height);
    assert.ok(Math.abs(outInfo.data.duration - 2) < 0.2, `duration ${outInfo.data.duration} ≈ 2s`);
    assert.ok(outInfo.data.audioCodec, "base audio is carried over");
  });
});

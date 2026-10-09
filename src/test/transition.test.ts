import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  layoutTimeline, timelineDuration, clipsInOrder, TRANSITION_TYPES,
  type ProjectState, type MutationResult,
} from "../project/types.js";
import { addSource, trimClip, splitClip, setTransition, removeTransition, setFade } from "../project/mutations.js";
import { applyPlan, applyOperations, createSession, undoSession } from "../project/session.js";
import { createProject, saveProject, loadProject } from "../project/io.js";
import { buildJoinFilter, buildJoinArgs, joinNeedsFilter, EXPORT_ENCODE } from "../engine/ffmpeg.js";
import type { JoinSegment } from "../engine/types.js";
import { renderPreviewFromSegments, type FfmpegRunner, type PreviewSegment } from "../engine/preview.js";
import { segmentsForScope, previewStateScope } from "../repl/commands/preview.js";
import { overlayLayersFor } from "../engine/layers.js";
import { addOverlay } from "../project/mutations.js";
import { runTransitionCommand, runFadeCommand, parseTransitionType } from "../repl/commands/transition.js";
import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { renderTimeline } from "../display/timeline.js";
import { renderPlanForConfirmation, AgentOperationSchema } from "../agent/propose_edit_plan.js";
import { queryTimeline } from "../agent/tools/query_timeline.js";
import { exportTimeline } from "../engine/export.js";
import { stripAnsi } from "../ui/theme.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let workRoot: string;
const originalCwd = process.cwd();

before(() => {
  workRoot = mkdtempSync(join(tmpdir(), "cutcli-transition-test-"));
  process.chdir(workRoot);   // dispatch persists .cutcli.json to the CWD
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

/** n clips, each trimmed to `len` seconds of its own source (clip1.mp4 …). */
function makeState(n: number, len = 10, extra: Partial<MediaInfo>[] = []): ProjectState {
  let state = createProject("test");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({ filePath: `/fake/clip${i + 1}.mp4`, fileName: `clip${i + 1}.mp4`, ...(extra[i] ?? {}) }));
    assert.ok(r.ok);
    state = r.state;
    const id = clipsInOrder(state.timeline)[i]!.id;
    const t = trimClip(state, id, { inPoint: 0, outPoint: len });
    assert.ok(t.ok);
    state = t.state;
  }
  return state;
}

const ids = (s: ProjectState) => clipsInOrder(s.timeline).map((c) => c.id);
/** Unwrap a MutationResult, failing the test with the mutation's own error. */
function ok(r: MutationResult): ProjectState {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.state;
}
const strip = stripAnsi;

// ── Model & layout ────────────────────────────────────────────────────────────

describe("timeline layout with transitions", () => {
  test("a plain cut timeline lays out as a running sum", () => {
    const l = layoutTimeline(makeState(3).timeline);
    assert.deepEqual(l.clips.map((p) => [p.start, p.end]), [[0, 10], [10, 20], [20, 30]]);
    assert.equal(l.duration, 30);
    assert.ok(l.clips.every((p) => p.transitionOut === null && p.fadeIn === 0 && p.fadeOut === 0));
  });

  test("a crossfade overlaps the next clip and shortens the timeline", () => {
    let state = makeState(3);
    const [a, b] = ids(state);
    state = ok(setTransition(state, a!, { duration: 2 }));
    state = ok(setTransition(state, b!, { type: "wipeleft", duration: 1 }));
    const l = layoutTimeline(state.timeline);
    assert.deepEqual(l.clips.map((p) => [p.start, p.end]), [[0, 10], [8, 18], [17, 27]]);
    assert.equal(l.duration, 27);
    assert.deepEqual(l.clips[0]!.transitionOut, { type: "fade", duration: 2 });
    assert.deepEqual(l.clips[1]!.transitionOut, { type: "wipeleft", duration: 1 });
    assert.equal(timelineDuration(state.timeline), 27);
  });

  test("effective values clamp to what the clips can give; a tail transition is ignored", () => {
    let state = makeState(2);
    const [a, b] = ids(state);
    state = ok(setTransition(state, a!, { duration: 4 }));
    // Trim the second clip down to 1s after the fact: the transition can't exceed it.
    state = ok(trimClip(state, b!, { inPoint: 0, outPoint: 1 }));
    let l = layoutTimeline(state.timeline);
    assert.equal(l.clips[0]!.transitionOut!.duration, 1);
    assert.equal(l.duration, 10);
    // A stored transition on the tail clip has nothing to lead into.
    state = { ...state, timeline: { ...state.timeline, clips: { ...state.timeline.clips, [b!]: { ...state.timeline.clips[b!]!, transitionOut: { type: "fade", duration: 1 } } } } };
    l = layoutTimeline(state.timeline);
    assert.equal(l.clips[1]!.transitionOut, null);
    // Fades that overflow the clip scale down together.
    const fades = { ...state.timeline.clips[b!]!, fadeIn: 1, fadeOut: 1 };
    l = layoutTimeline({ ...state.timeline, clips: { ...state.timeline.clips, [b!]: fades } });
    assert.equal(l.clips[1]!.fadeIn + l.clips[1]!.fadeOut, 1);
  });
});

describe("transition & fade mutations", () => {
  test("setTransition validates type, duration, room, and the need for a next clip", () => {
    const state = makeState(2, 5);
    const [a, b] = ids(state);
    const bad = (clip: string, t: { type?: never; duration: number } | { type: string; duration: number }, re: RegExp) => {
      const r = setTransition(state, clip, t as never);
      assert.ok(!r.ok);
      assert.match(r.error, re);
    };
    bad(a!, { duration: 0 }, /must be positive/);
    bad(a!, { duration: 6 }, /longer than the shorter of the two clips/);
    bad(a!, { type: "swoosh", duration: 1 }, /Unknown transition/);
    bad(b!, { duration: 1 }, /last on the timeline/);
    assert.ok(!setTransition(state, "nope", { duration: 1 }).ok);
    const ok = setTransition(state, a!, { duration: 5 });   // exactly the room is fine
    assert.ok(ok.ok);
    assert.deepEqual(ok.state.timeline.clips[a!]!.transitionOut, { type: "fade", duration: 5 });
  });

  test("a crossfade and a fade on the same edge conflict in both directions", () => {
    let state = makeState(2);
    const [a, b] = ids(state);
    const faded = setFade(state, a!, "out", 1);
    assert.ok(faded.ok);
    const conflict = setTransition(faded.state, a!, { duration: 1 });
    assert.ok(!conflict.ok);
    assert.match(conflict.error, /already fades out/);

    const fadedIn = setFade(state, b!, "in", 1);
    assert.ok(fadedIn.ok);
    const conflict2 = setTransition(fadedIn.state, a!, { duration: 1 });
    assert.ok(!conflict2.ok);
    assert.match(conflict2.error, /next clip fades in/);

    state = ok(setTransition(state, a!, { duration: 1 }));
    const c3 = setFade(state, a!, "out", 1);
    assert.ok(!c3.ok && /transitions into the next/.test(c3.error));
    const c4 = setFade(state, b!, "in", 1);
    assert.ok(!c4.ok && /previous clip transitions/.test(c4.error));
    // Clearing a fade (0) is always allowed.
    assert.ok(setFade(state, a!, "out", 0).ok);
  });

  test("setFade validates and clears with 0; removeTransition restores a cut", () => {
    let state = makeState(1, 4);
    const [a] = ids(state);
    assert.ok(!setFade(state, a!, "in", -1).ok);
    const tooLong = setFade(ok(setFade(state, a!, "in", 3)), a!, "out", 2);
    assert.ok(!tooLong.ok && /exceed the clip/.test(tooLong.error));
    state = ok(setFade(state, a!, "in", 1));
    assert.equal(state.timeline.clips[a!]!.fadeIn, 1);
    state = ok(setFade(state, a!, "in", 0));
    assert.equal(state.timeline.clips[a!]!.fadeIn, undefined);

    let two = makeState(2);
    const [x] = ids(two);
    two = ok(setTransition(two, x!, { duration: 1 }));
    two = ok(removeTransition(two, x!));
    assert.equal(two.timeline.clips[x!]!.transitionOut, undefined);
    assert.ok(!removeTransition(two, "nope").ok);
  });

  test("split: the fade-in stays with the first half, the out-edge effects go to the second", () => {
    let state = makeState(2);
    const [a] = ids(state);
    state = ok(setTransition(state, a!, { duration: 1 }));
    state = ok(setFade(state, a!, "in", 0.5));
    state = ok(splitClip(state, a!, 5));
    const [first, second] = clipsInOrder(state.timeline);
    assert.equal(first!.fadeIn, 0.5);
    assert.equal(first!.transitionOut, undefined);
    assert.equal(second!.fadeIn, undefined);
    assert.deepEqual(second!.transitionOut, { type: "fade", duration: 1 });
  });

  test("operations flow through applyPlan with undo; the agent vocabulary includes them", () => {
    const state = makeState(2);
    const [a, b] = ids(state);
    const r = applyPlan(createSession(state), "edges", [
      { type: "setTransition", clipId: a!, duration: 1.5, transitionType: "slideleft" },
      { type: "setFade", clipId: a!, edge: "in", duration: 0.5 },
      { type: "setFade", clipId: b!, edge: "out", duration: 0.5 },
    ]);
    assert.ok(r.ok);
    assert.equal(timelineDuration(r.session.state.timeline), 18.5);
    const undone = undoSession(r.session);
    assert.ok(undone.ok && timelineDuration(undone.session.state.timeline) === 20);

    const broken = applyOperations(state, [{ type: "setTransition", clipId: b!, duration: 1 }]);
    assert.ok(!broken.ok);

    assert.ok(AgentOperationSchema.safeParse({ type: "setTransition", clipId: "c", duration: 1 }).success);
    assert.ok(AgentOperationSchema.safeParse({ type: "setTransition", clipId: "c", duration: 1, transitionType: "circleopen" }).success);
    assert.ok(!AgentOperationSchema.safeParse({ type: "setTransition", clipId: "c", duration: 1, transitionType: "swoosh" }).success);
    assert.ok(AgentOperationSchema.safeParse({ type: "removeTransition", clipId: "c" }).success);
    assert.ok(AgentOperationSchema.safeParse({ type: "setFade", clipId: "c", edge: "out", duration: 0 }).success);
    assert.ok(!AgentOperationSchema.safeParse({ type: "setFade", clipId: "c", edge: "sideways", duration: 1 }).success);
  });

  test("edge effects persist through save/load", async () => {
    let state = makeState(2);
    const [a, b] = ids(state);
    state = ok(setTransition(state, a!, { type: "radial", duration: 2 }));
    state = ok(setFade(state, b!, "out", 1));
    const file = join(workRoot, "edges.json");
    await saveProject(createSession(state), file);
    const loaded = await loadProject(file);
    assert.deepEqual(loaded.state.timeline.clips[a!]!.transitionOut, { type: "radial", duration: 2 });
    assert.equal(loaded.state.timeline.clips[b!]!.fadeOut, 1);
  });
});

// ── FFmpeg join ───────────────────────────────────────────────────────────────

const seg = (over: Partial<JoinSegment> = {}): JoinSegment => ({ path: "/tmp/s.mp4", duration: 10, hasAudio: true, ...over });
const target = { width: 1280, height: 720, fps: 24 };

describe("join filter", () => {
  test("joinNeedsFilter is false for plain cuts and true for any fade or non-tail transition", () => {
    assert.equal(joinNeedsFilter([seg(), seg()]), false);
    assert.equal(joinNeedsFilter([seg(), seg({ transitionOut: { type: "fade", duration: 1 } })]), false, "tail transition is moot");
    assert.equal(joinNeedsFilter([seg({ transitionOut: { type: "fade", duration: 1 } }), seg()]), true);
    assert.equal(joinNeedsFilter([seg({ fadeOut: 0.5 })]), true);
    assert.equal(joinNeedsFilter([seg({ fadeIn: 0 })]), false);
  });

  test("normalizes every input, applies edge fades, and folds xfade/concat left to right", () => {
    const { filter, audio } = buildJoinFilter([
      seg({ path: "/a", duration: 4, fadeIn: 0.5, transitionOut: { type: "wipeleft", duration: 1 } }),
      seg({ path: "/b", duration: 6, transitionOut: null }),
      seg({ path: "/c", duration: 3, fadeOut: 0.5 }),
    ], target);
    assert.equal(audio, true);
    const parts = filter.split(";");
    assert.match(parts[0]!, /^\[0:v\]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1,fps=24,format=yuv420p,settb=AVTB,fade=t=in:st=0:d=0\.5\[v0\]$/);
    assert.match(parts[1]!, /^\[0:a\]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0\.5\[a0\]$/);
    assert.match(parts[4]!, /fade=t=out:st=2\.5:d=0\.5\[v2\]$/);
    assert.match(parts[5]!, /afade=t=out:st=2\.5:d=0\.5\[a2\]$/);
    // 4s + 6s with a 1s overlap: offset 3, running length 9; then a hard concat.
    assert.equal(parts[6], "[v0][v1]xfade=transition=wipeleft:duration=1:offset=3[vj1]");
    assert.equal(parts[7], "[a0][a1]acrossfade=d=1:c1=tri:c2=tri[aj1]");
    assert.equal(parts[8], "[vj1][v2]concat=n=2:v=1:a=0[vout]");
    assert.equal(parts[9], "[aj1][a2]concat=n=2:v=0:a=1[aout]");
  });

  test("a single faded segment maps straight to the output pads; silent inputs skip audio", () => {
    const one = buildJoinFilter([seg({ fadeOut: 1 })], target);
    assert.match(one.filter, /fade=t=out:st=9:d=1\[vout\]/);
    assert.match(one.filter, /\[aout\]/);
    const silent = buildJoinFilter([seg({ hasAudio: false, fadeIn: 1 }), seg({ hasAudio: false })], target);
    assert.equal(silent.audio, false);
    assert.doesNotMatch(silent.filter, /\[\d:a\]/);
    assert.doesNotMatch(silent.filter, /aout/);
  });

  test("buildJoinArgs lists inputs in order and maps audio only when present", () => {
    const args = buildJoinArgs({ type: "join", output: "/o.mp4", segments: [seg({ path: "/a" }), seg({ path: "/b", hasAudio: true })] }, target);
    assert.deepEqual(args.slice(0, 4), ["-i", "/a", "-i", "/b"]);
    assert.ok(args.includes("[aout]"));
    assert.equal(args[args.indexOf("-crf") + 1], String(EXPORT_ENCODE.crf));
    const silent = buildJoinArgs({ type: "join", output: "/o.mp4", segments: [seg({ hasAudio: false })] }, target);
    assert.ok(!silent.includes("[aout]") && !silent.includes("-c:a"));
  });
});

// ── Preview: scoping and rendering ────────────────────────────────────────────

describe("preview scoping with transitions", () => {
  function edgeState(): ProjectState {
    // clip1 0–10 (fade in 1s) ⇢ 2s crossfade ⇢ clip2 8–18 ⇢ cut ⇢ clip3 18–28 (fade out 1s)
    let state = makeState(3);
    const [a, , c] = ids(state);
    state = ok(setTransition(state, a!, { duration: 2 }));
    state = ok(setFade(state, a!, "in", 1));
    state = ok(setFade(state, c!, "out", 1));
    return state;
  }

  test("timeline scope carries each clip's effects and audio presence", () => {
    const r = segmentsForScope(edgeState(), { type: "timeline" });
    assert.ok(r.ok);
    assert.deepEqual(r.window, { start: 0, end: 28 });
    assert.deepEqual(r.segments[0]!.effects, { hasAudio: true, fadeIn: 1, transitionOut: { type: "fade", duration: 2 } });
    assert.deepEqual(r.segments[1]!.effects, { hasAudio: true });
    assert.deepEqual(r.segments[2]!.effects, { hasAudio: true, fadeOut: 1 });
  });

  test("a plain timeline keeps the bare segment shape", () => {
    const r = segmentsForScope(makeState(2), { type: "timeline" });
    assert.ok(r.ok);
    assert.deepEqual(r.segments, [{ input: "/fake/clip1.mp4", start: 0, end: 10 }, { input: "/fake/clip2.mp4", start: 0, end: 10 }]);
  });

  test("clip scope keeps its fades but not its out-transition; window is its timeline span", () => {
    const state = edgeState();
    const r = segmentsForScope(state, { type: "clip", ref: "1" });
    assert.ok(r.ok);
    assert.deepEqual(r.segments[0]!.effects, { hasAudio: true, fadeIn: 1 });
    const r2 = segmentsForScope(state, { type: "clip", ref: "2" });
    assert.ok(r2.ok);
    assert.deepEqual(r2.window, { start: 8, end: 18 });
  });

  test("range scope includes both sides of an overlap and keeps the transition between them", () => {
    const state = edgeState();
    // 5–15: clip1 from 5 to its end (10), clip2 from its start (8) to 15 → 2s crossfade kept.
    const r = segmentsForScope(state, { type: "range", start: 5, end: 15 });
    assert.ok(r.ok);
    assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[5, 10], [0, 7]]);
    assert.deepEqual(r.segments[0]!.effects, { hasAudio: true, transitionOut: { type: "fade", duration: 2 } });
    assert.equal(r.segments[0]!.effects!.fadeIn, undefined, "the range cut into the clip, so no fade in");
    assert.deepEqual(r.window, { start: 5, end: 15 });
    const joined = r.segments.reduce((s, x) => s + (x.end - x.start), 0) - 2;
    assert.equal(joined, 10, "rendered length equals the requested window");

    // A range that ends inside clip1 never reaches clip2: no transition attached.
    const r2 = segmentsForScope(state, { type: "range", start: 0, end: 6 });
    assert.ok(r2.ok);
    assert.equal(r2.segments.length, 1);
    assert.deepEqual(r2.segments[0]!.effects, { hasAudio: true, fadeIn: 1 });
  });

  test("overlays are placed in the transitioned timeline", () => {
    let state = edgeState();
    state = ok(addOverlay(state, state.sources[1]!.id, { at: 17, inPoint: 0, outPoint: 4 }));
    // Clip 3 starts at 18 in the transitioned timeline, so the overlay is 1s before it.
    const r = overlayLayersFor(state, { start: 18, end: 28 });
    assert.ok(r.ok);
    assert.deepEqual([r.layers[0]!.at, r.layers[0]!.inPoint, r.layers[0]!.outPoint], [0, 1, 4]);
  });

  test("mixed audio presence is rejected before FFmpeg runs", async () => {
    let state = makeState(2, 10, [{}, { audioCodec: null }]);
    const [a] = ids(state);
    state = ok(setTransition(state, a!, { duration: 1 }));
    const segs = segmentsForScope(state, { type: "timeline" });
    assert.ok(segs.ok);
    const dir = mkdtempSync(join(workRoot, "mix-"));
    const r = await renderPreviewFromSegments(segs.segments, { workDir: dir, ffmpeg: async () => ({ ok: true }) });
    assert.ok(!r.ok && /every clip to have audio/.test(r.error));
  });
});

describe("renderPreviewFromSegments with transitions", () => {
  function mockFfmpeg() {
    const calls: string[][] = [];
    const runner: FfmpegRunner = async (args, opts) => {
      calls.push(args);
      await writeFile(args[args.length - 1]!, "rendered");
      opts?.onOutTime?.(2);
      return { ok: true };
    };
    return { runner, calls };
  }

  test("uses the filter join (preview knobs) instead of the stream copy, probing the segments", async () => {
    const dir = mkdtempSync(join(workRoot, "pv-"));
    const src = join(dir, "src.mp4");
    writeFileSync(src, "dummy");
    const { runner, calls } = mockFfmpeg();
    const probed: string[] = [];
    const progress: number[] = [];
    const segments: PreviewSegment[] = [
      { input: src, start: 0, end: 4, effects: { hasAudio: true, transitionOut: { type: "fade", duration: 1 } } },
      { input: src, start: 4, end: 8, effects: { hasAudio: true, fadeOut: 0.5 } },
    ];
    const r = await renderPreviewFromSegments(segments, {
      ffmpeg: runner, workDir: dir,
      probe: async (f) => { probed.push(f); return { width: 854, height: 480, fps: 24 }; },
      onProgress: (p) => progress.push(p),
    });
    assert.ok(r.ok);
    assert.equal(calls.length, 3, "two trims + one join");
    const joinArgs = calls[2]!;
    assert.ok(joinArgs.includes("-filter_complex"));
    assert.match(joinArgs[joinArgs.indexOf("-filter_complex") + 1]!, /xfade=transition=fade:duration=1:offset=3/);
    assert.equal(joinArgs[joinArgs.indexOf("-preset") + 1], "ultrafast");
    assert.equal(probed.length, 2, "every trimmed segment is probed; the largest sets the target");
    assert.ok(probed.every((p) => p.endsWith(".mp4") && p.includes("segments")));
    assert.equal(progress[progress.length - 1], 100);
    assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]!), "monotonic");
  });

  test("previewStateScope threads effects through to the renderer", async () => {
    let state = makeState(2);
    state = ok(setFade(state, ids(state)[0]!, "in", 1));
    let seen: PreviewSegment[] = [];
    await previewStateScope(state, { type: "timeline" }, {
      render: async (segs) => { seen = segs; return { ok: true, path: "/tmp/p.mp4", cachedSegments: 0, renderedSegments: 2 }; },
      open: async () => ({ launched: true }),
    });
    assert.equal(seen[0]!.effects!.fadeIn, 1);
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("/transition and /fade commands", () => {
  test("parseTransitionType accepts every xfade name plus friendly aliases", () => {
    for (const t of TRANSITION_TYPES) assert.equal(parseTransitionType(t), t);
    assert.equal(parseTransitionType("crossfade"), "fade");
    assert.equal(parseTransitionType("Dissolve"), "fade");
    assert.equal(parseTransitionType("black"), "fadeblack");
    assert.throws(() => parseTransitionType("swoosh"), /Unknown transition type/);
  });

  test("/transition <clip> [duration] [type] in either order; none restores the cut", () => {
    let session = createSession(makeState(3));
    let r = runTransitionCommand(["1"], session);
    assert.ok(!r.isError, r.output);
    session = r.session!;
    assert.deepEqual(session.state.timeline.clips[ids(session.state)[0]!]!.transitionOut, { type: "fade", duration: 1 });
    assert.match(strip(r.output), /Transition \[1\] → \[2\]: fade 1s.*timeline now 0:29/);

    r = runTransitionCommand(["2", "wipeleft", "0.5"], session);
    assert.ok(!r.isError, r.output);
    session = r.session!;
    assert.deepEqual(session.state.timeline.clips[ids(session.state)[1]!]!.transitionOut, { type: "wipeleft", duration: 0.5 });

    r = runTransitionCommand(["1", "none"], session);
    assert.ok(!r.isError);
    session = r.session!;
    assert.equal(session.state.timeline.clips[ids(session.state)[0]!]!.transitionOut, undefined);
    assert.match(r.output, /hard cut/);
    const again = runTransitionCommand(["1", "none"], session);
    assert.ok(!again.isError && again.session === undefined, "no-op leaves the session alone");

    assert.ok(runTransitionCommand(["3", "1"], session).isError, "tail clip");
    assert.match(runTransitionCommand(["9"], session).output, /not found/);
    assert.match(runTransitionCommand(["1", "swoosh"], session).output, /Unknown transition type/);
    assert.match(runTransitionCommand([], session).output, /Usage/);
    assert.equal(session.undo.length, 3);
  });

  test("/transition all applies to every cut, clamping to short clips; all none removes them", () => {
    let state = makeState(3);
    state = ok(trimClip(state, ids(state)[1]!, { inPoint: 0, outPoint: 1 }));   // clip 2 is 1s
    let r = runTransitionCommand(["all", "2"], createSession(state));
    assert.ok(!r.isError, r.output);
    const l = layoutTimeline(r.session!.state.timeline);
    assert.equal(l.clips[0]!.transitionOut!.duration, 1);
    assert.equal(l.clips[1]!.transitionOut!.duration, 1);
    assert.match(strip(r.output), /2 cuts.*2 shortened/);
    assert.match(strip(runTransitionCommand(["list"], r.session!).output), /\[1\] → \[2\] fade 1s/);

    r = runTransitionCommand(["all", "none"], r.session!);
    assert.ok(!r.isError);
    assert.ok(layoutTimeline(r.session!.state.timeline).clips.every((p) => p.transitionOut === null));
    assert.match(runTransitionCommand(["all", "none"], r.session!).output, /No transitions/);
    assert.match(runTransitionCommand(["list"], r.session!).output, /hard cut/);
    assert.ok(runTransitionCommand(["all"], createSession(makeState(1))).isError);
  });

  test("/fade addresses a clip or the first/last shorthand; 0 or none clears", () => {
    let session = createSession(makeState(3));
    let r = runFadeCommand(["in"], session);
    assert.ok(!r.isError, r.output);
    session = r.session!;
    assert.equal(session.state.timeline.clips[ids(session.state)[0]!]!.fadeIn, 1);
    assert.match(r.output, /Fade in on \[1\]/);

    r = runFadeCommand(["out", "2.5"], session);
    session = r.session!;
    assert.equal(session.state.timeline.clips[ids(session.state)[2]!]!.fadeOut, 2.5);

    r = runFadeCommand(["2", "out", "0:01"], session);
    session = r.session!;
    assert.equal(session.state.timeline.clips[ids(session.state)[1]!]!.fadeOut, 1);

    r = runFadeCommand(["2", "out", "none"], session);
    session = r.session!;
    assert.equal(session.state.timeline.clips[ids(session.state)[1]!]!.fadeOut, undefined);
    assert.match(r.output, /Removed fade out/);

    assert.match(runFadeCommand(["2", "sideways"], session).output, /Usage/);
    assert.match(runFadeCommand(["9", "in"], session).output, /not found/);
    assert.match(runFadeCommand(["2", "in", "-1"], session).output, /Error/);
    assert.ok(runFadeCommand(["in"], createSession(createProject("empty"))).isError);
  });
});

describe("dispatch, display, and agent surface", () => {
  const noProject: ReplState = { session: null, messages: [], autoApprove: false };

  test("/transition and /fade need a project; a change persists and leaves a continuity note", async () => {
    assert.match((await dispatch("/transition 1", noProject)).output, /No project open/);
    assert.match((await dispatch("/fade in", noProject)).output, /No project open/);

    const state: ReplState = { session: createSession(makeState(2)), messages: [], autoApprove: false };
    const r = await dispatch("/transition 1 0.5 circleopen", state);
    assert.ok(!r.isError, r.output);
    assert.equal(r.newState!.messages.length, 1);
    const note = r.newState!.messages[0]!.content[0];
    assert.ok(note && note.type === "text" && /via slash command: Transition \[1\] → \[2\]: circleopen 0\.5s/.test(note.text));
    assert.ok(existsSync(join(workRoot, ".cutcli.json")));

    const list = await dispatch("/transition list", r.newState!);
    assert.equal(list.newState, undefined, "read-only");
    const help = await dispatch("/help", noProject);
    assert.match(strip(help.output), /\/transition <clip\|all>/);
    assert.match(strip(help.output), /\/fade \[clip\] in\|out/);
  });

  test("the clip list tags edges and the timeline bar marks transitions and the shortened total", () => {
    let state = makeState(2);
    const [a, b] = ids(state);
    state = ok(setTransition(state, a!, { type: "wipeleft", duration: 2 }));
    state = ok(setFade(state, a!, "in", 0.5));
    state = ok(setFade(state, b!, "out", 1));
    const list = strip(renderClipList(state));
    assert.match(list, /\[1\].*◐ in 0\.5s\s+╪ wipeleft 2s/);
    assert.match(list, /\[2\].*◐ out 1s/);
    const bar = strip(renderTimeline(state, 80));
    assert.match(bar, /Total: 0:18/);
    assert.match(bar, /╪ clip2\.mp4/);
    const plain = strip(renderTimeline(makeState(2), 80));
    assert.doesNotMatch(plain, /╪/);
    assert.match(plain, /Total: 0:20/);
  });

  test("renderPlanForConfirmation and query_timeline describe edges", async () => {
    let state = makeState(2);
    const [a, b] = ids(state);
    const plan = renderPlanForConfirmation(state, {
      summary: "s",
      operations: [
        { type: "setTransition", clipId: a!, duration: 1.5 },
        { type: "removeTransition", clipId: a! },
        { type: "setFade", clipId: b!, edge: "out", duration: 2 },
        { type: "setFade", clipId: b!, edge: "in", duration: 0 },
      ],
    });
    assert.deepEqual(plan.renderedLines, [
      "Transition clip [1] clip1.mp4 → fade 1.5s into [2]",
      "Cut clip [1] clip1.mp4 → hard cut into the next clip",
      "Fade clip [2] clip2.mp4 → out 2s",
      "Unfade clip [2] clip2.mp4 → remove fade in",
    ]);

    state = ok(setTransition(state, a!, { duration: 3 }));
    state = ok(setFade(state, b!, "out", 1));
    const q = await queryTimeline.execute(state, {});
    assert.ok(q.ok);
    assert.equal(q.result.totalDuration, 17);
    assert.deepEqual(q.result.clips.map((c) => c.timelineStart), [0, 7]);
    assert.deepEqual(q.result.clips[0]!.transitionOut, { type: "fade", duration: 3 });
    assert.equal(q.result.clips[1]!.fadeOut, 1);
  });
});

// ── End to end with the real FFmpeg (skipped when it isn't installed) ─────────

function hasFfmpeg(): boolean {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe("exportTimeline with transitions (real ffmpeg)", { skip: !hasFfmpeg() && "ffmpeg not installed" }, () => {
  test("crossfade + fades produce a file of the transitioned length", async () => {
    const assets = join(originalCwd, "test-assets");
    const a = join(assets, "test.mp4");
    const b = join(assets, "test_trimmed.mp4");
    if (!existsSync(a) || !existsSync(b)) return;
    const { probeFile } = await import("../media/probe.js");
    const ia = await probeFile(a);
    const ib = await probeFile(b);
    assert.ok(ia.ok && ib.ok);

    let state = createProject("e2e");
    state = ok(addSource(state, ia.data));
    state = ok(addSource(state, ib.data));
    const [c1, c2] = ids(state);
    const shaped = applyOperations(state, [
      { type: "trim", clipId: c1!, inPoint: 0, outPoint: 2 },
      { type: "trim", clipId: c2!, inPoint: 1, outPoint: 3 },
      { type: "setTransition", clipId: c1!, duration: 1, transitionType: "wipeleft" },
      { type: "setFade", clipId: c1!, edge: "in", duration: 0.5 },
      { type: "setFade", clipId: c2!, edge: "out", duration: 0.5 },
    ]);
    assert.ok(shaped.ok);

    const out = join(workRoot, "e2e-transitions.mp4");
    const r = await exportTimeline(shaped.state, out);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.duration, 3);
    const info = await probeFile(out);
    assert.ok(info.ok);
    assert.ok(Math.abs(info.data.duration - 3) < 0.2, `duration ${info.data.duration} ≈ 3s (2 + 2 − 1)`);
    assert.ok(info.data.audioCodec, "audio survives the join");
    assert.equal(info.data.width, ia.data.width);
  });
});

// ── Mixed-format sources: conform instead of stream-copy ──────────────────────

import { formatsMatch } from "../engine/ffmpeg.js";

describe("mixed source formats", () => {
  test("formatsMatch compares size and frame rate", () => {
    assert.equal(formatsMatch([{ width: 854, height: 480, fps: 60 }, { width: 854, height: 480, fps: 60 }]), true);
    assert.equal(formatsMatch([{ width: 854, height: 480, fps: 59.94 }, { width: 854, height: 480, fps: 60 }]), false);
    assert.equal(formatsMatch([{ width: 854, height: 480, fps: 60 }, { width: 742, height: 480, fps: 60 }]), false);
    assert.equal(formatsMatch([]), true);
  });

  test("a plain cut timeline of mismatched segments is joined through the conforming filter", async () => {
    const dir = mkdtempSync(join(workRoot, "mixed-"));
    const src = join(dir, "src.mp4");
    writeFileSync(src, "dummy");
    const calls: string[][] = [];
    const runner: FfmpegRunner = async (args) => { calls.push(args); await writeFile(args[args.length - 1]!, "x"); return { ok: true }; };
    const sizes = [{ width: 854, height: 480, fps: 59.94, hasAudio: true }, { width: 742, height: 480, fps: 15.5, hasAudio: true }];
    // Answer by file, in first-seen order: the first segment is probed again
    // as the join target and must report the same size.
    const seen: string[] = [];
    const probe = async (f: string) => {
      if (!seen.includes(f)) seen.push(f);
      return sizes[Math.min(seen.indexOf(f), 1)]!;
    };
    const r = await renderPreviewFromSegments(
      [{ input: src, start: 0, end: 4 }, { input: src, start: 4, end: 8 }],
      { ffmpeg: runner, workDir: dir, probe },
    );
    assert.ok(r.ok);
    const joinArgs = calls[calls.length - 1]!;
    assert.ok(joinArgs.includes("-filter_complex"), "conformed, not stream-copied");
    const graph = joinArgs[joinArgs.indexOf("-filter_complex") + 1]!;
    assert.match(graph, /concat=n=2:v=1/);
    assert.match(graph, /scale=854:480/);
  });

  test("matching segments still take the fast stream copy", async () => {
    const dir = mkdtempSync(join(workRoot, "same-"));
    const src = join(dir, "src.mp4");
    writeFileSync(src, "dummy");
    const calls: string[][] = [];
    const runner: FfmpegRunner = async (args) => { calls.push(args); await writeFile(args[args.length - 1]!, "x"); return { ok: true }; };
    const r = await renderPreviewFromSegments(
      [{ input: src, start: 0, end: 4 }, { input: src, start: 4, end: 8 }],
      { ffmpeg: runner, workDir: dir, probe: async () => ({ width: 854, height: 480, fps: 60 }) },
    );
    assert.ok(r.ok);
    assert.deepEqual(calls[calls.length - 1]!.slice(0, 2), ["-f", "concat"]);
  });
});

// ── Conform target: never downscale to a smaller first clip ───────────────────

import { conformTarget } from "../engine/ffmpeg.js";

describe("conform target", () => {
  test("the join conforms to the largest segment and the highest frame rate, not the first", () => {
    assert.deepEqual(
      conformTarget([{ width: 1920, height: 1080, fps: 30 }, { width: 3840, height: 2160, fps: 59.94 }, { width: 3456, height: 2234, fps: 60 }]),
      { width: 3840, height: 2160, fps: 60 },
    );
    assert.deepEqual(conformTarget([{ width: 854, height: 480, fps: 0 }]), { width: 854, height: 480, fps: 30 });
  });
});

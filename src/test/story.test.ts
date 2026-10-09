import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clipsInOrder, overlaysOf, layoutTimeline, getClipDisplayRefs,
  type ProjectState, type MutationResult,
} from "../project/types.js";
import { addSource, insertClip, keepRanges, timelineTimeOf, addOverlay, updateOverlay, setFade, setTransition } from "../project/mutations.js";
import { applyOperations } from "../project/session.js";
import { createProject } from "../project/io.js";
import { buildOverlayFilter, computeOverlayPlacement } from "../engine/ffmpeg.js";
import { overlayLayersFor } from "../engine/layers.js";
import { exportTimeline } from "../engine/export.js";
import { normalizeBeats, MAX_VISUAL_BEATS } from "../agent/backends/gemini.js";
import { executeMapVisualBeats } from "../agent/tools/map_visual_beats.js";
import { evidenceFrom } from "../agent/evidence.js";
import { renderPlanForConfirmation, AgentOperationSchema } from "../agent/propose_edit_plan.js";
import { runOverlayCommand } from "../repl/commands/overlay.js";
import { createSession } from "../project/session.js";
import { renderClipList } from "../display/timeline-clip-list.js";
import { stripAnsi } from "../ui/theme.js";
import type { MediaInfo } from "../media/types.js";
import type { OverlayLayer } from "../engine/types.js";

let root: string;
before(() => { root = mkdtempSync(join(tmpdir(), "cutcli-story-test-")); });
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function media(name: string, duration: number, o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: `/fake/${name}`, fileName: name, duration,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1, bitrate: 1, containerFormat: "mp4", ...o,
  };
}
const ok = (r: MutationResult): ProjectState => { assert.ok(r.ok, r.ok ? "" : r.error); return r.state; };

/** The hackathon shape: a 143s call (spine), a son angle, a screen recording. */
function story(): { state: ProjectState; spine: string; son: string; screen: string } {
  let s = createProject("t");
  s = ok(addSource(s, media("elderly.MOV", 143.49)));
  s = ok(addSource(s, media("son.MOV", 138.59)));
  s = ok(addSource(s, media("computer_use.mov", 146.78, { width: 3456, height: 2234 })));
  const [a, b, c] = s.sources;
  return { state: s, spine: a!.id, son: b!.id, screen: c!.id };
}

// ── insertClip ────────────────────────────────────────────────────────────────

describe("insertClip", () => {
  test("puts a range of any source at an index, including head and tail, keeping the list linked", () => {
    const { state, screen, son } = story();
    let s = ok(insertClip(state, screen, 72, 75, 1, "home"));
    s = ok(insertClip(s, son, 53, 63, 0));
    s = ok(insertClip(s, screen, 117, 125, clipsInOrder(s.timeline).length));
    const order = clipsInOrder(s.timeline).map((c) => [c.label, c.inPoint, c.outPoint]);
    assert.deepEqual(order, [
      ["son.MOV", 53, 63], ["elderly.MOV", 0, 143.49], ["computer_use.mov", 72, 75],
      ["son.MOV", 0, 138.59], ["computer_use.mov", 0, 146.78], ["computer_use.mov", 117, 125],
    ]);
    assert.equal(s.timeline.headId, clipsInOrder(s.timeline)[0]!.id);
    assert.equal(s.timeline.tailId, clipsInOrder(s.timeline)[5]!.id);
    assert.ok(s.timeline.clips["home"], "named for later operations");
  });

  test("validates the source, range, index, and name", () => {
    const { state, screen } = story();
    const bad = (r: MutationResult, re: RegExp) => { assert.ok(!r.ok); assert.match(r.error, re); };
    bad(insertClip(state, "nope", 0, 1, 0), /Source not found/);
    bad(insertClip(state, screen, 5, 5, 0), /before out-point/);
    bad(insertClip(state, screen, 0, 999, 0), /exceeds source duration/);
    bad(insertClip(state, screen, 0, 1, 9), /out of range \(0–3\)/);
    const first = clipsInOrder(state.timeline)[0]!.id;
    bad(insertClip(state, screen, 0, 1, 0, first), /already in use/);
  });
});

// ── keepRanges ────────────────────────────────────────────────────────────────

describe("keepRanges", () => {
  test("turns one clip into back-to-back pieces of the kept ranges", () => {
    const { state } = story();
    const spine = clipsInOrder(state.timeline)[0]!;
    const s = ok(keepRanges(state, spine.id, [{ start: 0, end: 34.3 }, { start: 61.9, end: 67.4 }, { start: 121.8, end: 139.7 }]));
    const ordered = clipsInOrder(s.timeline);
    assert.deepEqual(ordered.slice(0, 3).map((c) => [c.inPoint, c.outPoint]), [[0, 34.3], [61.9, 67.4], [121.8, 139.7]]);
    assert.equal(ordered[0]!.id, spine.id, "the first piece keeps the clip's id");
    assert.equal(ordered[3]!.label, "son.MOV", "the rest of the timeline follows the last piece");
    const refs = [...getClipDisplayRefs(s.timeline).values()];
    assert.deepEqual(refs.slice(0, 3), ["1a", "1b", "1c"]);
    const kept = 34.3 + 5.5 + 17.9;
    assert.ok(Math.abs(layoutTimeline(s.timeline).clips[2]!.end - kept) < 1e-6);
  });

  test("edge effects follow their edge", () => {
    let { state } = story();
    const spine = clipsInOrder(state.timeline)[0]!.id;
    state = ok(setFade(state, spine, "in", 0.5));
    state = ok(setTransition(state, spine, { duration: 1 }));
    const s = ok(keepRanges(state, spine, [{ start: 0, end: 10 }, { start: 20, end: 30 }]));
    const [a, b] = clipsInOrder(s.timeline);
    assert.equal(a!.fadeIn, 0.5);
    assert.equal(a!.transitionOut, undefined);
    assert.equal(b!.fadeIn, undefined);
    assert.deepEqual(b!.transitionOut, { type: "fade", duration: 1 });
  });

  test("rejects ranges outside the clip, out of order, overlapping, or empty", () => {
    const { state } = story();
    const id = clipsInOrder(state.timeline)[0]!.id;
    const bad = (ranges: Array<{ start: number; end: number }>, re: RegExp) => {
      const r = keepRanges(state, id, ranges);
      assert.ok(!r.ok); assert.match(r.error, re);
    };
    bad([], /at least one range/);
    bad([{ start: 5, end: 5 }], /empty/);
    bad([{ start: 0, end: 200 }], /outside the clip/);
    bad([{ start: 10, end: 20 }, { start: 15, end: 25 }], /in order and not overlap/);
    bad([{ start: 30, end: 40 }, { start: 10, end: 20 }], /in order and not overlap/);
  });
});

// ── Anchoring overlays to dialogue ────────────────────────────────────────────

describe("atSource anchoring", () => {
  test("timelineTimeOf maps a source moment through the tightened spine", () => {
    const { state, spine } = story();
    const id = clipsInOrder(state.timeline)[0]!.id;
    const s = ok(keepRanges(state, id, [{ start: 0, end: 34.3 }, { start: 61.9, end: 67.4 }]));
    const good = timelineTimeOf(s, spine, 62.74);   // "Your son Jay said yes"
    assert.ok(good.ok);
    assert.ok(Math.abs(good.at - (34.3 + 0.84)) < 1e-6);
    const cut = timelineTimeOf(s, spine, 50);
    assert.ok(!cut.ok);
    assert.match(cut.error, /not on the main track/);
  });

  test("an overlay anchored with atSource lands on the line even when the plan tightens the spine first", () => {
    const { state, spine, screen } = story();
    const id = clipsInOrder(state.timeline)[0]!.id;
    const r = applyOperations(state, [
      { type: "keepRanges", clipId: id, ranges: [{ start: 0, end: 34.3 }, { start: 61.9, end: 67.4 }, { start: 121.8, end: 139.7 }] },
      { type: "addOverlay", sourceId: screen, inPoint: 117, outPoint: 125, fit: "contain", atSource: { sourceId: spine, time: 121.9 } },
    ]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [o] = overlaysOf(r.state.timeline);
    assert.ok(Math.abs(o!.at - (34.3 + 5.5 + 0.1)) < 1e-6, `at ${o!.at}`);
    assert.equal(o!.fit, "contain");
  });

  test("`at` and `atSource` together, or a cut moment, fail the plan clearly", () => {
    const { state, spine, screen } = story();
    const both = applyOperations(state, [{ type: "addOverlay", sourceId: screen, at: 3, atSource: { sourceId: spine, time: 5 } }]);
    assert.ok(!both.ok && /either `at` or `atSource`/.test(both.error));
    const id = clipsInOrder(state.timeline)[0]!.id;
    const gone = applyOperations(state, [
      { type: "keepRanges", clipId: id, ranges: [{ start: 0, end: 10 }] },
      { type: "addOverlay", sourceId: screen, atSource: { sourceId: spine, time: 50 } },
    ]);
    assert.ok(!gone.ok && gone.failedAt === 1 && /not on the main track/.test(gone.error));
  });
});

// ── Full-frame cutaways ───────────────────────────────────────────────────────

describe("cutaway overlays (fit)", () => {
  test("fit is stored, validated, and cleared with null", () => {
    const { state, son } = story();
    let s = ok(addOverlay(state, son, { fit: "cover", inPoint: 53, outPoint: 63 }));
    const o = overlaysOf(s.timeline)[0]!;
    assert.equal(o.fit, "cover");
    s = ok(updateOverlay(s, o.id, { fit: null }));
    assert.equal(overlaysOf(s.timeline)[0]!.fit, undefined);
    const bad = addOverlay(state, son, { fit: "stretch" as never });
    assert.ok(!bad.ok && /Unknown fit/.test(bad.error));
  });

  const layer = (fit?: "cover" | "contain"): OverlayLayer => ({
    input: "/x.mov", inPoint: 0, outPoint: 4, at: 2, anchor: "top-right", x: 0.97, y: 0.03, scale: 0.25,
    sourceWidth: 3456, sourceHeight: 2234, ...(fit ? { fit } : {}),
  });

  test("a cutaway occupies the whole frame: cover crops, contain letterboxes", () => {
    const base = { width: 1920, height: 1080 };
    assert.deepEqual(computeOverlayPlacement(layer("cover"), base), { width: 1920, height: 1080, x: 0, y: 0 });
    const cover = buildOverlayFilter([layer("cover")], base);
    assert.match(cover, /scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1/);
    assert.match(cover, /overlay=x=0:y=0/);
    const contain = buildOverlayFilter([layer("contain")], base);
    assert.match(contain, /force_original_aspect_ratio=decrease,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/);
    // Picture-in-picture is unchanged.
    assert.match(buildOverlayFilter([layer()], base), /\[1:v\]scale=480:\d+,setpts/);
  });

  test("layers carry the fit through to the renderer, and a PiP added later stacks on top", () => {
    const { state, son } = story();
    let s = ok(addOverlay(state, son, { fit: "cover", at: 10, inPoint: 53, outPoint: 63 }));
    s = ok(addOverlay(s, son, { at: 10, inPoint: 0, outPoint: 10, anchor: "left", x: 0.03, y: 0.5, scale: 0.3 }));
    const r = overlayLayersFor(s);
    assert.ok(r.ok);
    assert.deepEqual(r.layers.map((l) => l.fit ?? "pip"), ["cover", "pip"]);
  });

  test("/overlay --fit makes a cutaway, and the clip list says so", async () => {
    const { state } = story();
    const r = await runOverlayCommand(["2", "--at", "5", "--fit", "contain"], createSession(state));
    assert.ok(!r.isError, r.output);
    assert.equal(overlaysOf(r.session!.state.timeline)[0]!.fit, "contain");
    assert.match(stripAnsi(renderClipList(r.session!.state)), /full frame\s+·\s+cutaway \(contain\)/);
    const bad = await runOverlayCommand(["2", "--fit", "zoom"], createSession(state));
    assert.ok(bad.isError && /Unknown fit/.test(bad.output));
  });
});

// ── Visual beats ──────────────────────────────────────────────────────────────

describe("map_visual_beats", () => {
  test("normalizeBeats drops junk, clamps, sorts, trims overlaps, and caps", () => {
    const beats = normalizeBeats([
      { start: 72, end: 75, description: "Udriver home" },
      { start: 67, end: 73, description: "Config page" },
      { start: 140, end: 999, description: "Trip completed" },
      { start: 5, end: 5, description: "zero length" },
      { start: 1, end: 2 },
      "nonsense",
    ], 146.78);
    assert.deepEqual(beats, [
      { start: 67, end: 72, description: "Config page" },
      { start: 72, end: 75, description: "Udriver home" },
      { start: 140, end: 146.78, description: "Trip completed" },
    ]);
    assert.deepEqual(normalizeBeats("not an array", 10), []);
    const many = Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1, description: `b${i}` }));
    assert.equal(normalizeBeats(many, 200).length, MAX_VISUAL_BEATS);
  });

  test("the tool caches per source and slices by window", async () => {
    const { state, screen } = story();
    let calls = 0;
    const backend = { mapVisualBeats: async () => { calls++; return [
      { start: 0, end: 67, description: "terminal" },
      { start: 67, end: 72, description: "config" },
      { start: 117, end: 139, description: "Your trip is in progress" },
    ]; } };
    const first = await executeMapVisualBeats(state, { sourceId: screen }, backend);
    assert.ok(first.ok && first.result.totalBeats === 3 && !first.result.cached);
    const cachedState = first.stateUpdate!;
    const win = await executeMapVisualBeats(cachedState, { sourceId: screen, start: 70, end: 120 }, backend);
    assert.ok(win.ok && win.result.cached);
    assert.deepEqual(win.result.beats.map((b) => b.description), ["config", "Your trip is in progress"]);
    assert.equal(calls, 1);
    const empty = await executeMapVisualBeats(state, { sourceId: screen }, { mapVisualBeats: async () => [] });
    assert.ok(!empty.ok && /No visual beats/.test(empty.error));
  });

  test("beats are critic evidence", () => {
    const { state, screen } = story();
    const e = evidenceFrom("map_visual_beats", { sourceId: screen }, { beats: [{ start: 67, end: 72, description: "config" }], totalBeats: 1, cached: true }, state);
    assert.deepEqual(e?.result, { beats: [{ start: 67, end: 72, description: "config" }] });
  });
});

// ── Plan rendering ────────────────────────────────────────────────────────────

describe("story plans at the confirm gate", () => {
  test("tightening, inserts, cutaways and dialogue anchors read plainly", () => {
    const { state, spine, son, screen } = story();
    const id = clipsInOrder(state.timeline)[0]!.id;
    const ops = [
      { type: "keepRanges" as const, clipId: id, ranges: [{ start: 0, end: 34.3 }, { start: 61.9, end: 67.4 }] },
      { type: "addOverlay" as const, sourceId: son, inPoint: 53, outPoint: 63, fit: "cover" as const, atSource: { sourceId: spine, time: 34.3 } },
      { type: "insertClip" as const, sourceId: screen, inPoint: 72, outPoint: 75, index: 1 },
    ];
    for (const op of ops) assert.ok(AgentOperationSchema.safeParse(op).success, op.type);
    const lines = renderPlanForConfirmation(state, { summary: "s", operations: ops }).renderedLines;
    assert.equal(lines[0], "Tighten clip [1] elderly.MOV → keep 2 ranges (40s, 104s cut)");
    assert.equal(lines[1], "Overlay son.MOV → when elderly.MOV reaches 0:34.3, source 0:53–1:03, full-frame cutaway (cover)");
    assert.equal(lines[2], "Insert computer_use.mov 1:12–1:15 → position 2");
  });
});

// ── End to end: a cutaway over continuous sound (real ffmpeg) ─────────────────

function hasFfmpeg(): boolean {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe("a cutaway keeps the spine's sound (real ffmpeg)", { skip: !hasFfmpeg() && "ffmpeg not installed" }, () => {
  test("the picture switches to the cutaway while the spine's audio runs unbroken", async () => {
    const assets = join(process.cwd(), "test-assets");
    const spineFile = join(assets, "test.mp4");
    const cutFile = join(assets, "test_trimmed.mp4");
    if (!existsSync(spineFile) || !existsSync(cutFile)) return;
    const { probeFile } = await import("../media/probe.js");
    const a = await probeFile(spineFile);
    const b = await probeFile(cutFile);
    assert.ok(a.ok && b.ok);

    let s = createProject("e2e");
    s = ok(addSource(s, a.data));
    s = ok(addSource(s, b.data));
    const [spineClip, cutClip] = clipsInOrder(s.timeline);
    const r = applyOperations(s, [
      { type: "keepRanges", clipId: spineClip!.id, ranges: [{ start: 0, end: 2 }, { start: 5, end: 7 }] },
      { type: "delete", clipId: cutClip!.id },
      { type: "addOverlay", sourceId: s.sources[1]!.id, inPoint: 3, outPoint: 4.5, fit: "cover", atSource: { sourceId: s.sources[0]!.id, time: 1.5 } },
    ]);
    assert.ok(r.ok, r.ok ? "" : r.error);

    const out = join(root, "cutaway.mp4");
    const e = await exportTimeline(r.state, out);
    assert.ok(e.ok, e.ok ? "" : e.error);
    const info = await probeFile(out);
    assert.ok(info.ok);
    assert.ok(Math.abs(info.data.duration - 4) < 0.2, `tightened spine is 4s (got ${info.data.duration})`);
    assert.ok(info.data.audioCodec, "the spine's audio is there");
    assert.equal(info.data.width, a.data.width, "a cutaway never changes the frame size");
  });
});

// ── Deterministic story check ─────────────────────────────────────────────────

import { runAgent } from "../agent/loop.js";
import type { ChatProvider, ChatResponse } from "../agent/providers/types.js";
import type { CriticInput, CriticVerdict } from "../agent/critic.js";

/** The real elderly.MOV call, as transcribed (with its transcription stutter). */
const CALL = [
  [15.5, 18.44, "It's time for your daily magnesium glycinate."], [26.4, 32.22, "I've taken it."],
  [33.54, 37.94, "By the way, according to your email, you have a doctor's appointment."],
  [42.24, 44.42, "Would you like me to book you a ride to get there?"], [44.7, 45.42, "Yes, please."],
  [48.3, 49.44, "That's a new place."], [49.98, 51.84, "I'd like to check with Jay before booking the ride."],
  [52.24, 56.78, "I'm texting him now."], [61.98, 62.62, "Good news."], [62.74, 63.74, "Your son Jay said yes."],
  [64, 65.68, "I'm looking for a driver right now."], [66.04, 67.36, "We should have one in a few minutes."],
  [81.38, 82.76, "Still looking for a driver."], [121.9, 122.64, "Your ride is booked."],
  [123.3, 127, "Alvaro is coming in a Toyota Prius, plate JLC9UY."], [133.46, 134.12, "Take care, OG."],
  [137.86, 138.84, "Have a good day, OG."], [139.14, 139.64, "Bye."], [139.8, 139.84, "Bye."],
].map(([start, end, text]) => ({ start: start as number, end: end as number, text: text as string }));

function withCall(state: ProjectState, sourceId: string): ProjectState {
  return {
    ...state,
    sources: state.sources.map((s) => s.id === sourceId
      ? { ...s, analyses: { ...s.analyses, transcript: { segments: CALL, duration: 143.49, model: "m", hasAudio: true, transcribedAt: "x" } } }
      : s),
  };
}

function removeClipBySource(s: ProjectState, sourceId: string): MutationResult {
  const clip = clipsInOrder(s.timeline).find((c) => c.sourceId === sourceId)!;
  return applyOperations(s, [{ type: "delete", clipId: clip.id }]) as MutationResult;
}

// ── Concision check ───────────────────────────────────────────────────────────


// ── Cutting in at a dialogue moment (move / insertClip atSource) ──────────────

describe("move and insertClip by dialogue moment", () => {
  test("after tightening, the son shot cuts in right after 'check with Jay', not after the first piece", () => {
    const { state, spine, son } = story();
    const [call, sonClip, screen] = clipsInOrder(state.timeline);
    const r = applyOperations(state, [
      { type: "keepRanges", clipId: call!.id, ranges: [{ start: 15.2, end: 19.98 }, { start: 26.1, end: 51.84 }, { start: 61.96, end: 67.66 }] },
      { type: "delete", clipId: screen!.id },
      { type: "trim", clipId: sonClip!.id, inPoint: 50, outPoint: 65 },
      { type: "move", clipId: sonClip!.id, atSource: { sourceId: spine, time: 51.84 } },
    ]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(clipsInOrder(r.state.timeline).map((c) => [c.label, c.inPoint, c.outPoint]), [
      ["elderly.MOV", 15.2, 19.98], ["elderly.MOV", 26.1, 51.84], ["son.MOV", 50, 65], ["elderly.MOV", 61.96, 67.66],
    ]);
    void son;
  });

  test("a moment inside a clip splits it there; insertClip lands between the halves", () => {
    const { state, spine, son } = story();
    const r = applyOperations(state, [{ type: "insertClip", sourceId: son, inPoint: 50, outPoint: 65, atSource: { sourceId: spine, time: 56.78 } }]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(clipsInOrder(r.state.timeline).slice(0, 3).map((c) => [c.label, c.inPoint, c.outPoint]), [
      ["elderly.MOV", 0, 56.78], ["son.MOV", 50, 65], ["elderly.MOV", 56.78, 143.49],
    ]);
  });

  test("exactly one of index/atSource; a cut moment is a clear error", () => {
    const { state, spine, son } = story();
    const sonClip = clipsInOrder(state.timeline)[1]!;
    const none = applyOperations(state, [{ type: "move", clipId: sonClip.id }]);
    assert.ok(!none.ok && /exactly one of newIndex or atSource/.test(none.error));
    const both = applyOperations(state, [{ type: "insertClip", sourceId: son, inPoint: 0, outPoint: 1, index: 0, atSource: { sourceId: spine, time: 5 } }]);
    assert.ok(!both.ok && /exactly one of index or atSource/.test(both.error));
    const call = clipsInOrder(state.timeline)[0]!;
    const gone = applyOperations(state, [
      { type: "keepRanges", clipId: call.id, ranges: [{ start: 0, end: 10 }] },
      { type: "move", clipId: sonClip.id, atSource: { sourceId: spine, time: 50 } },
    ]);
    assert.ok(!gone.ok && /not on the main track/.test(gone.error));
  });

  test("the confirm gate names the dialogue moment", () => {
    const { state, spine } = story();
    const sonClip = clipsInOrder(state.timeline)[1]!;
    const lines = renderPlanForConfirmation(state, { summary: "s", operations: [{ type: "move", clipId: sonClip.id, atSource: { sourceId: spine, time: 51.84 } }] }).renderedLines;
    assert.equal(lines[0], "Move clip [2] son.MOV → where elderly.MOV reaches 0:51.8");
  });
});

describe("critic and confirm-gate wording", () => {
  test("the critic is told matched excerpts are intended, a long cutaway is the defect", async () => {
    const { criticSystemPrompt } = await import("../agent/critic-prompt.js");
    assert.match(criticSystemPrompt(), /never flag them as unrequested or ask to merge them into one long cutaway/);
  });

  test("tightening a clip created earlier in the same plan never shows a negative cut", () => {
    const { state, spine } = story();
    const lines = renderPlanForConfirmation(state, {
      summary: "s",
      operations: [
        { type: "insertClip", sourceId: spine, inPoint: 62, outPoint: 140, index: 1, newClipId: "part2" },
        { type: "keepRanges", clipId: "part2", ranges: [{ start: 62, end: 67.5 }, { start: 121.9, end: 140 }] },
      ],
    }).renderedLines;
    assert.match(lines[1]!, /keep 2 ranges \(24s\)$/);
    assert.doesNotMatch(lines[1]!, /-\d+s cut/);
  });
});

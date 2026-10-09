import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { alignEnvelopes, envelopeFromPcm, groupSources, transcriptAgreement, ENVELOPE_RATE, audioEnvelope } from "../media/sync.js";
import { compileProgram, programTime, shotList, renderShotList, type Program } from "../edit/program.js";
import { addSource } from "../project/mutations.js";
import { applyOperations } from "../project/session.js";
import { createProject } from "../project/io.js";
import { overlaysOf, clipsInOrder, syncOffset, type ProjectState, type MutationResult } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

const ok = (r: MutationResult): ProjectState => { assert.ok(r.ok, r.ok ? "" : r.error); return r.state; };

// ── Sync ──────────────────────────────────────────────────────────────────────

/** A random "event" loudness track, and a copy of it heard by another mic `lag` s later, with noise. */
function synthetic(seconds: number, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const n = seconds * ENVELOPE_RATE;
  const event = new Float64Array(n);
  let level = -3;
  for (let i = 0; i < n; i++) { if (i % 37 === 0) level = -6 + rnd() * 5; event[i] = level + rnd() * 0.3; }
  return { event, rnd };
}
function heardLater(event: Float64Array, lagSeconds: number, extraSeconds: number, rnd: () => number) {
  const lag = Math.round(lagSeconds * ENVELOPE_RATE);
  const out = new Float64Array(event.length + Math.round(extraSeconds * ENVELOPE_RATE));
  for (let i = 0; i < out.length; i++) {
    const src = i - lag;
    out[i] = (src >= 0 && src < event.length ? event[src]! : -7) + rnd() * 0.5;
  }
  return out;
}

describe("sync", () => {
  test("recovers a known offset from noisy copies", () => {
    const { event, rnd } = synthetic(150);
    const b = heardLater(event, 1.93, 5, rnd);
    const p = alignEnvelopes(event, b, { maxLagSeconds: 60 });
    assert.ok(p);
    assert.ok(Math.abs(p!.offset - 1.93) <= 0.011, `offset ${p!.offset}`);
    assert.ok(p!.r > 0.5 && p!.margin > 0.1);
  });

  test("unrelated audio does not produce a confident sync", () => {
    const a = synthetic(150, 1).event;
    const { event: other, rnd } = synthetic(150, 99);
    const b = heardLater(other, 0, 0, rnd);
    const g = groupSources(
      { id: "a", fileName: "a", envelope: a },
      [{ id: "b", fileName: "b", envelope: b }],
    );
    assert.equal(g.offsets["b"], undefined);
    assert.match(g.unsynced[0]!.reason, /no clear alignment/);
  });

  test("a weak direct peak is confirmed through a third source", () => {
    const { event, rnd } = synthetic(150, 3);
    const strong = heardLater(event, 1.93, 0, rnd);
    // A muffled mic: mostly its own noise, faint copy of the event.
    const faint = heardLater(event, 3.07, 0, rnd).map((v) => v * 0.15 + rnd() * 2.5);
    const g = groupSources(
      { id: "ref", fileName: "call", envelope: event },
      [{ id: "son", fileName: "son", envelope: strong }, { id: "screen", fileName: "screen", envelope: faint }],
    );
    assert.ok(g.offsets["screen"], JSON.stringify(g.unsynced));
    assert.ok(Math.abs(g.offsets["screen"]!.offset - 3.07) <= 0.02);
    assert.match(g.offsets["screen"]!.evidence, /confirmed via son/);
  });

  test("sources without audio are reported, not guessed", () => {
    const { event } = synthetic(60);
    const g = groupSources({ id: "a", fileName: "a", envelope: event }, [{ id: "b", fileName: "b", envelope: null }]);
    assert.deepEqual(g.unsynced, [{ id: "b", reason: "no audio track" }]);
  });

  test("transcript lines corroborate an offset", () => {
    const call = [{ start: 52.24, text: "I'm texting him now and will check" }, { start: 48.3, text: "That's a new place for you" }];
    const son = [{ start: 54.2, text: "I'm waiting texting him now check" }, { start: 50.48, text: "That's the main place for you" }];
    assert.equal(transcriptAgreement(call, son, 1.93), 2);
    assert.equal(transcriptAgreement(call, son, 10), 0);
  });

  test("envelopeFromPcm makes one value per 10 ms", () => {
    assert.equal(envelopeFromPcm(new Int16Array(8000)).length, 100);
  });

  const D = "/Users/abhidesai/Desktop/Archive/Gary_vids";
  test("the real recordings line up as measured", { skip: !existsSync(`${D}/elderly.MOV`) && "footage not present" }, async () => {
    const [el, son, cu] = await Promise.all(["elderly.MOV", "son.MOV", "computer_use.mov"].map((f) => audioEnvelope(`${D}/${f}`)));
    const g = groupSources(
      { id: "el", fileName: "elderly.MOV", envelope: el! },
      [{ id: "son", fileName: "son.MOV", envelope: son! }, { id: "cu", fileName: "computer_use.mov", envelope: cu! }],
    );
    assert.ok(Math.abs(g.offsets["son"]!.offset - 1.93) <= 0.05);
    assert.ok(Math.abs(g.offsets["cu"]!.offset - 3.07) <= 0.05);
  });
});

// ── Program compiler ──────────────────────────────────────────────────────────

function media(name: string, duration: number, o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: `/fake/${name}`, fileName: name, duration, width: 3840, height: 2160, fps: 60,
    videoCodec: "hevc", audioCodec: "aac", audioChannels: 2, audioBitrate: 128, fileSize: 1, bitrate: 1, containerFormat: "mov", ...o,
  };
}

/** The four product-video sources, with the measured sync. */
function project(): { state: ProjectState; call: string; son: string; chat: string; screen: string } {
  let s = createProject("t");
  s = ok(addSource(s, media("elderly.MOV", 143.49)));
  s = ok(addSource(s, media("son.MOV", 138.59)));
  s = ok(addSource(s, media("overlay_for_son.mov", 51.3, { width: 1180, height: 2556 })));
  s = ok(addSource(s, media("computer_use.mov", 146.78, { width: 3456, height: 2234 })));
  const [call, son, chat, screen] = s.sources.map((x) => x.id) as [string, string, string, string];
  s = {
    ...s,
    sync: {
      referenceSourceId: call,
      offsets: { [call]: { offset: 0, evidence: "reference" }, [son]: { offset: 1.93, evidence: "x" }, [screen]: { offset: 3.07, evidence: "x" } },
      unsynced: [{ id: chat, reason: "no clear alignment" }],
      measuredAt: "x",
    },
  };
  return { state: s, call, son, chat, screen };
}

function compileAndApply(state: ProjectState, program: Program): ProjectState {
  const c = compileProgram(state, program);
  assert.ok(c.ok, c.ok ? "" : c.error);
  const r = applyOperations(state, c.ok ? c.ops : []);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.ok ? r.state : state;
}

describe("program compiler", () => {
  test("the main track becomes exactly the kept spine, in order", () => {
    const { state, call } = project();
    const out = compileAndApply(state, { spine: call, keep: [{ start: 11.9, end: 20 }, { start: 26, end: 67.5 }, { start: 121.8, end: 140 }], shots: [] });
    assert.deepEqual(clipsInOrder(out.timeline).map((c) => [c.label, c.inPoint, c.outPoint]), [
      ["elderly.MOV", 11.9, 20], ["elderly.MOV", 26, 67.5], ["elderly.MOV", 121.8, 140],
    ]);
    assert.equal(overlaysOf(out.timeline).length, 0);
  });

  test("a synced angle shows the same moment, by the measured offset — even across a removed pause", () => {
    const { state, call, screen } = project();
    const keep = [{ start: 61.9, end: 67.5 }, { start: 121.8, end: 128 }];
    const out = compileAndApply(state, { spine: call, keep, shots: [{ from: 63, to: 125, angle: screen }] });
    const ov = overlaysOf(out.timeline);
    assert.equal(ov.length, 2, "split where the spine skips 67.5→121.8, so both sides stay in sync");
    // Spine 63 plays at program 1.1; screen frame = 63 + 3.07.
    assert.ok(Math.abs(ov[0]!.at - 1.1) < 1e-6 && Math.abs(ov[0]!.inPoint - 66.07) < 1e-6 && Math.abs(ov[0]!.outPoint - 70.57) < 1e-6);
    // Spine 121.8 plays at program 5.6; screen frame = 124.87.
    assert.ok(Math.abs(ov[1]!.at - 5.6) < 1e-6 && Math.abs(ov[1]!.inPoint - 124.87) < 1e-6 && Math.abs(ov[1]!.outPoint - 128.07) < 1e-6);
  });

  test("full framing never crops by default; fill and pip are explicit", () => {
    const { state, call, screen, son } = project();
    const out = compileAndApply(state, {
      spine: call, keep: [{ start: 40, end: 70 }],
      shots: [
        { from: 41, to: 45, angle: screen },
        { from: 46, to: 50, angle: son, framing: "fill" },
        { from: 51, to: 55, angle: screen, framing: "pip", pip: { anchor: "left", scale: 0.35 } },
      ],
    });
    const [a, b, c] = overlaysOf(out.timeline);
    assert.equal(a!.fit, "contain");
    assert.equal(b!.fit, "cover");
    assert.equal(c!.fit, undefined);
    assert.deepEqual([c!.anchor, c!.x, c!.y, c!.scale], ["left", 0.03, 0.5, 0.35]);
  });

  test("an unsynced angle needs sourceIn and then plays continuously", () => {
    const { state, call, chat } = project();
    const missing = compileProgram(state, { spine: call, keep: [{ start: 40, end: 70 }], shots: [{ from: 52, to: 61, angle: chat }] });
    assert.ok(!missing.ok && /not synced.*give `sourceIn`/.test(missing.error));
    const out = compileAndApply(state, {
      spine: call, keep: [{ start: 50, end: 57 }, { start: 61.9, end: 66 }],
      shots: [{ from: 52, to: 64, angle: chat, sourceIn: 1, framing: "pip" }],
    });
    const ov = overlaysOf(out.timeline);
    assert.equal(ov.length, 2);
    assert.ok(Math.abs(ov[0]!.inPoint - 1) < 1e-6 && Math.abs(ov[0]!.outPoint - 6) < 1e-6);
    assert.ok(Math.abs(ov[1]!.inPoint - 6) < 1e-6, "continues from where it left off, not jumping");
  });

  test("clear errors: footage the angle doesn't have, shots outside the kept spine, bad keep ranges", () => {
    const { state, call, screen, son } = project();
    // son.MOV is 138.59 s long at +1.93 s, so it covers spine time only up to 136.66 s.
    const late = compileProgram(state, { spine: call, keep: [{ start: 135, end: 143 }], shots: [{ from: 137, to: 140, angle: son }] });
    assert.ok(!late.ok && /has no footage for that moment.*covers spine -1\.93–136\.66s/.test(late.error), late.ok ? "" : late.error);
    const outside = compileProgram(state, { spine: call, keep: [{ start: 10, end: 20 }], shots: [{ from: 30, to: 40, angle: screen }] });
    assert.ok(!outside.ok && /none of it is inside the kept spine/.test(outside.error));
    const order = compileProgram(state, { spine: call, keep: [{ start: 30, end: 40 }, { start: 10, end: 20 }], shots: [] });
    assert.ok(!order.ok && /in order without overlaps/.test(order.error));
  });

  test("programTime maps spine time through the cuts", () => {
    const keep = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
    assert.equal(programTime(keep, 15), 5);
    assert.equal(programTime(keep, 35), 15);
    assert.equal(programTime(keep, 25), null);
  });

  test("the shot list reads like an editor's: picture, windows, sound, lines", () => {
    const { state, call, son, chat, screen } = project();
    const withLines: ProjectState = {
      ...state,
      sources: state.sources.map((s) => s.id === call
        ? { ...s, analyses: { transcript: { segments: [
            { start: 49.98, end: 51.84, text: "I'd like to check with Jay before booking the ride." },
            { start: 61.98, end: 62.62, text: "Good news." },
            { start: 121.9, end: 122.64, text: "Your ride is booked." },
          ], duration: 143.49, model: "m", hasAudio: true, transcribedAt: "x" } } }
        : s),
    };
    const out = compileAndApply(withLines, {
      spine: call, keep: [{ start: 48, end: 67.5 }, { start: 121.8, end: 128 }],
      shots: [
        { from: 52, to: 61.9, angle: son },
        { from: 52, to: 61.9, angle: chat, sourceIn: 1, framing: "pip" },
        { from: 64, to: 128, angle: screen },
      ],
    });
    const lines = renderShotList(shotList(out));
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /^0:00\.0–0:04\.0 \(4\.0s\) elderly\.MOV — "I'd like to check with Jay/);
    assert.match(lines[1]!, /son\.MOV \+ overlay_for_son\.mov window/);
    assert.match(lines[2]!, /elderly\.MOV — "Good news\."/);
    assert.match(lines[3]!, /computer_use\.mov — "Your ride is booked\."/);
    assert.equal(syncOffset(out.sync, call, screen), 3.07);
  });
});

// ── propose_program through the agent loop ────────────────────────────────────

import { runAgent } from "../agent/loop.js";
import { createSession } from "../project/session.js";
import type { ChatProvider, ChatResponse } from "../agent/providers/types.js";
import type { ReviewerFn } from "../agent/reviewer.js";
import type { PlanForConfirmation } from "../agent/propose_edit_plan.js";

describe("propose_program in the loop", () => {
  const scripted = (responses: ChatResponse[], seen: string[]): ChatProvider => {
    let i = 0;
    const next = (req: { messages: Array<{ content: Array<{ type: string; content?: unknown }> }> }) => {
      for (const b of req.messages[req.messages.length - 1]!.content) if (b.type === "tool_result") seen.push(String(b.content));
      return responses[i++]!;
    };
    return {
      send: async (req: never) => next(req),
      stream: (req: never) => { const r = next(req); return { [Symbol.asyncIterator]: async function* () {}, finalResponse: async () => r }; },
    } as unknown as ChatProvider;
  };
  const propose = (id: string, program: Program): ChatResponse => ({
    content: [{ type: "tool_use", id, name: "propose_program", input: { summary: "story", program } }],
    stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 },
  });
  const done: ChatResponse = { content: [{ type: "text", text: "Done." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };

  test("a reviewer note sends the program back; the revision is confirmed as a shot list and applied once", async () => {
    const { state, call, screen } = project();
    const first: Program = { spine: call, keep: [{ start: 40, end: 70 }], shots: [{ from: 41, to: 43, angle: screen }, { from: 43.5, to: 46, angle: screen }] };
    const second: Program = { spine: call, keep: [{ start: 40, end: 70 }], shots: [{ from: 41, to: 52, angle: screen }] };
    const seen: string[] = [];
    let reviews = 0;
    const reviewer: ReviewerFn = async () => {
      reviews++;
      return reviews === 1
        ? { verdict: "revise", notes: [{ time: 3.2, severity: "major", issue: "flashes back to the couch for half a second" }], shots: [] }
        : { verdict: "approve", notes: [], shots: [] };
    };
    const confirmed: PlanForConfirmation[] = [];
    const r = await runAgent({
      userPrompt: "make the story", session: createSession(state), messages: [], autoApprove: false,
      confirm: async (plan) => { confirmed.push(plan); return { approved: true }; },
      provider: scripted([propose("p1", first), propose("p2", second), done], seen), reviewer,
    });
    assert.equal(r.isError, false, r.output);
    assert.match(seen[0]!, /"status":"review".*at 0:03\.2: flashes back/);
    assert.equal(confirmed.length, 1, "the user only sees the revised cut");
    assert.match(confirmed[0]!.renderedLines.join("\n"), /computer_use\.mov/);
    assert.equal(r.session.undo.length, 1);
    assert.equal(overlaysOf(r.session.state.timeline).length, 1);
    assert.ok(Math.abs(overlaysOf(r.session.state.timeline)[0]!.inPoint - 44.07) < 1e-6, "synced: spine 41 + 3.07");
  });

  test("a program that can't be built comes back to the agent as an error, applying nothing", async () => {
    const { state, call, chat } = project();
    const seen: string[] = [];
    const bad: Program = { spine: call, keep: [{ start: 40, end: 70 }], shots: [{ from: 52, to: 60, angle: chat }] };
    const r = await runAgent({
      userPrompt: "x", session: createSession(state), messages: [], autoApprove: true,
      confirm: async () => ({ approved: true }), provider: scripted([propose("p1", bad), done], seen),
      reviewer: async () => ({ verdict: "approve", notes: [], shots: [] }),
    });
    assert.equal(r.isError, false);
    assert.match(seen[0]!, /Program can't be built: .*not synced/);
    assert.equal(r.session.undo.length, 0);
  });
});

// ── Measured cut facts ────────────────────────────────────────────────────────

import { measureCut, describeCutFacts } from "../edit/cut-facts.js";
import { reviewBrief } from "../agent/reviewer.js";

describe("cut facts", () => {
  function withSilence(state: ProjectState, sourceId: string, silences: Array<[number, number]>): ProjectState {
    return {
      ...state,
      sources: state.sources.map((s) => s.id === sourceId
        ? { ...s, analyses: { ...s.analyses, silences: [{ thresholdDb: -50, minDuration: 0.5, detectedAt: "x", silences: silences.map(([a, b]) => ({ start: a, end: b, duration: b - a })) }] } }
        : s),
    };
  }

  test("lead-in, tail and silent stretches in cut time, with each source part across a cut", () => {
    const { state, call } = project();
    const measured = withSilence(state, call, [[0, 12], [83.95, 104.39], [139.56, 143.49]]);
    const out = compileAndApply(measured, { spine: call, keep: [{ start: 0, end: 88.82 }, { start: 104.24, end: 143.49 }], shots: [] });
    const f = measureCut(out);
    assert.equal(f.leadIn, 12);
    assert.ok(Math.abs(f.tail - 3.93) < 1e-6);
    const across = f.silences.find((s) => s.parts.length === 2)!;
    assert.deepEqual(across.parts.map((p) => [p.start, p.end]), [[83.95, 88.82], [104.24, 104.39]]);
    const text = describeCutFacts(f).join("\n");
    assert.match(text, /Before the first sound: 12\.0 s of silence\./);
    assert.match(text, /elderly\.MOV 83\.95–88\.82 s \+ elderly\.MOV 104\.24–104\.39 s/);
  });

  test("unmeasured sources are named rather than assumed silent-free", () => {
    const { state, call } = project();
    const out = compileAndApply(state, { spine: call, keep: [{ start: 10, end: 20 }], shots: [] });
    assert.match(describeCutFacts(measureCut(out)).join("\n"), /Not measured: elderly\.MOV/);
  });

  test("the reviewer brief carries the facts and asks about length in the client's terms", () => {
    const brief = reviewBrief("one concise video", ["0:00.0–0:05.0 (5.0s) elderly.MOV"], ["Before the first sound: 12.0 s of silence."]);
    assert.match(brief, /Measured from the cut's audio/);
    assert.match(brief, /Before the first sound: 12\.0 s of silence\./);
    assert.match(brief, /a lead-in before the story starts, a tail after it ends/);
  });
});

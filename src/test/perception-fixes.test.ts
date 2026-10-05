import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evidenceFrom, renderEvidence, MAX_EVIDENCE_CHARS, type EvidenceItem } from "../agent/evidence.js";
import { runCritic, SUBMIT_REVIEW_TOOL, type CriticInput } from "../agent/critic.js";
import { criticSystemPrompt } from "../agent/critic-prompt.js";
import { matchQuery, selectQuery, executeTranscribeAudio } from "../agent/tools/transcribe_audio.js";
import { normalizeMomentHits, type ProjectState, type TranscriptSegment } from "../project/types.js";
import { executeFindVisualMoment } from "../agent/tools/find_visual_moment.js";
import { buildSceneArgs, planSceneChunks, mergeBoundaries, executeDetectScenes } from "../agent/tools/detect_scenes.js";
import { buildSilenceArgs } from "../agent/tools/detect_silence.js";
import { mergeAnalyses, runScout } from "../agent/scout.js";
import { buildPerceptionRegistry } from "../agent/perception-registry.js";
import { addSource } from "../project/mutations.js";
import { createProject } from "../project/io.js";
import type { ChatProvider, ChatResponse } from "../agent/providers/types.js";
import type { MediaInfo } from "../media/types.js";

function media(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/elderly.MOV", fileName: "elderly.MOV", duration: 143.49,
    width: 3840, height: 2160, fps: 60, videoCodec: "hevc", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1, bitrate: 1, containerFormat: "mov", ...o,
  };
}
function state(): ProjectState {
  const r = addSource(createProject("t"), media());
  assert.ok(r.ok);
  return r.state;
}

// The real elderly.MOV transcript around the two story cues.
const ELDERLY: TranscriptSegment[] = [
  { start: 44.7, end: 45.42, text: "Yes, please." },
  { start: 48.3, end: 49.44, text: "That's a new place." },
  { start: 49.5, end: 49.98, text: "So I'd like to book you a ride." },
  { start: 49.98, end: 51.84, text: "I'd like to check with Jay before booking the ride." },
  { start: 52.24, end: 56.78, text: "I'm texting him now." },
  { start: 61.98, end: 62.62, text: "Good news." },
  { start: 62.74, end: 63.74, text: "Your son Jay said yes." },
  { start: 64, end: 65.68, text: "I'm looking for a driver right now." },
  { start: 66.04, end: 67.36, text: "We should have one in a few minutes." },
  { start: 79.38, end: 79.88, text: "Okay." },
];

// ── 1. Critic evidence ────────────────────────────────────────────────────────

describe("critic evidence", () => {
  test("evidenceFrom keeps perception results only, names the file, and trims bookkeeping", () => {
    const s = state();
    const id = s.sources[0]!.id;
    assert.equal(evidenceFrom("query_timeline", {}, {}, s), null);
    assert.equal(evidenceFrom("survey_sources", {}, {}, s), null);
    const t = evidenceFrom("transcribe_audio", { sourceId: id, query: "new place" },
      { segments: ELDERLY.slice(0, 2), totalSegments: 39, cached: true, note: "n" }, s)!;
    assert.equal(t.source, "elderly.MOV");
    assert.deepEqual(t.input, { query: "new place" });
    assert.deepEqual(t.result, { lines: ["44.70–45.42 Yes, please.", "48.30–49.44 That's a new place."], note: "n" });
    const v = evidenceFrom("find_visual_moment", { sourceId: id, query: "phone" },
      { hits: Array.from({ length: 9 }, (_, i) => ({ start: i, end: i + 1, rank: i + 1 })) }, s)!;
    assert.equal((v.result as { hits: unknown[] }).hits.length, 5);
    const d = evidenceFrom("describe_segment", { sourceId: "gone", start: 1, end: 2 }, { description: "x", model: "m", cached: false }, s)!;
    assert.equal(d.source, "gone");
    assert.deepEqual(d.result, { description: "x" });
  });

  test("a whole call's transcript fits the per-item cap, ending included", () => {
    const s = state();
    const call = Array.from({ length: 40 }, (_, i) => ({ start: i * 3.5, end: i * 3.5 + 3, text: `Line number ${i} of the conversation.` }));
    call[39] = { start: 139.8, end: 141, text: "Have a good day, OG." };
    const e = evidenceFrom("transcribe_audio", { sourceId: s.sources[0]!.id, start: 0, end: 143 }, { segments: call }, s)!;
    const rendered = renderEvidence([e]).join("\n");
    assert.match(rendered, /Have a good day, OG\./);
    assert.doesNotMatch(rendered, /truncated/);
  });

  test("renderEvidence keeps the newest items within the budget and says what it dropped", () => {
    const big = (i: number): EvidenceItem => ({ tool: "describe_segment", source: "s", input: { i }, result: { description: "x".repeat(3500) } });
    const items = Array.from({ length: 12 }, (_, i) => big(i));
    const lines = renderEvidence(items);
    assert.match(lines[0]!, /older items omitted/);
    assert.ok(lines.join("").length <= MAX_EVIDENCE_CHARS + 200);
    assert.match(lines[lines.length - 1]!, /"i":11/, "the most recent item survives");
  });

  test("the review payload carries the evidence, and a map-less plan is not called unsurveyed", async () => {
    const s = state();
    const requests: string[] = [];
    const provider: ChatProvider = {
      send: async (req) => {
        const b = req.messages[0]!.content[0]!;
        requests.push(b.type === "text" ? b.text : "");
        return { content: [{ type: "tool_use", id: "r", name: SUBMIT_REVIEW_TOOL, input: { verdict: "approve", concerns: [] } }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } } as ChatResponse;
      },
      stream: () => { throw new Error("no"); },
    };
    const input: CriticInput = {
      userRequest: "cut after the new-place line",
      contentMap: null,
      evidence: [{ tool: "transcribe_audio", source: "elderly.MOV", input: { query: "new place" }, result: { segments: ELDERLY.slice(1, 4) } }],
      plan: { summary: "s", operations: [] },
      renderedPlan: [],
      timelineState: s,
    };
    await runCritic(input, { provider });
    assert.match(requests[0]!, /## Director's evidence/);
    assert.match(requests[0]!, /check with Jay/);
    assert.match(requests[0]!, /verified with targeted tools instead/);

    await runCritic({ ...input, evidence: [] }, { provider });
    assert.match(requests[1]!, /did not survey sources this turn/);
    assert.match(requests[1]!, /ran no perception tools/);
  });

  test("the critic treats a dropped story ending or a silenced dialogue as major", () => {
    const p = criticSystemPrompt();
    assert.match(p, /Story completeness \(MAJOR when violated\)/);
    assert.match(p, /the dialogue goes silent because another source plays with its own sound/);
  });

  test("the critic is told the main track ripples, so it never flags gaps", () => {
    const p = criticSystemPrompt();
    assert.match(p, /main track is a gapless sequence/);
    assert.match(p, /never flag one/);
  });

  test("the critic prompt ranks evidence above the coarse map", () => {
    const p = criticSystemPrompt();
    assert.match(p, /authoritative source for precise timestamps/);
    assert.match(p, /never use a map gist to contradict an exact time/);
    assert.match(p, /missing content map is not a defect/);
  });
});

// ── 2. Survey speed: scene/silence detection and scout concurrency ────────────

describe("scene and silence detection args", () => {
  test("silence detection never decodes video", () => {
    const a = buildSilenceArgs("/in.mov", -35, 0.5);
    for (const flag of ["-vn", "-sn", "-dn"]) assert.ok(a.includes(flag), flag);
    assert.ok(a.indexOf("-vn") > a.indexOf("-i"), "an output option, after the input");
  });

  test("scene detection skips audio, hardware-decodes on macOS, and downscales before comparing", () => {
    const a = buildSceneArgs("/in.mov", 0.4, { start: 35, duration: 37 }, "darwin");
    assert.deepEqual(a.slice(a.indexOf("-hwaccel"), a.indexOf("-hwaccel") + 2), ["-hwaccel", "videotoolbox"]);
    assert.ok(a.indexOf("-ss") < a.indexOf("-i"));
    assert.ok(a.includes("-an"));
    assert.match(a[a.indexOf("-vf") + 1]!, /^scale=-2:360,select='gt\(scene,0\.4\)',showinfo$/);
    assert.ok(!buildSceneArgs("/in.mov", 0.4, null, "linux").includes("-hwaccel"));
  });

  test("chunks cover the source, each later one reaching back a second", () => {
    assert.deepEqual(planSceneChunks(30), [{ start: 0, duration: 30 }]);
    const c = planSceneChunks(143.49);
    assert.equal(c.length, 4);
    assert.deepEqual(c.map((x) => x.start), [0, 35, 71, 107]);
    assert.ok(Math.abs(c[3]!.start + c[3]!.duration - 143.49) < 1e-9, "the last chunk ends at the source end");
  });

  test("boundaries from overlapping chunks merge without duplicates", () => {
    assert.deepEqual(mergeBoundaries([39.01, 8.26, 39.04, 14.97, 14.98]), [8.26, 14.97, 39.01]);
  });

  test("the runner is told the source duration so it can split the work", async () => {
    const s = state();
    let seen: number | undefined;
    await executeDetectScenes(s, { sourceId: s.sources[0]!.id }, async (_i, _t, d) => { seen = d; return ""; });
    assert.equal(seen, 143.49);
  });
});

describe("scout concurrency", () => {
  test("mergeAnalyses keeps every concurrent cache write: arrays union, scalars replace", () => {
    const base = state();
    const id = base.sources[0]!.id;
    const withAnalyses = (s: ProjectState, a: object): ProjectState =>
      ({ ...s, sources: s.sources.map((x) => (x.id === id ? { ...x, analyses: { ...x.analyses, ...a } } : x)) });
    const seg = (n: number) => ({ start: n, end: n + 1, text: `${n}`, model: "m", generatedAt: "x" });
    const u1 = withAnalyses(base, { segmentDescriptions: [seg(1)] });
    const u2 = withAnalyses(base, { segmentDescriptions: [seg(2)], scenes: { threshold: 0.4, boundaries: [3], detectedAt: "x" } });
    let running = mergeAnalyses(base, base, u1);
    running = mergeAnalyses(running, base, u2);
    const a = running.sources[0]!.analyses;
    assert.deepEqual(a.segmentDescriptions!.map((x) => x.start), [1, 2]);
    assert.deepEqual(a.scenes!.boundaries, [3]);
  });

  test("tools requested in one scout turn run at the same time and both caches survive", async () => {
    const s = state();
    const id = s.sources[0]!.id;
    const registry = buildPerceptionRegistry();
    const log: string[] = [];
    const slowTool = (name: string, key: "scenes" | "description") => ({
      schema: { name, description: name, input_schema: { type: "object" as const, properties: {} } },
      execute: async (st: ProjectState) => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 30));
        log.push(`end ${name}`);
        const value = key === "scenes"
          ? { threshold: 0.4, boundaries: [1], detectedAt: "x" }
          : { text: "d", model: "m", generatedAt: "x" };
        return {
          ok: true as const,
          result: { done: name },
          stateUpdate: { ...st, sources: st.sources.map((x) => (x.id === id ? { ...x, analyses: { ...x.analyses, [key]: value } } : x)) },
        };
      },
    });
    registry.register(slowTool("detect_scenes", "scenes"));
    registry.register(slowTool("describe_clip", "description"));

    const responses: ChatResponse[] = [
      { content: [
        { type: "tool_use", id: "a", name: "detect_scenes", input: { sourceId: id } },
        { type: "tool_use", id: "b", name: "describe_clip", input: { sourceId: id } },
      ], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
      { content: [{ type: "tool_use", id: "c", name: "record_findings", input: { outline: [{ start: 0, end: 1, gist: "g" }], keyMoments: [] } }],
        stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    let i = 0;
    const provider: ChatProvider = { send: async () => responses[i++]!, stream: () => { throw new Error("no"); } };

    const r = await runScout(id, s, { provider, registry });
    assert.equal(r.incomplete, false);
    assert.deepEqual(log.slice(0, 2).sort(), ["start describe_clip", "start detect_scenes"], "both started before either ended");
    const a = r.state.sources[0]!.analyses;
    assert.ok(a.scenes && a.description, "both tools' cache writes were kept");
  });
});

// ── 3. Transcript search ──────────────────────────────────────────────────────

describe("transcript search by shared words", () => {
  test("the paraphrased story cue finds the real line across segments", () => {
    const m = matchQuery(ELDERLY, "this is a new place let me check with your son");
    assert.equal(m.mode, "words");
    assert.deepEqual(m.matchedWords, ["new", "place", "check"]);
    const starts = m.segments.map((s) => s.start);
    assert.ok(starts.includes(48.3) && starts.includes(49.98));
  });

  test("the second cue lands on Good news … right now", () => {
    const m = matchQuery(ELDERLY, "good news your son approved looking for a ride right now");
    assert.equal(m.mode, "words");
    const starts = m.segments.map((s) => s.start);
    for (const t of [61.98, 62.74, 64]) assert.ok(starts.includes(t), String(t));
  });

  test("an exact phrase still wins and does not fall through to word matching", () => {
    const m = matchQuery(ELDERLY, "good news");
    assert.equal(m.mode, "exact");
    assert.deepEqual(m.segments.map((s) => s.start), [56.78 - 4.54, 61.98, 62.74].map((x) => +x.toFixed(2)));
  });

  test("stopword-only or unrelated queries return nothing", () => {
    assert.equal(matchQuery(ELDERLY, "what is it").mode, "none");
    assert.equal(matchQuery(ELDERLY, "message phone notification").mode, "none");
    assert.deepEqual(selectQuery(ELDERLY, "zebra crossing"), []);
  });

  test("one shared word out of several is not enough", () => {
    assert.equal(matchQuery(ELDERLY, "pharmacy ride tomorrow afternoon").mode, "none");
  });

  test("the tool says when results are a word match rather than an exact one", async () => {
    const s = state();
    const id = s.sources[0]!.id;
    const withT: ProjectState = { ...s, sources: s.sources.map((x) => ({ ...x, analyses: { transcript: { segments: ELDERLY, duration: 143.49, model: "m", hasAudio: true, transcribedAt: "x" } } })) };
    const r = await executeTranscribeAudio(withT, { sourceId: id, query: "new place check with son" });
    assert.ok(r.ok);
    assert.match(r.result.note ?? "", /closest passages by shared words \(new, place, check\)/);
  });
});

// ── 4. Visual search ranks ────────────────────────────────────────────────────

describe("visual search ranks", () => {
  test("hits are 1-based ranks, best first", () => {
    assert.deepEqual(
      normalizeMomentHits([{ start: 5, end: 6, rank: 3 }, { start: 1, end: 2, rank: 1 }, { start: 3, end: 4, rank: 2 }]),
      [{ start: 1, end: 2, rank: 1 }, { start: 3, end: 4, rank: 2 }, { start: 5, end: 6, rank: 3 }],
    );
  });

  test("legacy cached hits with a derived confidence read back as ranks in the right order", async () => {
    const s = state();
    const id = s.sources[0]!.id;
    const legacy: ProjectState = {
      ...s,
      sources: s.sources.map((x) => ({
        ...x,
        analyses: { moments: [{ query: "phone", retrievedAt: "x",
          hits: [{ start: 64.7, end: 73.9, confidence: 0.5 }, { start: 120, end: 138, confidence: 0.25 }, { start: 55, end: 64, confidence: 1 / 3 }] as never }] },
      })),
    };
    const r = await executeFindVisualMoment(legacy, { sourceId: id, query: "phone" });
    assert.ok(r.ok);
    assert.deepEqual(r.result.hits, [
      { start: 64.7, end: 73.9, rank: 1 },
      { start: 55, end: 64, rank: 2 },
      { start: 120, end: 138, rank: 3 },
    ]);
  });
});

// ── describe_segment clamps a window that overshoots the end ──────────────────

import { executeDescribeSegment } from "../agent/tools/describe_segment.js";

describe("describe_segment window clamping", () => {
  test("an end a hair past the source end is clamped, not rejected", async () => {
    let s = state();
    s = { ...s, sources: s.sources.map((x) => ({ ...x, duration: 51.296667 })) };
    const calls: Array<[number, number]> = [];
    const backend = {
      describeVideo: async () => "unused",
      describeVideoSegment: async (_f: string, a: number, b: number) => { calls.push([a, b]); return "chat confirms the ride"; },
    };
    const r = await executeDescribeSegment(s, { sourceId: s.sources[0]!.id, start: 20, end: 51.3 }, backend);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(calls, [[20, 51.296667]]);
    assert.equal(r.result.end, 51.296667);
    const past = await executeDescribeSegment(s, { sourceId: s.sources[0]!.id, start: 60, end: 70 }, backend);
    assert.ok(!past.ok && /outside the source duration/.test(past.error));
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runSurvey } from "../agent/tools/survey_sources.js";
import type { ScoutResult } from "../agent/scout.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ProjectState, ScoutContribution } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 60,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4", ...o,
  };
}

// n sources, one clip each (addSource appends a full-duration clip).
function makeState(n: number): ProjectState {
  let state = createProject("t");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({ fileName: `s${i + 1}.mp4` }));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

function contribution(gist: string): ScoutContribution {
  return {
    outline: [{ start: 0, end: 60, gist }],
    keyMoments: [{ time: 10, gist: `${gist} moment` }],
    generatedAt: new Date().toISOString(),
  };
}

function okScout(sourceId: string, state: ProjectState, gist = "beat"): ScoutResult {
  return { sourceId, contribution: contribution(gist), incomplete: false, state };
}

// ── Fan-out + concurrency cap ─────────────────────────────────────────────────

describe("runSurvey — parallel fan-out under a concurrency cap", () => {
  test("bounds in-flight scouts to the cap while surveying all sources", async () => {
    const state = makeState(6);
    let inFlight = 0;
    let maxInFlight = 0;
    const scouted: string[] = [];

    const deps = {
      concurrency: 2,
      scout: async (sourceId: string): Promise<ScoutResult> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        scouted.push(sourceId);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return okScout(sourceId, state);
      },
    };

    const r = await runSurvey(state, {}, deps);
    assert.ok(r.ok);
    assert.equal(scouted.length, 6, "every source scouted");
    assert.ok(maxInFlight <= 2, `max in-flight ${maxInFlight} must respect the cap`);
    assert.equal(r.result.sources.length, 6);
  });
});

// ── Reduce to a bounded map ────────────────────────────────────────────────────

describe("runSurvey — reduces to a bounded ContentMap", () => {
  test("over-cap contributions are bounded and the map is flagged truncated", async () => {
    const state = makeState(1);
    const bigOutline = Array.from({ length: 30 }, (_, i) => ({ start: i, end: i + 1, gist: `b${i}` }));
    const deps = {
      scout: async (sourceId: string): Promise<ScoutResult> => ({
        sourceId,
        contribution: { outline: bigOutline, keyMoments: [], generatedAt: "x" },
        incomplete: false,
        state,
      }),
    };

    const r = await runSurvey(state, {}, deps);
    assert.ok(r.ok);
    assert.ok(r.result.sources[0]!.outline.length <= 12, "outline capped");
    assert.equal(r.result.truncated, true);
  });

  test("the map records no gathering-method metadata", async () => {
    const state = makeState(2);
    const deps = { scout: async (id: string) => okScout(id, state) };
    const r = await runSurvey(state, {}, deps);
    assert.ok(r.ok);

    assert.deepEqual(Object.keys(r.result).sort(), ["sources", "truncated"]);
    const allowed = new Set(["sourceId", "displayRef", "duration", "outline", "keyMoments", "topicBeats", "silences", "label", "incomplete"]);
    for (const s of r.result.sources) {
      for (const k of Object.keys(s)) assert.ok(allowed.has(k), `unexpected map key "${k}" (gathering metadata leaked?)`);
    }
  });
});

// ── Partial failure degrades, doesn't sink ────────────────────────────────────

describe("runSurvey — partial failure", () => {
  test("one failed scout marks its source incomplete; the rest of the map is intact", async () => {
    const state = makeState(3);
    const ids = state.sources.map((s) => s.id);
    const failId = ids[1]!;

    const deps = {
      scout: async (sourceId: string): Promise<ScoutResult> =>
        sourceId === failId
          ? { sourceId, contribution: null, incomplete: true, state }
          : okScout(sourceId, state, "good"),
    };

    const r = await runSurvey(state, {}, deps);
    assert.ok(r.ok);
    assert.equal(r.result.sources.length, 3, "all sources present");

    const failed = r.result.sources.find((s) => s.sourceId === failId)!;
    assert.equal(failed.incomplete, true);
    assert.deepEqual(failed.outline, []);

    for (const s of r.result.sources) {
      if (s.sourceId === failId) continue;
      assert.ok(!s.incomplete, "healthy sources are not flagged incomplete");
      assert.ok(s.outline.length > 0, "healthy sources keep their content");
    }
  });
});

// ── Cache reuse ────────────────────────────────────────────────────────────────

describe("runSurvey — reuses cached contributions", () => {
  test("a source with a cached contribution is not re-scouted", async () => {
    let state = makeState(3);
    const ids = state.sources.map((s) => s.id);
    const cachedId = ids[0]!;
    // Pre-cache a contribution on the first source.
    state = {
      ...state,
      sources: state.sources.map((s) =>
        s.id === cachedId ? { ...s, analyses: { ...s.analyses, scoutContribution: contribution("cached beat") } } : s,
      ),
    };

    const scouted: string[] = [];
    const deps = {
      scout: async (sourceId: string): Promise<ScoutResult> => {
        scouted.push(sourceId);
        return okScout(sourceId, state, "fresh");
      },
    };

    const r = await runSurvey(state, {}, deps);
    assert.ok(r.ok);
    assert.ok(!scouted.includes(cachedId), "cached source must not be re-scouted");
    assert.equal(scouted.length, 2, "only the two uncached sources are scouted");

    // The cached source is still in the map, from its cached contribution.
    const cached = r.result.sources.find((s) => s.sourceId === cachedId)!;
    assert.equal(cached.outline[0]!.gist, "cached beat");
    assert.ok(!cached.incomplete);
  });
});

// ── Scope ──────────────────────────────────────────────────────────────────────

describe("runSurvey — scope", () => {
  test("respects an explicit sourceIds scope", async () => {
    const state = makeState(3);
    const only = state.sources[2]!.id;
    const scouted: string[] = [];
    const deps = {
      scout: async (sourceId: string): Promise<ScoutResult> => { scouted.push(sourceId); return okScout(sourceId, state); },
    };

    const r = await runSurvey(state, { sourceIds: [only] }, deps);
    assert.ok(r.ok);
    assert.deepEqual(scouted, [only]);
    assert.equal(r.result.sources.length, 1);
    assert.equal(r.result.sources[0]!.sourceId, only);
  });
});

// ── Scout lifecycle events (3E-4) ─────────────────────────────────────────────

describe("runSurvey — scout lifecycle progress", () => {
  test("emits started then completed per scout, and failed for a failing one", async () => {
    const state = makeState(3);
    const ids = state.sources.map((s) => s.id);
    const failId = ids[1]!;

    const events: Array<{ sourceId: string; status: string }> = [];
    const deps = {
      onProgress: (e: { sourceId: string; status: "started" | "completed" | "failed" }) => events.push(e),
      scout: async (sourceId: string): Promise<ScoutResult> =>
        sourceId === failId
          ? { sourceId, contribution: null, incomplete: true, state }
          : okScout(sourceId, state),
    };

    const r = await runSurvey(state, {}, deps);
    assert.ok(r.ok);

    // Every scouted source announced a start.
    for (const id of ids) {
      assert.ok(events.some((e) => e.sourceId === id && e.status === "started"), `start for ${id}`);
    }
    // The failing source ends "failed"; the others "completed".
    assert.ok(events.some((e) => e.sourceId === failId && e.status === "failed"));
    for (const id of ids) {
      if (id === failId) continue;
      assert.ok(events.some((e) => e.sourceId === id && e.status === "completed"), `completed for ${id}`);
    }
    // started precedes the terminal event for the failing source.
    const startIdx = events.findIndex((e) => e.sourceId === failId && e.status === "started");
    const failIdx = events.findIndex((e) => e.sourceId === failId && e.status === "failed");
    assert.ok(startIdx >= 0 && failIdx > startIdx);
  });

  test("a cached source emits no scout lifecycle (it isn't scouted)", async () => {
    let state = makeState(2);
    const cachedId = state.sources[0]!.id;
    state = {
      ...state,
      sources: state.sources.map((s) =>
        s.id === cachedId ? { ...s, analyses: { ...s.analyses, scoutContribution: contribution("cached") } } : s,
      ),
    };
    const events: Array<{ sourceId: string; status: string }> = [];
    const deps = {
      onProgress: (e: { sourceId: string; status: "started" | "completed" | "failed" }) => events.push(e),
      scout: async (sourceId: string) => okScout(sourceId, state),
    };

    await runSurvey(state, {}, deps);
    assert.ok(!events.some((e) => e.sourceId === cachedId), "cached source is not announced");
  });
});

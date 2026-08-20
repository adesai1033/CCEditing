import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { IndexRegistry, getDefaultIndexRegistry, setDefaultIndexRegistry, type IndexResult } from "../agent/indexing.js";
import { executeFindVisualMoment } from "../agent/tools/find_visual_moment.js";
import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import { createSession, applyPlan } from "../project/session.js";
import type { ProjectState, SourceFile } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Setup: redirect .cutcli.json writes to a temp dir (for the /open test) ────

let testDir: string;
const originalCwd = process.cwd();
const REPO_ROOT = resolve(originalCwd);

before(() => {
  testDir = mkdtempSync(join(tmpdir(), "cutcli-indexing-test-"));
  process.chdir(testDir);
});

after(() => {
  process.chdir(originalCwd);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/a.mp4", fileName: "a.mp4", duration: 60,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4", ...o,
  };
}

function makeState(n = 1): ProjectState {
  let state = createProject("t");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({ fileName: `s${i + 1}.mp4`, filePath: `/fake/s${i + 1}.mp4` }));
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

// A controllable index job: resolve/reject it from the test.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const RESULT: IndexResult = { indexId: "idx_1", videoId: "vid_1" };

function withIndexed(state: ProjectState, sourceId: string): ProjectState {
  return {
    ...state,
    sources: state.sources.map((s): SourceFile =>
      s.id === sourceId
        ? { ...s, analyses: { ...s.analyses, twelveLabs: { indexId: "idx_c", videoId: "vid_c", status: "indexed", indexedAt: "2026-01-01T00:00:00Z" } } }
        : s,
    ),
  };
}

// ── Status transitions ────────────────────────────────────────────────────────

describe("IndexRegistry — status transitions", () => {
  test("pending → running → ready", async () => {
    const d = deferred<IndexResult>();
    let started = false;
    const registry = new IndexRegistry({ indexFn: async () => { started = true; return d.promise; } });
    const src = { id: "s1", filePath: "/f.mp4" };

    const p = registry.ensure(src);
    // The job starts on the microtask queue; before it runs it's pending.
    assert.ok(["pending", "running"].includes(registry.status("s1")!.status));
    await new Promise((r) => setImmediate(r));
    assert.equal(registry.status("s1")!.status, "running");
    assert.equal(started, true);

    d.resolve(RESULT);
    const result = await p;
    assert.deepEqual(result, RESULT);
    assert.equal(registry.status("s1")!.status, "ready");
    assert.deepEqual(registry.status("s1")!.result, RESULT);
  });

  test("→ failed on backend error, error captured", async () => {
    const registry = new IndexRegistry({ indexFn: async () => { throw new Error("quota exceeded"); } });
    const src = { id: "s1", filePath: "/f.mp4" };

    await assert.rejects(() => registry.ensure(src), /quota exceeded/);
    assert.equal(registry.status("s1")!.status, "failed");
    assert.match(registry.status("s1")!.error!, /quota exceeded/);
  });

  test("start() is fire-and-forget: a failing job never throws out", async () => {
    const registry = new IndexRegistry({ indexFn: async () => { throw new Error("boom"); } });
    registry.start({ id: "s1", filePath: "/f.mp4" });   // must not reject unhandled
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(registry.status("s1")!.status, "failed");
  });
});

// ── Dedupe ────────────────────────────────────────────────────────────────────

describe("IndexRegistry — dedupe", () => {
  test("two concurrent demands for the same source run exactly one index job", async () => {
    let calls = 0;
    const d = deferred<IndexResult>();
    const registry = new IndexRegistry({ indexFn: async () => { calls++; return d.promise; } });
    const src = { id: "s1", filePath: "/f.mp4" };

    const [pa, pb] = [registry.ensure(src), registry.ensure(src)];
    d.resolve(RESULT);
    const [a, b] = await Promise.all([pa, pb]);
    assert.equal(calls, 1, "exactly one index job despite two demands");
    assert.deepEqual(a, RESULT);
    assert.deepEqual(b, RESULT);
  });

  test("a failed job is retried on the next demand (pre-slice lazy behavior)", async () => {
    let calls = 0;
    const registry = new IndexRegistry({
      indexFn: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
        return RESULT;
      },
    });
    const src = { id: "s1", filePath: "/f.mp4" };

    await assert.rejects(() => registry.ensure(src), /transient/);
    const r = await registry.ensure(src);   // retry succeeds
    assert.deepEqual(r, RESULT);
    assert.equal(calls, 2);
    assert.equal(registry.status("s1")!.status, "ready");
  });
});

// ── Concurrency cap ───────────────────────────────────────────────────────────

describe("IndexRegistry — concurrency cap", () => {
  test("bounds simultaneous in-flight jobs; the rest queue", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const registry = new IndexRegistry({
      concurrency: 2,
      indexFn: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return RESULT;
      },
    });

    await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => registry.ensure({ id, filePath: `/f/${id}.mp4` })),
    );
    assert.ok(maxInFlight <= 2, `max in-flight ${maxInFlight} must respect the cap`);
  });
});

// ── Tool integration (find_visual_moment) ─────────────────────────────────────

describe("find_visual_moment — through the registry", () => {
  test("a tool needing the index AWAITS a running background job, never starts a second", async () => {
    const state = makeState();
    const source = state.sources[0]!;
    const d = deferred<IndexResult>();
    let backgroundCalls = 0;
    const registry = new IndexRegistry({ indexFn: async () => { backgroundCalls++; return d.promise; } });

    // Background job in flight (as /open would have started it).
    registry.start({ id: source.id, filePath: source.filePath });
    await new Promise((r) => setImmediate(r));
    assert.equal(registry.status(source.id)!.status, "running");

    // The tool's own backend must NOT be asked to index — it joins the job.
    const backend = {
      indexVideo: async (): Promise<IndexResult> => { throw new Error("tool must not start a second index"); },
      searchMoments: async () => [{ start: 3, end: 7, confidence: 0.9 }],
    };

    const toolPromise = executeFindVisualMoment(state, { sourceId: source.id, query: "the reveal" }, backend, registry);
    d.resolve(RESULT);
    const r = await toolPromise;

    assert.ok(r.ok, `tool failed: ${!r.ok ? r.error : ""}`);
    assert.deepEqual(r.result.hits, [{ start: 3, end: 7, confidence: 0.9 }]);
    assert.equal(backgroundCalls, 1, "exactly one index job total");
    // The tool persisted the index result into analyses (durable across sessions).
    assert.ok(r.stateUpdate);
    assert.equal(r.stateUpdate!.sources[0]!.analyses.twelveLabs?.videoId, RESULT.videoId);
  });

  test("a failed background index surfaces as a clean tool error; non-perception edits still work", async () => {
    const state = makeState();
    const source = state.sources[0]!;
    const registry = new IndexRegistry({ indexFn: async () => { throw new Error("bad key"); } });

    registry.start({ id: source.id, filePath: source.filePath });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(registry.status(source.id)!.status, "failed");

    // Tool demand retries (matching lazy behavior), fails again, surfaces cleanly.
    const backend = {
      indexVideo: async (): Promise<IndexResult> => { throw new Error("bad key"); },
      searchMoments: async () => [],
    };
    const r = await executeFindVisualMoment(state, { sourceId: source.id, query: "x" }, backend, registry);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /TwelveLabs indexing failed: bad key/);

    // Editing operations that don't need the index are untouched by the failure.
    const session = createSession(state);
    const clipId = state.timeline.headId!;
    const applied = applyPlan(session, "trim it", [{ type: "trim", clipId, inPoint: 0, outPoint: 30 }]);
    assert.ok(applied.ok, "trim works with a failed index");
  });

  test("an already-indexed source (cache hit) demands no job at all", async () => {
    let state = makeState();
    const source = state.sources[0]!;
    state = withIndexed(state, source.id);

    const registry = new IndexRegistry({ indexFn: async () => { throw new Error("must not index"); } });
    const backend = {
      indexVideo: async (): Promise<IndexResult> => { throw new Error("must not index"); },
      searchMoments: async () => [{ start: 1, end: 2, confidence: 0.5 }],
    };

    const r = await executeFindVisualMoment(state, { sourceId: source.id, query: "q" }, backend, registry);
    assert.ok(r.ok);
    assert.equal(registry.status(source.id), undefined, "no job was ever created");
  });
});

// ── Scout fan-out stress: mixed index states, concurrent demands ──────────────

describe("background indexing — concurrent mixed-state fan-out", () => {
  test("fresh + cached + failing sources resolve correctly under concurrent demand", async () => {
    let state = makeState(3);
    const [fresh, cachedSrc, failing] = state.sources;
    state = withIndexed(state, cachedSrc!.id);

    const dFresh = deferred<IndexResult>();
    let indexCalls = 0;
    const registry = new IndexRegistry({
      indexFn: async (filePath) => {
        indexCalls++;
        if (filePath === failing!.filePath) throw new Error("indexing down");
        return dFresh.promise;
      },
    });
    const backend = {
      // The per-call fn the tool passes routes to the registry's default here.
      indexVideo: async (): Promise<IndexResult> => { throw new Error("unused — registry default wins on new jobs only when tool passes fn"); },
      searchMoments: async () => [{ start: 0, end: 1, confidence: 1 }],
    };
    // The tool passes its backend fn for NEW jobs, so make it behave per-source:
    const perSourceBackend = (src: SourceFile) => ({
      indexVideo: async (): Promise<IndexResult> => {
        indexCalls++;
        if (src.id === failing!.id) throw new Error("indexing down");
        return dFresh.promise;
      },
      searchMoments: backend.searchMoments,
    });

    // Two concurrent demands per source — like parallel scouts hitting the map.
    const runs = [fresh!, fresh!, cachedSrc!, cachedSrc!, failing!, failing!].map((src) =>
      executeFindVisualMoment(state, { sourceId: src.id, query: "moment" }, perSourceBackend(src), registry),
    );
    setTimeout(() => dFresh.resolve(RESULT), 10);
    const results = await Promise.all(runs);

    // Fresh source: both succeed off ONE job.
    assert.ok(results[0]!.ok && results[1]!.ok);
    // Cached source: both succeed, no job created.
    assert.ok(results[2]!.ok && results[3]!.ok);
    assert.equal(registry.status(cachedSrc!.id), undefined);
    // Failing source: both fail cleanly (first job + one retry at most — dedupe
    // still bounds it), nothing throws out of Promise.all.
    assert.ok(!results[4]!.ok && !results[5]!.ok);
    assert.match(!results[4]!.ok ? results[4]!.error : "", /indexing failed/);

    assert.equal(registry.status(fresh!.id)!.status, "ready");
    assert.equal(registry.status(failing!.id)!.status, "failed");
    // One job for the fresh source; the failing source at most 2 (initial + retry).
    assert.ok(indexCalls <= 3, `index attempts bounded, got ${indexCalls}`);
  });
});

// ── /open is non-blocking ─────────────────────────────────────────────────────

describe("/open — background indexing is fire-and-forget", () => {
  test("/open returns while the index job is still in flight", async (t) => {
    // Needs ffprobe + the repo test asset; skip cleanly where unavailable.
    const assetPath = join(REPO_ROOT, "test-assets", "test.mp4");
    const probeCheck = await import("../media/probe.js").then((m) => m.probeFile(assetPath)).catch(() => null);
    if (!probeCheck || !probeCheck.ok) { t.skip("ffprobe or test asset unavailable"); return; }

    const originalRegistry = getDefaultIndexRegistry();
    const hadKey = process.env["TWELVELABS_API_KEY"];
    const never = deferred<IndexResult>();   // a job that NEVER completes
    let started = 0;
    try {
      process.env["TWELVELABS_API_KEY"] = "test-key";
      setDefaultIndexRegistry(new IndexRegistry({ indexFn: async () => { started++; return never.promise; } }));

      const state: ReplState = { session: createSession(createProject("t")), messages: [], autoApprove: false };
      const r = await dispatch(`/open ${assetPath}`, state);   // would hang forever if /open awaited indexing

      assert.equal(r.isError, false);
      assert.match(r.output, /Added to project/);
      assert.match(r.output, /indexing started in background/);

      const newSourceId = r.newState!.session!.state.sources[0]!.id;
      await new Promise((res) => setImmediate(res));
      assert.equal(getDefaultIndexRegistry().status(newSourceId)!.status, "running");
      assert.equal(started, 1);
    } finally {
      setDefaultIndexRegistry(originalRegistry);
      if (hadKey === undefined) delete process.env["TWELVELABS_API_KEY"];
      else process.env["TWELVELABS_API_KEY"] = hadKey;
    }
  });
});

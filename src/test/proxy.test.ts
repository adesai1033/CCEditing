import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { planProxyChunks, buildProxyArgs, makeProxy, withDecodeSlot, setDecodeSlots, DESCRIBE_PROXY, INDEX_PROXY } from "../media/proxy.js";
import type { FfmpegRunner } from "../engine/preview.js";

let root: string;
before(() => { root = mkdtempSync(join(tmpdir(), "cutcli-proxy-test-")); });
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function source(name = "src.mov"): string {
  const p = join(root, name);
  writeFileSync(p, `dummy-${name}-${Math.random()}`);
  return p;
}

function mockFfmpeg(opts: { failOnCall?: number; delayMs?: number } = {}) {
  const calls: string[][] = [];
  const runner: FfmpegRunner = async (args, o) => {
    calls.push(args);
    const n = calls.length;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (o?.signal?.aborted) return { ok: false, code: "ABORTED", error: "cancelled" };
    if (n === opts.failOnCall) return { ok: false, code: "FFMPEG_FAILED", error: "boom" };
    await writeFile(args[args.length - 1]!, "proxy");
    return { ok: true };
  };
  return { runner, calls };
}

const probe = (duration: number, fps = 60) => async () => ({ duration, fps });

describe("planProxyChunks", () => {
  test("short windows stay one chunk", () => {
    assert.deepEqual(planProxyChunks(55, 80, 4), [{ start: 55, duration: 25 }]);
    assert.deepEqual(planProxyChunks(0, 10, 4), [{ start: 0, duration: 10 }]);
  });

  test("long windows split into whole-second chunks, the last taking the remainder", () => {
    const c = planProxyChunks(0, 143.4917, 4);
    assert.equal(c.length, 4);
    assert.deepEqual(c.slice(0, 3).map((x) => x.duration), [36, 36, 36]);
    assert.ok(Math.abs(c[3]!.duration - 35.4917) < 1e-9);
    assert.deepEqual(c.map((x) => x.start), [0, 36, 72, 108]);
    // Every internal boundary is a whole second, so it's a multiple of any 1/fps.
    assert.ok(c.slice(0, -1).every((x) => Number.isInteger(x.duration)));
  });

  test("never more chunks than the concurrency or than 15s pieces allow", () => {
    assert.equal(planProxyChunks(0, 40, 8).length, 2);
    assert.equal(planProxyChunks(0, 600, 4).length, 4);
    assert.equal(planProxyChunks(0, 600, 1).length, 1);
  });
});

describe("buildProxyArgs", () => {
  test("seeks before the input, caps fps and the short side, keeps one audio track", () => {
    const a = buildProxyArgs("/in.mov", { start: 36, duration: 36 }, DESCRIBE_PROXY, 60, "/out.mp4", "darwin");
    assert.deepEqual(a.slice(0, 2), ["-hwaccel", "videotoolbox"]);
    assert.ok(a.indexOf("-ss") < a.indexOf("-i"));
    assert.equal(a[a.indexOf("-ss") + 1], "36");
    assert.equal(a[a.indexOf("-t") + 1], "36");
    const vf = a[a.indexOf("-vf") + 1]!;
    assert.match(vf, /^fps=2,scale=/);
    assert.match(vf, /min\(480\\,iw\)/);
    assert.match(vf, /min\(480\\,ih\)/);
    assert.deepEqual(a.slice(a.indexOf("-map"), a.indexOf("-map") + 4), ["-map", "0:v:0", "-map", "0:a:0?"]);
    assert.equal(a[a.length - 1], "/out.mp4");
  });

  test("never raises the source frame rate; no hwaccel off macOS", () => {
    const a = buildProxyArgs("/in.mov", { start: 0, duration: 5 }, INDEX_PROXY, 24, "/o.mp4", "linux");
    assert.ok(!a.includes("-hwaccel"));
    assert.match(a[a.indexOf("-vf") + 1]!, /^fps=24,/);
  });
});

describe("makeProxy", () => {
  test("a long source is transcoded in parallel chunks, joined, and cached", async () => {
    const src = source();
    const cacheDir = join(root, "cache1");
    const { runner, calls } = mockFfmpeg();
    const r = await makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(143.5), platform: "linux" });
    assert.equal(r.cached, false);
    assert.equal(r.chunks, 4);
    assert.equal(calls.length, 5, "4 chunks + 1 concat");
    assert.ok(calls[4]!.includes("concat"));
    assert.ok(existsSync(r.path));
    assert.deepEqual(readdirSync(cacheDir).filter((n) => !n.endsWith(".mp4")), [], "work dir cleaned up");

    const again = await makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(143.5) });
    assert.equal(again.cached, true);
    assert.equal(again.path, r.path);
    assert.equal(calls.length, 5, "no re-transcode");
  });

  test("a window is its own cache entry and a single pass", async () => {
    const src = source();
    const cacheDir = join(root, "cache2");
    const { runner, calls } = mockFfmpeg();
    const whole = await makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(25) });
    const win = await makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(138), start: 55, end: 80 });
    assert.notEqual(whole.path, win.path);
    assert.equal(win.chunks, 1);
    const last = calls[calls.length - 1]!;
    assert.equal(last[last.indexOf("-ss") + 1], "55");
    assert.equal(last[last.indexOf("-t") + 1], "25");
  });

  test("windows are clamped to the source; an empty window is an error", async () => {
    const src = source();
    const cacheDir = join(root, "cache3");
    const { runner, calls } = mockFfmpeg();
    await makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(30), start: 20, end: 99 });
    assert.equal(calls[0]![calls[0]!.indexOf("-t") + 1], "10");
    await assert.rejects(makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(30), start: 40, end: 50 }), /Empty window/);
  });

  test("concurrent requests for the same proxy share one transcode", async () => {
    const src = source();
    const cacheDir = join(root, "cache4");
    const { runner, calls } = mockFfmpeg({ delayMs: 20 });
    const [a, b] = await Promise.all([
      makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(10) }),
      makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(10) }),
    ]);
    assert.equal(a.path, b.path);
    assert.equal(calls.length, 1);
  });

  test("a failed chunk aborts its siblings, reports the error, and leaves nothing cached", async () => {
    const src = source();
    const cacheDir = join(root, "cache5");
    const { runner } = mockFfmpeg({ failOnCall: 2, delayMs: 5 });
    await assert.rejects(
      makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir, ffmpeg: runner, probe: probe(120) }),
      /upload proxy of .* failed: boom/,
    );
    assert.deepEqual(readdirSync(cacheDir), [], "no partial proxy, no work dir");
  });

  test("an unreadable source is a clear error", async () => {
    const src = source();
    await assert.rejects(
      makeProxy(src, DESCRIBE_PROXY, { fromOriginal: true, cacheDir: join(root, "cache6"), ffmpeg: mockFfmpeg().runner, probe: async () => null }),
      /Could not read/,
    );
  });
});

// ── Hedged Gemini requests ────────────────────────────────────────────────────

import { hedged, isTransient, retryTransient } from "../agent/backends/gemini.js";

describe("hedged", () => {
  /** An attempt that resolves to `value` after `ms`, recording starts and aborts. */
  function attempts(plan: Array<{ ms: number; value?: string; fail?: string }>) {
    const started: number[] = [];
    const aborted: number[] = [];
    const t0 = Date.now();
    let i = 0;
    const attempt = (signal: AbortSignal) => {
      const idx = i++;
      const step = plan[idx]!;
      started.push(Date.now() - t0);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => (step.fail ? reject(new Error(step.fail)) : resolve(step.value ?? `#${idx}`)), step.ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); aborted.push(idx); reject(new Error("aborted")); }, { once: true });
      });
    };
    return { attempt, started, aborted };
  }

  test("a fast first attempt never hedges", async () => {
    const a = attempts([{ ms: 5, value: "first" }]);
    assert.equal(await hedged(a.attempt, { hedgeAfterMs: 50, deadlineMs: 1000, timeoutMessage: "t" }), "first");
    assert.equal(a.started.length, 1);
  });

  test("a slow first attempt is raced by a backup; the winner's value returns and the loser is aborted", async () => {
    const a = attempts([{ ms: 500, value: "slow" }, { ms: 10, value: "backup" }]);
    assert.equal(await hedged(a.attempt, { hedgeAfterMs: 30, deadlineMs: 2000, timeoutMessage: "t" }), "backup");
    assert.equal(a.started.length, 2);
    assert.ok(a.started[1]! >= 25, "backup starts only after the hedge delay");
    assert.deepEqual(a.aborted, [0]);
  });

  test("a hard (non-transient) failure starts the next attempt immediately", async () => {
    const a = attempts([{ ms: 5, fail: "400 bad request" }, { ms: 5, value: "ok" }]);
    assert.equal(await hedged(a.attempt, { hedgeAfterMs: 1000, deadlineMs: 2000, timeoutMessage: "t" }), "ok");
    assert.ok(a.started[1]! < 100);
  });

  test("when every attempt fails, the last error is reported", async () => {
    const a = attempts([{ ms: 1, fail: "a" }, { ms: 1, fail: "b" }, { ms: 1, fail: "c" }]);
    await assert.rejects(hedged(a.attempt, { hedgeAfterMs: 1000, maxAttempts: 3, deadlineMs: 2000, timeoutMessage: "t" }), /^Error: c$/);
  });

  test("the overall deadline wins over slow attempts and aborts them all", async () => {
    const a = attempts([{ ms: 1000 }, { ms: 1000 }, { ms: 1000 }]);
    await assert.rejects(hedged(a.attempt, { hedgeAfterMs: 10, maxAttempts: 3, deadlineMs: 60, timeoutMessage: "too slow" }), /too slow/);
    assert.equal(a.started.length, 3, "hedged up to the cap before the deadline");
    assert.deepEqual([...a.aborted].sort(), [0, 1, 2]);
  });
});

describe("transient Gemini errors", () => {
  test("isTransient recognizes overload, rate limits, and dropped connections only", () => {
    assert.ok(isTransient(new Error('{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}')));
    assert.ok(isTransient(new Error("429 RESOURCE_EXHAUSTED")));
    assert.ok(isTransient(new Error("fetch failed")));
    assert.ok(!isTransient(new Error("400 INVALID_ARGUMENT")));
    assert.ok(!isTransient(new Error("API key not valid")));
  });

  test("retryTransient retries a 503 and gives up at once on a hard error", async () => {
    let n = 0;
    const v = await retryTransient(async () => { if (++n < 3) throw new Error("503 UNAVAILABLE"); return "ok"; }, { baseDelayMs: 1 });
    assert.equal(v, "ok");
    assert.equal(n, 3);
    let m = 0;
    await assert.rejects(retryTransient(async () => { m++; throw new Error("400 bad"); }, { baseDelayMs: 1 }), /400/);
    assert.equal(m, 1);
  });

  test("hedged backs off before relaunching after a transient failure", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    let i = 0;
    const v = await hedged(async () => {
      starts.push(Date.now() - t0);
      if (i++ === 0) throw new Error("503 UNAVAILABLE");
      return "ok";
    }, { hedgeAfterMs: 5000, retryDelayMs: 40, deadlineMs: 2000, timeoutMessage: "t" });
    assert.equal(v, "ok");
    assert.ok(starts[1]! >= 35, `second attempt waited (${starts[1]}ms)`);
  });
});

// ── One decode per source: derived proxies read the master ────────────────────

describe("master proxy", () => {
  test("a description proxy is cut from the cached 720p master, not the original", async () => {
    const src = source("orig.MOV");
    const cacheDir = join(root, "master1");
    const { runner, calls } = mockFfmpeg();
    const opts = { cacheDir, ffmpeg: runner, probe: probe(143.5, 60), platform: "linux" as const };

    const d = await makeProxy(src, DESCRIBE_PROXY, opts);
    // Master: 4 chunks from the original + concat; then ONE pass from the master.
    assert.equal(calls.length, 6);
    assert.ok(calls.slice(0, 4).every((a) => a[a.indexOf("-i") + 1] === src), "master chunks read the original");
    const derived = calls[5]!;
    const master = await makeProxy(src, INDEX_PROXY, opts);
    assert.equal(master.cached, true, "the master was cached by the first call");
    assert.equal(derived[derived.indexOf("-i") + 1], master.path, "the description proxy reads the master");
    assert.match(derived[derived.indexOf("-vf") + 1]!, /^fps=2,/);
    assert.equal(d.chunks, 1);

    // A window: one more pass, from the master, no new original decode.
    await makeProxy(src, DESCRIBE_PROXY, { ...opts, start: 55, end: 80 });
    assert.equal(calls.length, 7);
    assert.equal(calls[6]![calls[6]!.indexOf("-i") + 1], master.path);
    assert.equal(calls[6]![calls[6]!.indexOf("-ss") + 1], "55");
  });

  test("fromOriginal skips the master", async () => {
    const src = source("orig2.MOV");
    const { runner, calls } = mockFfmpeg();
    await makeProxy(src, DESCRIBE_PROXY, { cacheDir: join(root, "master2"), ffmpeg: runner, probe: probe(10), fromOriginal: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![calls[0]!.indexOf("-i") + 1], src);
  });
});

describe("decode slots", () => {
  test("never more heavy decodes at once than the slot count", async () => {
    const prev = setDecodeSlots(2);
    try {
      let active = 0;
      let peak = 0;
      await Promise.all(Array.from({ length: 7 }, () => withDecodeSlot(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      })));
      assert.equal(peak, 2);
    } finally {
      setDecodeSlots(prev);
    }
  });

  test("a failing job releases its slot", async () => {
    const prev = setDecodeSlots(1);
    try {
      await assert.rejects(withDecodeSlot(async () => { throw new Error("boom"); }));
      assert.equal(await withDecodeSlot(async () => "next"), "next");
    } finally {
      setDecodeSlots(prev);
    }
  });
});

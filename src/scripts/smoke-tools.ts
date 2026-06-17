/**
 * Smoke-test each analysis tool against a real video file with real API keys.
 * Not part of `npm test` — invoke manually after `npm run build`:
 *
 *   TWELVELABS_API_KEY=... GEMINI_API_KEY=... \
 *     node dist/scripts/smoke-tools.js test-assets/test_trimmed.mp4
 *
 * Tools print their result and the populated cache field. Each tool is
 * exercised twice to verify the cache hit path.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { probeFile } from "../media/probe.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";

import { queryTimeline } from "../agent/tools/query_timeline.js";
import { describeClip } from "../agent/tools/describe_clip.js";
import { describeSegment } from "../agent/tools/describe_segment.js";
import { detectScenes } from "../agent/tools/detect_scenes.js";
import { findVisualMoment } from "../agent/tools/find_visual_moment.js";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node dist/scripts/smoke-tools.js <video-file>");
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const probe = await probeFile(abs);
  if (!probe.ok) {
    console.error(`Probe failed: ${probe.error}`);
    process.exit(1);
  }
  let state = createProject("smoke");
  const r = addSource(state, probe.data);
  if (!r.ok) {
    console.error(`addSource failed: ${r.error}`);
    process.exit(1);
  }
  state = r.state;
  const sourceId = state.sources[0]!.id;

  console.log("\n── query_timeline ──");
  const qt = await queryTimeline.execute(state, {});
  console.log(JSON.stringify(qt, null, 2));

  console.log("\n── detect_scenes (real ffmpeg) ──");
  const ds = await detectScenes.execute(state, { sourceId });
  console.log(JSON.stringify(ds, null, 2));
  if (ds.ok && ds.stateUpdate) state = ds.stateUpdate;

  if (process.env["GEMINI_API_KEY"]) {
    console.log("\n── describe_clip (Gemini, first call) ──");
    const dc1 = await describeClip.execute(state, { sourceId });
    console.log(JSON.stringify(dc1, null, 2));
    if (dc1.ok && dc1.stateUpdate) state = dc1.stateUpdate;

    console.log("\n── describe_clip (cache hit) ──");
    const dc2 = await describeClip.execute(state, { sourceId });
    console.log(JSON.stringify(dc2, null, 2));

    const half = Math.max(1, Math.floor(probe.data.duration / 2));
    console.log(`\n── describe_segment 0-${half}s (Gemini, first window) ──`);
    const ds1 = await describeSegment.execute(state, { sourceId, start: 0, end: half });
    console.log(JSON.stringify(ds1, null, 2));
    if (ds1.ok && ds1.stateUpdate) state = ds1.stateUpdate;

    console.log(`\n── describe_segment 0-${half}s (cache hit) ──`);
    const ds2 = await describeSegment.execute(state, { sourceId, start: 0, end: half });
    console.log(JSON.stringify(ds2, null, 2));
  } else {
    console.log("\n── describe_clip + describe_segment: skipped (GEMINI_API_KEY not set) ──");
  }

  if (process.env["TWELVELABS_API_KEY"]) {
    console.log("\n── find_visual_moment (TwelveLabs, first call: indexing) ──");
    const fm1 = await findVisualMoment.execute(state, { sourceId, query: "person moving" });
    console.log(JSON.stringify(fm1, null, 2));
    if (fm1.ok && fm1.stateUpdate) state = fm1.stateUpdate;

    console.log("\n── find_visual_moment (cache hit, same query) ──");
    const fm2 = await findVisualMoment.execute(state, { sourceId, query: "person moving" });
    console.log(JSON.stringify(fm2, null, 2));
  } else {
    console.log("\n── find_visual_moment: skipped (TWELVELABS_API_KEY not set) ──");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

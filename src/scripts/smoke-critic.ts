import "../utils/env.js";
import { runCritic, type CriticInput } from "../agent/critic.js";
import { buildDefaultProvider } from "../agent/providers/default.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import type { ContentMap } from "../agent/content-map.js";
import type { MediaInfo } from "../media/types.js";

/**
 * Live smoke for the 3G critic's two failure modes (decision 6), against the
 * real provider:
 *
 *  1. A rubber-stamp critic (approves everything) is cost with no benefit —
 *     so a plan with a mid-word cut AND a blown duration target must come
 *     back `revise`.
 *  2. A nitpicking critic (revises everything) guarantees two rounds per
 *     plan — so a clean, boundary-verified plan must come back `approve`.
 *
 * Run: npm run build && node dist/scripts/smoke-critic.js
 */

function media(name: string, duration: number): MediaInfo {
  return {
    filePath: `/fake/${name}`, fileName: name, duration,
    width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128, fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4",
  };
}

const withSource = addSource(createProject("smoke"), media("talk.mp4", 120));
if (!withSource.ok) throw new Error(withSource.error);
const state = withSource.state;
const clipId = state.timeline.headId!;
const sourceId = state.sources[0]!.id;

// The map says: speech segment 2.0–9.4 ("intro flub"), silence 9.4–11.0,
// strong take 11.0–41.5, silence 41.5–43.0, closer 43.0–60.0, dead air after.
const contentMap: ContentMap = {
  sources: [{
    sourceId, displayRef: "1", duration: 120,
    outline: [
      { start: 0, end: 2, gist: "dead air before speaking starts" },
      { start: 2, end: 9.4, gist: "flubbed intro take, restarted" },
      { start: 11, end: 41.5, gist: "strong second take of the pitch" },
      { start: 43, end: 60, gist: "closer and call to action" },
      { start: 60, end: 120, gist: "b-roll, mostly silent" },
    ],
    keyMoments: [{ time: 11, gist: "the strong take begins" }],
    silences: [
      { start: 0, end: 2 }, { start: 9.4, end: 11 },
      { start: 41.5, end: 43 }, { start: 60, end: 120 },
    ],
    label: "good take (11s–41.5s)",
  }],
  truncated: false,
};

const userRequest = "tighten this to about 30 seconds, keep the good take, cut anything flat";

// Plan A — deliberately weak: opens mid-word inside the strong take (cut at
// 14.7s, not a boundary), runs 55s against a ~30s target, and keeps the
// flubbed intro the map marks flat.
const badPlan: CriticInput = {
  userRequest, contentMap, timelineState: state,
  plan: {
    summary: "Tighten the video.",
    operations: [
      { type: "trim", clipId, inPoint: 5, outPoint: 60 },
      { type: "split", clipId, splitPoint: 14.7 },
      { type: "move", clipId, newIndex: 1 },
    ],
  },
  renderedPlan: [
    "Trim clip [1] talk.mp4 → 0:05–1:00",
    "Split clip [1] talk.mp4 at 0:14.7",
    "Move clip [1] talk.mp4 → position 2",
  ],
};

// Plan B — clean: keeps exactly the labeled good take, cut on the silence
// boundaries the map reports, resulting duration 30.5s ≈ the stated target.
const goodPlan: CriticInput = {
  userRequest, contentMap, timelineState: state,
  plan: {
    summary: "Keep the strong take (11s–41.5s), cutting on its silence boundaries — 30.5s total.",
    operations: [{ type: "trim", clipId, inPoint: 11, outPoint: 41.5 }],
  },
  renderedPlan: ["Trim clip [1] talk.mp4 → 0:11–0:41.5"],
};

const provider = buildDefaultProvider();
const warn = (m: string) => console.log(`  [warn] ${m}`);

console.log("critic vs the deliberately weak plan (must revise):");
const bad = await runCritic(badPlan, { provider, onWarn: warn });
console.log(`  verdict: ${bad.verdict}`);
for (const c of bad.concerns) {
  console.log(`  - [${c.severity}]${c.operationIndex !== undefined ? ` op ${c.operationIndex}` : ""} ${c.issue}`);
}

console.log("\ncritic vs the clean plan (must approve):");
const good = await runCritic(goodPlan, { provider, onWarn: warn });
console.log(`  verdict: ${good.verdict}`);
for (const c of good.concerns) {
  console.log(`  - [${c.severity}]${c.operationIndex !== undefined ? ` op ${c.operationIndex}` : ""} ${c.issue}`);
}

const pass = bad.verdict === "revise" && good.verdict === "approve";
console.log(`\n${pass ? "PASS" : "FAIL"}: weak → ${bad.verdict}, clean → ${good.verdict}`);
process.exit(pass ? 0 : 1);

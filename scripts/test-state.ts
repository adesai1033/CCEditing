/**
 * End-to-end test for the Slice 3A state model.
 * Run with: npx tsx scripts/test-state.ts
 *
 * Verifies: createProject → addSource → trimClip → addSource →
 *           reorderClip → saveProject → loadProject → state equality
 */
import path from "node:path";
import { createProject, saveProject, loadProject } from "../src/project/io.js";
import { addSource, trimClip, reorderClip, renameClip, removeClip, removeSource } from "../src/project/mutations.js";
import type { MediaInfo } from "../src/media/types.js";

const OUT_FILE = "/tmp/test-project.cutcli.json";

// ── Mock media info ───────────────────────────────────────────────────────────

function mockMedia(name: string, duration: number): MediaInfo {
  return {
    filePath: `/videos/${name}`,
    fileName: name,
    duration,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: 2,
    audioBitrate: 128,
    fileSize: 100_000_000,
    bitrate: 8000,
    containerFormat: "mov,mp4",
  };
}

// ── Assertions ────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

function assertOk<T extends { ok: boolean }>(
  result: T,
  message: string
): asserts result is T & { ok: true } {
  if (!result.ok) {
    const err = (result as { ok: false; error: string }).error;
    console.error(`  ✗ FAIL: ${message} — ${err}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

function assertFail(result: { ok: boolean; error?: string }, message: string): void {
  if (result.ok) {
    console.error(`  ✗ FAIL: expected error but got ok — ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message} (correctly rejected: ${(result as { ok: false; error: string }).error})`);
}

// ── Test ──────────────────────────────────────────────────────────────────────

console.log("\nSlice 3A — State Model Test\n");

// 1. Create project
let state = createProject("Test Project");
console.log("1. createProject");
assert(state.name === "Test Project", "project name is set");
assert(state.version === 1, "version is 1");
assert(state.sources.length === 0, "no sources");
assert(state.timeline.clips.length === 0, "empty timeline");

// 2. Add first source — should also create a clip covering full duration
console.log("\n2. addSource (vacation.mp4, 272s)");
const r1 = addSource(state, mockMedia("vacation.mp4", 272));
assertOk(r1, "addSource ok");
state = r1.state;
assert(state.sources.length === 1, "one source");
assert(state.timeline.clips.length === 1, "one clip on timeline");
const clip1 = state.timeline.clips[0]!;
assert(clip1.inPoint === 0, "clip inPoint is 0");
assert(clip1.outPoint === 272, "clip outPoint matches source duration");
assert(clip1.label === "vacation.mp4", "clip label defaults to fileName");

// 3. Trim the clip (seconds 30 → 120)
console.log("\n3. trimClip (30s → 120s)");
const r2 = trimClip(state, clip1.id, { inPoint: 30, outPoint: 120 });
assertOk(r2, "trimClip ok");
state = r2.state;
const trimmed = state.timeline.clips[0]!;
assert(trimmed.inPoint === 30, "inPoint updated");
assert(trimmed.outPoint === 120, "outPoint updated");
assert(trimmed.outPoint - trimmed.inPoint === 90, "clip duration is 90s");

// 4. Trim validation — bad inputs
console.log("\n4. trimClip validation");
assertFail(trimClip(state, clip1.id, { inPoint: 150, outPoint: 120 }), "inPoint > outPoint rejected");
assertFail(trimClip(state, clip1.id, { inPoint: -5 }), "negative inPoint rejected");
assertFail(trimClip(state, clip1.id, { outPoint: 9999 }), "outPoint beyond source duration rejected");
assertFail(trimClip(state, "nonexistent-id", {}), "unknown clipId rejected");

// 5. Rename clip
console.log("\n5. renameClip");
const r3 = renameClip(state, clip1.id, "Intro");
assertOk(r3, "renameClip ok");
state = r3.state;
assert(state.timeline.clips[0]!.label === "Intro", "clip label updated");
assertFail(renameClip(state, clip1.id, "  "), "empty label rejected");

// 6. Add second source
console.log("\n6. addSource (broll.mp4, 60s)");
const r4 = addSource(state, mockMedia("broll.mp4", 60));
assertOk(r4, "addSource ok");
state = r4.state;
assert(state.sources.length === 2, "two sources");
assert(state.timeline.clips.length === 2, "two clips");
const clip2 = state.timeline.clips[1]!;
assert(clip2.outPoint === 60, "second clip covers full duration");

// 7. Reorder — move clip2 to index 0
console.log("\n7. reorderClip (clip2 to index 0)");
const r5 = reorderClip(state, clip2.id, 0);
assertOk(r5, "reorderClip ok");
state = r5.state;
assert(state.timeline.clips[0]!.id === clip2.id, "broll.mp4 is now first");
assert(state.timeline.clips[1]!.id === clip1.id, "vacation.mp4 is now second");
assertFail(reorderClip(state, clip2.id, 99), "out-of-range index rejected");

// 8. Remove clip1
console.log("\n8. removeClip (clip1)");
const r6 = removeClip(state, clip1.id);
assertOk(r6, "removeClip ok");
state = r6.state;
assert(state.timeline.clips.length === 1, "one clip remains");
assert(state.sources.length === 2, "source files unchanged");

// 9. removeSource — cascade deletes all referencing clips
console.log("\n9. removeSource (cascade)");
// Add a third source with two clips referencing it
const r7 = addSource(state, mockMedia("extra.mp4", 30));
assertOk(r7, "addSource extra.mp4 ok");
state = r7.state;
const extraSource = state.sources.find((s) => s.fileName === "extra.mp4")!;
const extraClip = state.timeline.clips.find((c) => c.sourceId === extraSource.id)!;
// Trim the extra clip to create a second clip from same source
const r8 = addSource(state, mockMedia("extra.mp4", 30));
assertOk(r8, "addSource extra.mp4 second instance ok");
state = r8.state;
const clipsBefore = state.timeline.clips.filter((c) => c.sourceId === extraSource.id).length;
assert(clipsBefore === 1, "one clip references extra source before removal");
const r9 = removeSource(state, extraSource.id);
assertOk(r9, "removeSource ok");
state = r9.state;
assert(!state.sources.find((s) => s.id === extraSource.id), "source removed");
assert(!state.timeline.clips.find((c) => c.id === extraClip.id), "referencing clip removed");
assertFail(removeSource(state, "nonexistent-id"), "unknown sourceId rejected");

// 10. renameClip trims whitespace
console.log("\n10. renameClip trims whitespace");
const remainingClip = state.timeline.clips[0]!;
const r10 = renameClip(state, remainingClip.id, "  Padded Label  ");
assertOk(r10, "renameClip with padded label ok");
state = r10.state;
assert(state.timeline.clips[0]!.label === "Padded Label", "label stored without surrounding whitespace");

// 11. loadProject rejects malformed files
console.log("\n11. loadProject structural validation");
const { writeFile } = await import("node:fs/promises");
await writeFile("/tmp/bad-project.cutcli.json", JSON.stringify({ version: 1 }), "utf-8");
try {
  await loadProject("/tmp/bad-project.cutcli.json");
  console.error("  ✗ FAIL: should have thrown for missing fields");
  process.exit(1);
} catch (e) {
  console.log(`  ✓ missing fields throws (${(e as Error).message})`);
}

// 12. Save to disk
console.log("\n12. saveProject");
await saveProject(state, OUT_FILE);
console.log(`  ✓ saved to ${OUT_FILE}`);

// 13. Load back and verify
console.log("\n13. loadProject");
const loaded = await loadProject(OUT_FILE);
assert(loaded.name === state.name, "name matches");
assert(loaded.version === state.version, "version matches");
assert(loaded.sources.length === state.sources.length, "source count matches");
assert(loaded.timeline.clips.length === state.timeline.clips.length, "clip count matches");
assert(loaded.timeline.clips[0]!.id === state.timeline.clips[0]!.id, "clip id matches");
assert(loaded.updatedAt === state.updatedAt, "updatedAt matches");

// 14. Load error cases
console.log("\n14. loadProject error cases");
try {
  await loadProject("/tmp/nonexistent.cutcli.json");
  console.error("  ✗ FAIL: should have thrown for missing file");
  process.exit(1);
} catch (e) {
  console.log(`  ✓ missing file throws (${(e as Error).message})`);
}

console.log("\nAll tests passed.\n");

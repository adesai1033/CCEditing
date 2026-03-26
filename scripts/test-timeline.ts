/**
 * Visual test for the Slice 3B ASCII timeline renderer.
 * Run with: npx tsx scripts/test-timeline.ts
 *
 * No assertions — visual output is the verification.
 */
import { createProject } from "../src/project/io.js";
import { addSource } from "../src/project/mutations.js";
import { renderTimeline } from "../src/display/timeline.js";
import type { MediaInfo } from "../src/media/types.js";

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

function print(label: string, state: ReturnType<typeof createProject>) {
  console.log(`\n─── ${label} ${"─".repeat(Math.max(0, 60 - label.length - 5))}`);
  console.log(renderTimeline(state, 80));
}

// 1. Empty timeline
print("Empty timeline", createProject("Test"));

// 2. Single clip (30s)
{
  let s = createProject("Single Clip");
  const r = addSource(s, mockMedia("vacation.mp4", 30));
  if (r.ok) s = r.state;
  print("Single clip (30s)", s);
}

// 3. Two clips of equal duration
{
  let s = createProject("Equal Clips");
  let r = addSource(s, mockMedia("intro.mp4", 45));
  if (r.ok) s = r.state;
  r = addSource(s, mockMedia("outro.mp4", 45));
  if (r.ok) s = r.state;
  print("Two equal clips (45s + 45s)", s);
}

// 4. Three clips of very unequal duration
{
  let s = createProject("Unequal Clips");
  let r = addSource(s, mockMedia("main-feature-very-long-name.mp4", 120));
  if (r.ok) s = r.state;
  r = addSource(s, mockMedia("broll.mp4", 5));
  if (r.ok) s = r.state;
  r = addSource(s, mockMedia("outro.mp4", 40));
  if (r.ok) s = r.state;
  print("Three unequal clips (120s + 5s + 40s)", s);
}

// 5. Long timeline requiring minute-scale markers
{
  let s = createProject("Long Timeline");
  let r = addSource(s, mockMedia("act-one.mp4", 600));
  if (r.ok) s = r.state;
  r = addSource(s, mockMedia("act-two.mp4", 900));
  if (r.ok) s = r.state;
  r = addSource(s, mockMedia("act-three.mp4", 480));
  if (r.ok) s = r.state;
  print("Long timeline (600s + 900s + 480s = 33min)", s);
}

// 6. Many short clips (stress test label truncation)
{
  let s = createProject("Many Short Clips");
  const clips = [
    ["scene-01.mp4", 8],
    ["scene-02.mp4", 6],
    ["scene-03.mp4", 10],
    ["scene-04.mp4", 4],
    ["scene-05.mp4", 7],
    ["scene-06.mp4", 9],
    ["scene-07.mp4", 5],
  ] as const;
  for (const [name, dur] of clips) {
    const r = addSource(s, mockMedia(name, dur));
    if (r.ok) s = r.state;
  }
  print("Many short clips (7 clips)", s);
}

// 7. Narrow terminal (30 chars)
{
  let s = createProject("Narrow");
  let r = addSource(s, mockMedia("clip-a.mp4", 30));
  if (r.ok) s = r.state;
  r = addSource(s, mockMedia("clip-b.mp4", 20));
  if (r.ok) s = r.state;
  console.log("\n─── Narrow terminal (30 chars) ──────────────────────────────");
  console.log(renderTimeline(s, 30));
}

// 8. Exactly 72 clips — boundary: groupClips should NOT merge (each is own group)
{
  let s = createProject("Boundary 72 Clips");
  for (let i = 1; i <= 72; i++) {
    const r = addSource(s, mockMedia(`scene-${String(i).padStart(2, "0")}.mp4`, 5));
    if (r.ok) s = r.state;
  }
  print("72 clips (boundary, no grouping)", s);
}

// 9. 73 clips — one over the threshold, grouping kicks in for the first time
{
  let s = createProject("Just Over Threshold");
  for (let i = 1; i <= 73; i++) {
    const r = addSource(s, mockMedia(`scene-${String(i).padStart(2, "0")}.mp4`, 5));
    if (r.ok) s = r.state;
  }
  print("73 clips (one over threshold, grouping begins)", s);
}

// 10. 100 clips, uniform 5s each — the original overflow case
{
  let s = createProject("100 Uniform Clips");
  for (let i = 1; i <= 100; i++) {
    const r = addSource(s, mockMedia(`clip-${String(i).padStart(3, "0")}.mp4`, 5));
    if (r.ok) s = r.state;
  }
  print("100 uniform clips (5s each)", s);
}

// 11. 100 clips — one very long + 99 short (stress test group boundary arithmetic)
{
  let s = createProject("100 Unequal Clips");
  let r = addSource(s, mockMedia("feature.mp4", 3600));
  if (r.ok) s = r.state;
  for (let i = 1; i <= 99; i++) {
    r = addSource(s, mockMedia(`broll-${i}.mp4`, 2));
    if (r.ok) s = r.state;
  }
  print("100 unequal clips (1×3600s + 99×2s)", s);
}

// 12. 200 clips — 2× original failing count
{
  let s = createProject("200 Clips");
  for (let i = 1; i <= 200; i++) {
    const r = addSource(s, mockMedia(`take-${i}.mp4`, 3));
    if (r.ok) s = r.state;
  }
  print("200 clips (3s each)", s);
}

console.log();

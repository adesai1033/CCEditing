---
name: CutCLI state model architecture
description: Core architecture decisions for the CutCLI non-destructive video editing project state model (Slices 3A-3B)
type: project
---

CutCLI uses a pure-function mutation pattern for state management: ProjectState is immutable, mutations return MutationResult discriminated unions ({ok: true, state} | {ok: false, error}), and persistence is JSON-to-disk.

**Why:** CLI tool where simplicity and correctness matter more than performance. No concurrent writers, no database — single JSON file per project.

**How to apply:** When reviewing future slices, verify mutations remain pure, state is never mutated in place, and MutationResult is consistently used. Watch for: loadProject validation gaps (identified in Slice 3A review), atomic write concerns, and source/clip referential integrity.

Key entities: SourceFile (imported media metadata), Clip (segment of a source on timeline), Timeline (ordered clip sequence), ProjectState (root aggregate).

Display layer (Slice 3B): renderTimeline is a pure function (state in, string out) using Chalk for color, Unicode box-drawing for framing, and proportional width assignment for clip bars.

Known reviewed issues as of Slice 3A:
- loadProject casts parsed JSON to ProjectState without structural validation
- saveProject is not atomic (no write-to-temp-then-rename)
- sourceFileFromMediaInfo intentionally drops some MediaInfo fields (audioChannels, audioBitrate, bitrate, containerFormat)
- addSource couples source import with auto-clip creation

Known reviewed issues as of Slice 3B:
- Clip bar trailing border adds +1 to visual width; bottomBar is 1 char too narrow (off-by-one)
- Time ruler labels can overwrite each other when markers are closely spaced (no overlap guard)
- assignWidths can exceed barWidth when clips.length > barWidth (pathological case, unguarded)

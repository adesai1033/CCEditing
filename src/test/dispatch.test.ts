import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import { createSession } from "../project/session.js";
import { clipsInOrder } from "../project/types.js";
import type { MediaInfo } from "../media/types.js";

// ── Setup: redirect .cutcli.json writes to a temp dir ─────────────────────────

let testDir: string;
const originalCwd = process.cwd();

before(() => {
  testDir = mkdtempSync(join(tmpdir(), "cutcli-dispatch-test-"));
  process.chdir(testDir);
});

after(() => {
  process.chdir(originalCwd);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    filePath: "/fake/video.mp4",
    fileName: "video.mp4",
    duration: 120,
    width: 1920, height: 1080, fps: 30,
    videoCodec: "h264", audioCodec: "aac",
    audioChannels: 2, audioBitrate: 128,
    fileSize: 1_000_000, bitrate: 8000,
    containerFormat: "mp4",
    ...overrides,
  };
}

function makeState(n = 1): ReplState {
  let state = createProject("test");
  for (let i = 0; i < n; i++) {
    const r = addSource(state, makeMediaInfo({ fileName: `clip${i + 1}.mp4`, duration: 120 }));
    assert.ok(r.ok);
    state = r.state;
  }
  return { session: createSession(state), messages: [], autoApprove: false };
}

const noProject: ReplState = { session: null, messages: [], autoApprove: false };

// ── Routing ───────────────────────────────────────────────────────────────────

describe("dispatch routing", () => {
  test("non-slash input without project returns friendly error (agent path)", async () => {
    const r = await dispatch("hello", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });

  test("unknown command returns error", async () => {
    const r = await dispatch("/unknown", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /Unknown command/);
  });

  test("/help returns help text without error", async () => {
    const r = await dispatch("/help", noProject);
    assert.equal(r.isError, false);
    assert.match(r.output, /Available commands/);
  });

  test("/quit sets shouldExit and is not an error", async () => {
    const r = await dispatch("/quit", noProject);
    assert.equal(r.isError, false);
    assert.equal(r.shouldExit, true);
  });

  test("command matching is case-insensitive", async () => {
    const r = await dispatch("/HELP", noProject);
    assert.equal(r.isError, false);
  });
});

// ── /timeline ─────────────────────────────────────────────────────────────────

describe("/timeline", () => {
  test("returns error when no project", async () => {
    const r = await dispatch("/timeline", noProject);
    assert.equal(r.isError, true);
  });

  test("returns error on empty timeline", async () => {
    const r = await dispatch("/timeline", { session: createSession(createProject("test")), messages: [], autoApprove: false });
    assert.equal(r.isError, true);
  });

  test("returns rendered timeline and sets activatesTimeline", async () => {
    const r = await dispatch("/timeline", makeState(2));
    assert.equal(r.isError, false);
    assert.equal(r.activatesTimeline, true);
    assert.ok(r.output.length > 0);
  });
});

// ── /trim ─────────────────────────────────────────────────────────────────────

describe("/trim", () => {
  test("returns error when no project", async () => {
    const r = await dispatch("/trim 1 0 30", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });

  test("returns usage when too few args", async () => {
    const r = await dispatch("/trim 1 0", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /Usage/);
  });

  test("returns error for unknown clip ref", async () => {
    const r = await dispatch("/trim 99 0 30", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /not found/);
  });

  test("returns error for invalid time string", async () => {
    const r = await dispatch("/trim 1 abc 30", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /Error/);
  });

  test("trims clip and returns updated state", async () => {
    const state = makeState();
    const r = await dispatch("/trim 1 0 30", state);
    assert.equal(r.isError, false);
    assert.ok(r.newState?.session);
    const clip = clipsInOrder(r.newState!.session!.state.timeline)[0]!;
    assert.equal(clip.inPoint, 0);
    assert.equal(clip.outPoint, 30);
  });

  test("trim output contains time range", async () => {
    const r = await dispatch("/trim 1 0 30", makeState());
    assert.equal(r.isError, false);
    assert.match(r.output, /0/);
    assert.match(r.output, /30/);
  });

  test("accepts MM:SS time format", async () => {
    const r = await dispatch("/trim 1 0:00 0:30", makeState());
    assert.equal(r.isError, false);
    const clip = clipsInOrder(r.newState!.session!.state.timeline)[0]!;
    assert.equal(clip.outPoint, 30);
  });

  test("accepts clip UUID as ref", async () => {
    const state = makeState();
    const clip = clipsInOrder(state.session!.state.timeline)[0]!;
    const r = await dispatch(`/trim ${clip.id} 0 30`, state);
    assert.equal(r.isError, false);
    assert.equal(clipsInOrder(r.newState!.session!.state.timeline)[0]!.outPoint, 30);
  });
});

// ── /move ─────────────────────────────────────────────────────────────────────

describe("/move", () => {
  test("returns error when no project", async () => {
    const r = await dispatch("/move 1 2", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });

  test("returns usage when too few args", async () => {
    const r = await dispatch("/move 1", makeState(2));
    assert.equal(r.isError, true);
    assert.match(r.output, /Usage/);
  });

  test("returns error for unknown from-clip", async () => {
    const r = await dispatch("/move 99 1", makeState(2));
    assert.equal(r.isError, true);
    assert.match(r.output, /not found/);
  });

  test("returns error for out-of-range to-index", async () => {
    const r = await dispatch("/move 1 99", makeState(2));
    assert.equal(r.isError, true);
    assert.match(r.output, /out of range/);
  });

  test("moves clip and returns updated state", async () => {
    const state = makeState(3);
    const [a, b, c] = clipsInOrder(state.session!.state.timeline);
    const r = await dispatch("/move 1 3", state);
    assert.equal(r.isError, false);
    const ordered = clipsInOrder(r.newState!.session!.state.timeline);
    assert.equal(ordered[0]!.id, b!.id);
    assert.equal(ordered[1]!.id, c!.id);
    assert.equal(ordered[2]!.id, a!.id);
  });

  test("accepts clip UUID as from-ref", async () => {
    const state = makeState(2);
    const [a] = clipsInOrder(state.session!.state.timeline);
    const r = await dispatch(`/move ${a!.id} 2`, state);
    assert.equal(r.isError, false);
    assert.equal(clipsInOrder(r.newState!.session!.state.timeline)[1]!.id, a!.id);
  });
});

// ── /split ────────────────────────────────────────────────────────────────────

describe("/split", () => {
  test("returns error when no project", async () => {
    const r = await dispatch("/split 1 30", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });

  test("returns usage when too few args", async () => {
    const r = await dispatch("/split 1", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /Usage/);
  });

  test("returns error for unknown clip ref", async () => {
    const r = await dispatch("/split 99 30", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /not found/);
  });

  test("returns error for invalid time", async () => {
    const r = await dispatch("/split 1 nope", makeState());
    assert.equal(r.isError, true);
  });

  test("returns error when split point out of range", async () => {
    const r = await dispatch("/split 1 200", makeState()); // clip is 0-120s
    assert.equal(r.isError, true);
    assert.match(r.output, /before clip out-point/);
  });

  test("splits clip and returns two clips in newState", async () => {
    const r = await dispatch("/split 1 60", makeState());
    assert.equal(r.isError, false);
    assert.ok(r.newState?.session);
    const ordered = clipsInOrder(r.newState!.session!.state.timeline);
    assert.equal(ordered.length, 2);
    assert.equal(ordered[0]!.outPoint, 60);
    assert.equal(ordered[1]!.inPoint, 60);
  });

  test("output message mentions the two resulting clip refs", async () => {
    const r = await dispatch("/split 1 60", makeState());
    assert.equal(r.isError, false);
    assert.match(r.output, /1a/);
    assert.match(r.output, /1b/);
  });
});

// ── /delete ───────────────────────────────────────────────────────────────────

describe("/delete", () => {
  test("returns error when no project", async () => {
    const r = await dispatch("/delete 1", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });

  test("returns usage when no args", async () => {
    const r = await dispatch("/delete", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /Usage/);
  });

  test("returns error for unknown clip ref", async () => {
    const r = await dispatch("/delete 99", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /not found/);
  });

  test("deletes clip and returns updated state", async () => {
    const state = makeState(2);
    const [a] = clipsInOrder(state.session!.state.timeline);
    const r = await dispatch("/delete 1", state);
    assert.equal(r.isError, false);
    assert.ok(r.newState?.session);
    const ordered = clipsInOrder(r.newState!.session!.state.timeline);
    assert.equal(ordered.length, 1);
    assert.notEqual(ordered[0]!.id, a!.id);
  });

  test("output message shows remaining count", async () => {
    const r = await dispatch("/delete 1", makeState(3));
    assert.equal(r.isError, false);
    assert.match(r.output, /2 clips remaining/);
  });

  test("accepts clip UUID as ref", async () => {
    const state = makeState(2);
    const [, b] = clipsInOrder(state.session!.state.timeline);
    const r = await dispatch(`/delete ${b!.id}`, state);
    assert.equal(r.isError, false);
    assert.equal(clipsInOrder(r.newState!.session!.state.timeline).length, 1);
  });

  test("deleting last clip leaves empty timeline", async () => {
    const r = await dispatch("/delete 1", makeState(1));
    assert.equal(r.isError, false);
    assert.equal(clipsInOrder(r.newState!.session!.state.timeline).length, 0);
    assert.match(r.output, /0 clips remaining/);
  });
});

// ── /auto ─────────────────────────────────────────────────────────────────────

describe("/auto", () => {
  test("/auto reports current state without args", async () => {
    const r = await dispatch("/auto", makeState());
    assert.equal(r.isError, false);
    assert.match(r.output, /off/);
  });

  test("/auto on flips autoApprove to true", async () => {
    const r = await dispatch("/auto on", makeState());
    assert.equal(r.isError, false);
    assert.equal(r.newState!.autoApprove, true);
  });

  test("/auto off flips autoApprove to false", async () => {
    const state = { ...makeState(), autoApprove: true };
    const r = await dispatch("/auto off", state);
    assert.equal(r.isError, false);
    assert.equal(r.newState!.autoApprove, false);
  });

  test("/auto with unknown arg returns usage error", async () => {
    const r = await dispatch("/auto maybe", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /Usage/);
  });
});

// ── /clear ────────────────────────────────────────────────────────────────────

describe("/clear", () => {
  test("/clear resets messages but preserves session and undo", async () => {
    const state: ReplState = {
      ...makeState(),
      messages: [
        { role: "user", content: "earlier prompt" },
      ],
    };
    const sessionRef = state.session;
    const r = await dispatch("/clear", state);
    assert.equal(r.isError, false);
    assert.deepEqual(r.newState!.messages, []);
    assert.equal(r.newState!.session, sessionRef);
  });
});

// ── Slash-command continuity (synthetic-message injection) ────────────────────

describe("slash-command continuity", () => {
  test("/trim injects a synthetic note into agent messages", async () => {
    const state = makeState();
    const r = await dispatch("/trim 1 0 30", state);
    assert.equal(r.isError, false);
    assert.equal(r.newState!.messages.length, 1);
    const m = r.newState!.messages[0]!;
    assert.equal(m.role, "user");
    assert.match(m.content as string, /via slash command/);
    assert.match(m.content as string, /Trimmed/);
  });

  test("/timeline (read-only) does NOT inject a synthetic note", async () => {
    const r = await dispatch("/timeline", makeState(1));
    assert.equal(r.isError, false);
    // Either no newState or unchanged messages
    if (r.newState) assert.deepEqual(r.newState.messages, []);
  });

  test("a failed /trim does NOT inject a synthetic note", async () => {
    const r = await dispatch("/trim 99 0 30", makeState());
    assert.equal(r.isError, true);
    if (r.newState) assert.deepEqual(r.newState.messages, []);
  });
});

// ── Non-slash routing → agent ─────────────────────────────────────────────────

describe("agent routing", () => {
  test("non-slash input is routed to the agent with correct args", async () => {
    let captured: { userPrompt: string; autoApprove: boolean } | null = null;
    const mockAgent = async (input: import("../agent/loop.js").AgentInput) => {
      captured = { userPrompt: input.userPrompt, autoApprove: input.autoApprove };
      return {
        messages: [...input.messages, { role: "user" as const, content: input.userPrompt }],
        session: input.session,
        output: "(mocked)",
        isError: false,
      };
    };
    const state: ReplState = { ...makeState(), autoApprove: true };
    const r = await dispatch("trim the boring intro", state, {
      confirm: async () => ({ approved: true }),
      agent: mockAgent,
    });
    assert.equal(r.isError, false);
    assert.equal(captured!.userPrompt, "trim the boring intro");
    assert.equal(captured!.autoApprove, true);
  });

  test("non-slash with no project returns friendly error", async () => {
    const r = await dispatch("hello", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });
});

// ── /export (error paths only — success requires ffmpeg) ──────────────────────

describe("/export error paths", () => {
  test("returns error when no project", async () => {
    const r = await dispatch("/export out.mp4", noProject);
    assert.equal(r.isError, true);
    assert.match(r.output, /No project open/);
  });

  test("returns usage when no output path", async () => {
    const r = await dispatch("/export", makeState());
    assert.equal(r.isError, true);
    assert.match(r.output, /Usage/);
  });

  test("returns error when timeline is empty", async () => {
    const r = await dispatch("/export out.mp4", { session: createSession(createProject("test")), messages: [], autoApprove: false });
    assert.equal(r.isError, true);
    assert.match(r.output, /empty/);
  });
});

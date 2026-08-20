import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderAgentProse, stripMarkdown, presentOutput } from "../ui/markdown.js";
import { stripAnsi } from "../ui/theme.js";
import { dispatch, type ReplState } from "../repl/commands/dispatch.js";
import { staticSystemPrefix } from "../agent/prompt.js";
import { createProject } from "../project/io.js";
import { addSource } from "../project/mutations.js";
import { createSession } from "../project/session.js";
import type { MediaInfo } from "../media/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// The EXACT output from the 3I.5 defect report: raw markdown reaching the
// terminal. Every boundary test renders this and asserts the syntax is gone.
const DEFECT_REPORT_OUTPUT = [
  "Hello! I'm CutCLI's editing agent. I'm here to help you edit your video timeline using natural language commands.",
  "",
  "You currently have **4 clips** on your timeline (about 48 seconds total):",
  "",
  "| Ref | File | Duration |",
  "|-----|------|----------|",
  "| 1 | test_trimmed.mp4 | 9.0s |",
  "| 2 | test_trimmed.mp4 | 9.0s |",
  "| 3 | test.mp4 | 15.0s |",
  "| 4 | test.mp4 | 15.0s |",
  "",
  "Here are some things you can ask me to do:",
  "- **Trim** clips (\"trim clip 1 to start at 2 seconds\")",
  "- **Split** clips (\"split clip 3 at the 5 second mark\")",
  "",
  "What would you like to do?",
].join("\n");

/** No raw markdown syntax may survive to what the terminal shows. */
function assertNoRawMarkdown(rendered: string, label: string): void {
  const plain = stripAnsi(rendered);
  assert.doesNotMatch(plain, /\*\*/, `${label}: raw ** survived`);
  assert.doesNotMatch(plain, /`/, `${label}: raw backtick survived`);
  assert.doesNotMatch(plain, /^\s*\|/m, `${label}: raw table pipe survived`);
  assert.doesNotMatch(plain, /^- /m, `${label}: raw markdown bullet survived`);
  assert.doesNotMatch(plain, /^#{1,6} /m, `${label}: raw header survived`);
}

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

function makeState(): ReplState {
  const r = addSource(createProject("test"), makeMediaInfo());
  assert.ok(r.ok);
  return { session: createSession(r.state), messages: [], autoApprove: false };
}

// ── The renderer itself ───────────────────────────────────────────────────────

describe("renderAgentProse — markdown to terminal", () => {
  test("plain text is a no-op", () => {
    assert.equal(renderAgentProse("4 clips, 48s total."), "4 clips, 48s total.");
    assert.equal(renderAgentProse("Agent error: rate limited"), "Agent error: rate limited");
  });

  test("bold and inline code are styled, delimiters removed", () => {
    const out = renderAgentProse("You have **4 clips** in `test.mp4`.");
    assert.equal(stripAnsi(out), "You have 4 clips in test.mp4.");
    assertNoRawMarkdown(out, "inline");
  });

  test("filenames with underscores are never mangled", () => {
    const out = renderAgentProse("Clips from test_trimmed.mp4 and my__file__name.mp4 stay intact.");
    assert.ok(stripAnsi(out).includes("test_trimmed.mp4"));
    assert.ok(stripAnsi(out).includes("my__file__name.mp4"));
  });

  test("bullets become themed glyph lines; headers lose their hashes", () => {
    const out = renderAgentProse("# Summary\n- **Trim** clips\n- Split clips");
    const plain = stripAnsi(out);
    assert.ok(plain.includes("Summary"));
    assert.ok(plain.includes("· Trim clips"));
    assertNoRawMarkdown(out, "bullets/headers");
  });

  test("a markdown table renders as aligned columns with no pipes", () => {
    const out = renderAgentProse("| Ref | File |\n|-----|------|\n| 1 | test.mp4 |\n| 2 | b.mp4 |");
    const plain = stripAnsi(out);
    assertNoRawMarkdown(out, "table");
    const lines = plain.split("\n");
    assert.ok(lines.length >= 3, "header + rule + rows");
    // Columns align: 'test.mp4' and 'b.mp4' start at the same offset.
    const rowA = lines.find((l) => l.includes("test.mp4"))!;
    const rowB = lines.find((l) => l.includes("b.mp4"))!;
    assert.equal(rowA.indexOf("test.mp4"), rowB.indexOf("b.mp4"), "columns must align");
    assert.ok(plain.includes("─"), "themed rule under the header");
  });

  test("code fences render dim content with the fence lines dropped", () => {
    const out = renderAgentProse("```\n/trim 1 0:05 0:30\n```");
    const plain = stripAnsi(out);
    assert.ok(plain.includes("/trim 1 0:05 0:30"));
    assertNoRawMarkdown(out, "fence");
  });

  test("links, strikethrough, and blockquotes strip to clean text", () => {
    const out = renderAgentProse("> a quote\nSee [docs](https://x.dev) and ~~old~~ new.");
    const plain = stripAnsi(out);
    assert.ok(plain.includes("a quote"));
    assert.ok(plain.includes("docs"));
    assert.ok(plain.includes("new"));
    assert.doesNotMatch(plain, /~~|\]\(/);
  });

  test("the full defect-report output renders with zero markdown artifacts", () => {
    const out = renderAgentProse(DEFECT_REPORT_OUTPUT);
    assertNoRawMarkdown(out, "defect report");
    // Content survives even though the syntax is gone.
    const plain = stripAnsi(out);
    assert.ok(plain.includes("4 clips"));
    assert.ok(plain.includes("test_trimmed.mp4"));
  });

  test("stripMarkdown yields plain text for single-style contexts (thinking line)", () => {
    const plain = stripMarkdown("Check **clip 2** boundaries in `test.mp4` first");
    assert.equal(plain, "Check clip 2 boundaries in test.mp4 first");
    assert.doesNotMatch(plain, /\x1B/, "stripMarkdown must not emit ANSI");
  });
});

// ── Terminal-output boundary, per render path ─────────────────────────────────
//
// The 3I.5 failure mode: a renderer that exists but isn't reached. These tests
// assert at the seam the REPL actually uses for each path that carries agent
// prose: (1) the committed turn output from dispatch, (2) the streamed text
// buffer, (3) the streamed thinking buffer, (4) agent error text.

describe("agent prose boundary — committed dispatch output", () => {
  const agentReturning = (output: string, isError = false) =>
    async (input: { messages: unknown[]; session: unknown }) => ({
      messages: input.messages as never,
      session: input.session as never,
      output,
      isError,
    });

  test("dispatch marks agent output as markdown and presentOutput renders it clean", async () => {
    const r = await dispatch("hello", makeState(), {
      confirm: async () => ({ approved: true }),
      agent: agentReturning(DEFECT_REPORT_OUTPUT) as never,
    });
    assert.equal(r.markdown, true, "agent-path output must be flagged as markdown");
    const rendered = presentOutput(r.output, r.markdown === true);
    assertNoRawMarkdown(rendered, "committed dispatch output");
  });

  test("agent ERROR output flows through the same rendered path", async () => {
    const r = await dispatch("do a thing", makeState(), {
      confirm: async () => ({ approved: true }),
      agent: agentReturning("Something **failed**: `rate limited`", true) as never,
    });
    assert.equal(r.markdown, true);
    assertNoRawMarkdown(presentOutput(r.output, r.markdown === true), "agent error output");
  });

  test("slash-command output is NOT markdown-rendered (box art and ANSI stay intact)", async () => {
    const r = await dispatch("/help", makeState());
    assert.notEqual(r.markdown, true, "slash output must not be flagged");
    assert.equal(presentOutput(r.output, r.markdown === true), r.output, "passthrough untouched");
  });
});

describe("agent prose boundary — streamed paths (wiring guard)", () => {
  // The App renders three live/committed agent-text expressions. This guard
  // fails if any of them stops going through the renderer — the exact gap that
  // let 3I.5 ship green while the terminal showed raw asterisks.
  const appSource = readFileSync(
    join(new URL("../../", import.meta.url).pathname, "src", "repl", "App.tsx"),
    "utf-8",
  );

  test("committed entries go through presentOutput", () => {
    assert.match(appSource, /presentOutput\(result\.output/,
      "App must commit dispatch output through presentOutput");
  });

  test("the streamed text buffer goes through renderAgentProse", () => {
    assert.match(appSource, /renderAgentProse\(turn\.text\)/,
      "LiveTurnView must render streamed prose through renderAgentProse");
  });

  test("the streamed thinking buffer is markdown-stripped", () => {
    assert.match(appSource, /stripMarkdown\(turn\.thinking\)/,
      "LiveTurnView must strip markdown from thinking text");
  });

  test("streamed buffers render clean even mid-accumulation", () => {
    // A buffer that has closed its constructs so far renders clean each frame.
    const streamed = "Trimmed **clip 2** to `0:04`.\n- boundary verified";
    assertNoRawMarkdown(renderAgentProse(streamed), "streamed buffer");
  });
});

// ── Voice (3I.5 §3/§4): the prompt leads with examples and bans the table ─────

describe("agent voice in the system prompt", () => {
  const prompt = staticSystemPrefix();

  test("a reply-style section exists with few-shot examples", () => {
    assert.match(prompt, /## Reply style/);
    assert.match(prompt, /User: hello/i, "few-shot example for the greeting case");
    assert.match(prompt, /answer-first|declarative/i);
  });

  test("markdown, tables, and timeline re-rendering are banned", () => {
    assert.match(prompt, /no markdown|plain text only/i);
    assert.match(prompt, /never .*(timeline).*(table|list)/i);
    assert.match(prompt, /\/timeline/);
  });

  test("the style section sits at the end of the static prompt", () => {
    const styleIdx = prompt.indexOf("## Reply style");
    const lastOther = Math.max(
      prompt.indexOf("## Verification"),
      prompt.indexOf("## When to propose vs ask"),
      prompt.indexOf("## Narrative planning"),
    );
    assert.ok(styleIdx > lastOther, "reply-style section must come last");
  });
});

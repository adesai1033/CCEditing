import path from "node:path";
import os from "node:os";
import { mkdir, unlink } from "node:fs/promises";
import type { NeutralMessage } from "../../agent/providers/types.js";
import type { ViewportState } from "../../display/timeline.js";
import { buildHelpText } from "./registry.js";
import { probeFile } from "../../media/probe.js";
import { renderMediaInfo, formatFileSize } from "../../display/media-info.js";
import { renderTimeline } from "../../display/timeline.js";
import { renderClipList } from "../../display/timeline-clip-list.js";
import { clipsInOrder, resolveClip, getClipDisplayRefs } from "../../project/types.js";
import {
  applyPlan,
  undoSession,
  redoSession,
  type ProjectSession,
} from "../../project/session.js";
import { setClipUserLabel, clearClipUserLabel } from "../../project/mutations.js";
import { getDefaultIndexRegistry } from "../../agent/indexing.js";
import { paint, glyphs } from "../../ui/theme.js";
import { loadOrCreateProject, saveProjectToStandardPath } from "../../cli/project-context.js";
import { parseTime } from "../../utils/time.js";
import { execute } from "../../engine/engine.js";
import { runAgent, type AgentInput, type ProgressEvent } from "../../agent/loop.js";
import type { PlanForConfirmation } from "../../agent/propose_edit_plan.js";
import { parsePreviewArgs, previewStateScope, type PreviewDeps } from "./preview.js";
import { getSessionTotals, renderCostReport } from "../cost.js";
import { saveSession, loadSession } from "../session-store.js";
import { compactHistory, shouldAutoCompact, type CompactResult } from "../compaction.js";
import { buildDefaultProvider, DEFAULT_PROVIDER_INFO } from "../../agent/providers/default.js";

export interface ReplState {
  session: ProjectSession | null;
  messages: NeutralMessage[];
  autoApprove: boolean;
  /** 3G: critic review of compound plans. Optional so existing state literals
   *  stay valid; undefined means ON (the default). */
  criticEnabled?: boolean;
}

export interface DispatchResult {
  output: string;
  isError: boolean;
  newState?: ReplState;
  shouldExit?: boolean;
  activatesTimeline?: boolean;
  /** True when `output` is agent prose (possibly markdown) and must be
   *  rendered through the markdown renderer before reaching the terminal.
   *  Slash-command output is pre-styled and must NOT be re-rendered. */
  markdown?: boolean;
  /** 3K: /clear also empties any queued type-ahead input. */
  clearsInputQueue?: boolean;
  /** 3E-8: set when history was compacted this dispatch — the REPL renders a
   *  visible divider so nobody is confused about why the agent forgot something. */
  compacted?: { turns: number; beforeTokens: number; afterTokens: number };
}

export type ConfirmFn = (plan: PlanForConfirmation) => Promise<{ approved: boolean }>;

export interface DispatchOptions {
  viewport?: ViewportState;
  /** Required for non-slash (agent) input. */
  confirm?: ConfirmFn;
  /** Optional progress hook so the REPL can render tool calls inline. */
  onAgentProgress?: (event: ProgressEvent) => void;
  /** Render progress for /preview (0–100), shown as a dim line. */
  onPreviewProgress?: (percent: number) => void;
  /** Abort signal for /preview renders (Ctrl-C cancels, decision 6). */
  previewSignal?: AbortSignal;
  /** Injected for tests — preview render/player seams (defaults are real). */
  previewDeps?: Pick<PreviewDeps, "render" | "open">;
  /** Injected for tests — defaults to compactHistory (3E-8). */
  compact?: typeof compactHistory;
  /** Injected for tests — defaults to runAgent. */
  agent?: (input: AgentInput) => Promise<{
    messages: NeutralMessage[];
    session: ProjectSession;
    output: string;
    isError: boolean;
  }>;
}

export async function dispatch(
  raw: string,
  state: ReplState,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const result = await route(raw, state, options);
  // 3E-8, decision 2: persist conversation on turn completion — any dispatch
  // that changed conversation memory (agent turns, continuity notes, /clear,
  // /compact, /resume) saves the sidecar. Atomic write inside; a failed save
  // is swallowed (conversation is convenience, never a blocker).
  if (result.newState && result.newState.messages !== state.messages) {
    await saveSession(result.newState.messages, DEFAULT_PROVIDER_INFO);
  }
  return result;
}

async function route(
  raw: string,
  state: ReplState,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("/")) {
    return dispatchAgent(trimmed, state, options);
  }

  const [token, ...args] = trimmed.slice(1).split(/\s+/);
  const cmd = token?.toLowerCase();

  switch (cmd) {
    case "help":     return { output: buildHelpText(), isError: false };
    case "quit":     return { output: "Goodbye.", isError: false, shouldExit: true };
    case "open":     return withSlashContinuity(await dispatchOpen(args, state), state);
    case "timeline": return dispatchTimeline(state, options.viewport);
    case "trim":     return withSlashContinuity(await dispatchTrim(args, state), state);
    case "move":     return withSlashContinuity(await dispatchMove(args, state), state);
    case "split":    return withSlashContinuity(await dispatchSplit(args, state), state);
    case "delete":   return withSlashContinuity(await dispatchDelete(args, state), state);
    case "label":    return withSlashContinuity(await dispatchLabel(args, state), state);
    case "unlabel":  return withSlashContinuity(await dispatchUnlabel(args, state), state);
    case "undo":     return withSlashContinuity(await dispatchUndo(state), state);
    case "redo":     return withSlashContinuity(await dispatchRedo(state), state);
    case "export":   return dispatchExport(args, state);
    case "preview":  return dispatchPreview(args, state, options);
    case "auto":     return dispatchAuto(args, state);
    case "critic":   return dispatchCritic(args, state);
    case "cost":     return dispatchCost();
    case "compact":  return dispatchCompact(state, options);
    case "resume":   return dispatchResume(state);
    case "clear":    return dispatchClear(state);
    default:         return { output: `Unknown command: /${cmd}. Type /help for available commands.`, isError: true };
  }
}

/**
 * If a slash command changed project state, append a terse synthetic user
 * message to the agent's conversation memory so follow-up agent prompts
 * have intent continuity ("make that trim shorter" after `/trim 1 0:05 0:30`).
 * Centralized here so every state-mutating command gets it for free.
 *
 * Read-only commands (those without newState.session change OR with an
 * isError) are passed through untouched.
 */
function withSlashContinuity(result: DispatchResult, prevState: ReplState): DispatchResult {
  if (result.isError || !result.newState || result.newState.session === prevState.session) {
    return result;
  }
  const note = synthesizeSlashNote(result.output);
  if (!note) return result;
  return {
    ...result,
    newState: {
      ...result.newState,
      messages: [
        ...result.newState.messages,
        { role: "user", content: [{ type: "text", text: `(via slash command: ${note})` }] },
      ],
    },
  };
}

/**
 * Derive a one-line factual summary of what the slash command did from its
 * own output (first non-empty line, dimmed/colored stripped). The output
 * already says "Trimmed ... 0:05 → 0:30" etc., so we reuse it rather than
 * threading a structured event from each command.
 */
function synthesizeSlashNote(output: string): string {
  const firstLine = output.split("\n").find((l) => l.trim().length > 0) ?? "";
  // Remove ANSI escape codes and trim
  const clean = firstLine.replace(/\x1B\[[0-9;]*m/g, "").trim();
  return clean;
}

// ── /open ─────────────────────────────────────────────────────────────────────

async function dispatchOpen(args: string[], state: ReplState): Promise<DispatchResult> {
  const filePath = args[0];
  if (!filePath) return { output: "Usage: /open <file>", isError: true };

  const absPath = path.resolve(filePath);
  const probe = await probeFile(absPath);
  if (!probe.ok) return { output: `Error: ${probe.error}`, isError: true };

  let session: ProjectSession;
  if (state.session) {
    session = state.session;
  } else {
    const ctx = await loadOrCreateProject();
    if (!ctx.ok) return { output: `Error: ${ctx.error}`, isError: true };
    session = ctx.session;
  }

  const result = applyPlan(
    session,
    `add source ${probe.data.fileName}`,
    [{ type: "addSource", mediaInfo: probe.data }],
  );
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  // Kick off TwelveLabs indexing in the background (3E-6): fire-and-forget,
  // never blocking — /open returns as fast as it did before, and by the time
  // the user asks for visual perception the index is often ready. The registry
  // dedupes and captures failures; a failure surfaces only when a tool needs
  // the index. Skipped without a key (the lazy tool-time error still applies)
  // or when the source is already indexed from a prior session.
  const newSource = result.session.state.sources[result.session.state.sources.length - 1]!;
  let indexNote = "";
  if (process.env["TWELVELABS_API_KEY"] && newSource.analyses.twelveLabs?.status !== "indexed") {
    getDefaultIndexRegistry().start({ id: newSource.id, filePath: newSource.filePath });
    indexNote = "\n" + paint.muted(`${glyphs.sync} visual indexing started in background`);
  }

  const clipCount = clipsInOrder(result.session.state.timeline).length;
  return {
    output: renderMediaInfo(probe.data) + `\n\nAdded to project  ·  ${clipCount} clip${clipCount === 1 ? "" : "s"}` + indexNote,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /timeline ─────────────────────────────────────────────────────────────────

function dispatchTimeline(state: ReplState, viewport?: ViewportState): DispatchResult {
  if (!state.session || state.session.state.timeline.headId === null) {
    return { output: "No clips on timeline. Use /open to add a file.", isError: true };
  }
  const rendered = renderTimeline(state.session.state, process.stdout.columns, viewport)
    + "\n" + renderClipList(state.session.state);
  return { output: rendered, isError: false, activatesTimeline: true };
}

// ── /trim ─────────────────────────────────────────────────────────────────────

async function dispatchTrim(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (args.length < 3) return { output: "Usage: /trim <index> <start> <end>", isError: true };

  const clip = resolveClip(state.session.state.timeline, args[0]!);
  if (!clip) {
    const count = clipsInOrder(state.session.state.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }

  let inPoint: number, outPoint: number;
  try {
    inPoint  = parseTime(args[1]!);
    outPoint = parseTime(args[2]!);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  const ref = getClipDisplayRefs(state.session.state.timeline).get(clip.id) ?? args[0]!;
  const result = applyPlan(
    state.session,
    `trim clip [${ref}]`,
    [{ type: "trim", clipId: clip.id, inPoint, outPoint }],
  );
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  const trimmed = result.session.state.timeline.clips[clip.id]!;
  return {
    output: `Trimmed ${trimmed.label}  ${args[1]} → ${args[2]}  (${formatSeconds(trimmed.outPoint - trimmed.inPoint)})`,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /move ─────────────────────────────────────────────────────────────────────

async function dispatchMove(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (args.length < 2) return { output: "Usage: /move <from> <to>", isError: true };

  const clip = resolveClip(state.session.state.timeline, args[0]!);
  if (!clip) {
    const count = clipsInOrder(state.session.state.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }

  const toIdx = parseInt(args[1]!, 10) - 1;
  const count = clipsInOrder(state.session.state.timeline).length;
  if (isNaN(toIdx) || toIdx < 0 || toIdx >= count) {
    return { output: `To-index ${args[1]} out of range (1–${count})`, isError: true };
  }

  const ref = getClipDisplayRefs(state.session.state.timeline).get(clip.id) ?? args[0]!;
  const result = applyPlan(
    state.session,
    `move clip [${ref}] → position ${args[1]}`,
    [{ type: "move", clipId: clip.id, newIndex: toIdx }],
  );
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  return {
    output: `Moved ${clip.label} → position [${args[1]}]`,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /split ────────────────────────────────────────────────────────────────────

async function dispatchSplit(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (args.length < 2) return { output: "Usage: /split <clip> <time>", isError: true };

  const clip = resolveClip(state.session.state.timeline, args[0]!);
  if (!clip) {
    const count = clipsInOrder(state.session.state.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }

  let splitPoint: number;
  try {
    splitPoint = parseTime(args[1]!);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  const ref = getClipDisplayRefs(state.session.state.timeline).get(clip.id) ?? args[0]!;
  const result = applyPlan(
    state.session,
    `split clip [${ref}] at ${args[1]}`,
    [{ type: "split", clipId: clip.id, splitPoint }],
  );
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  const displayRefs = getClipDisplayRefs(result.session.state.timeline);
  const ordered = clipsInOrder(result.session.state.timeline);
  const newSecondClip = ordered[ordered.findIndex((c) => c.id === clip.id) + 1]!;
  const refA = displayRefs.get(clip.id) ?? "?";
  const refB = displayRefs.get(newSecondClip.id) ?? "?";
  return {
    output: `Split ${clip.label} at ${args[1]} → clips [${refA}] and [${refB}]`,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /delete ───────────────────────────────────────────────────────────────────

async function dispatchDelete(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (!args[0]) return { output: "Usage: /delete <clip>", isError: true };

  const clip = resolveClip(state.session.state.timeline, args[0]);
  if (!clip) {
    const count = clipsInOrder(state.session.state.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }

  const ref = getClipDisplayRefs(state.session.state.timeline).get(clip.id) ?? args[0];
  const result = applyPlan(
    state.session,
    `delete clip [${ref}]`,
    [{ type: "delete", clipId: clip.id }],
  );
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  const remaining = clipsInOrder(result.session.state.timeline).length;
  return {
    output: `Deleted ${clip.label}  ·  ${remaining} clip${remaining === 1 ? "" : "s"} remaining`,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /label & /unlabel ─────────────────────────────────────────────────────────
//
// User annotations, NOT edit operations: they don't go through applyPlan and
// don't create undo entries. `/label <ref>` with no text shows the current
// label; with text sets/replaces it; `/unlabel <ref>` clears it.

async function dispatchLabel(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (!args[0]) return { output: "Usage: /label <clip> [text]   (omit text to show the current label)", isError: true };

  const clip = resolveClip(state.session.state.timeline, args[0]);
  if (!clip) {
    const count = clipsInOrder(state.session.state.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }
  const ref = getClipDisplayRefs(state.session.state.timeline).get(clip.id) ?? args[0];

  // Show mode: no text provided.
  if (args.length < 2) {
    return {
      output: clip.userLabel ? `[${ref}] label: ${clip.userLabel}` : `[${ref}] has no label.`,
      isError: false,
    };
  }

  const text = args.slice(1).join(" ");
  const result = setClipUserLabel(state.session.state, clip.id, text);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const session: ProjectSession = { ...state.session, state: result.state };
  const saved = await saveProjectToStandardPath(session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  return {
    output: `Labeled [${ref}]: ${text.trim()}`,
    isError: false,
    newState: { ...state, session },
  };
}

async function dispatchUnlabel(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (!args[0]) return { output: "Usage: /unlabel <clip>", isError: true };

  const clip = resolveClip(state.session.state.timeline, args[0]);
  if (!clip) {
    const count = clipsInOrder(state.session.state.timeline).length;
    return { output: `Clip "${args[0]}" not found (1–${count})`, isError: true };
  }
  const ref = getClipDisplayRefs(state.session.state.timeline).get(clip.id) ?? args[0];

  if (!clip.userLabel) return { output: `[${ref}] had no label.`, isError: false };

  const result = clearClipUserLabel(state.session.state, clip.id);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const session: ProjectSession = { ...state.session, state: result.state };
  const saved = await saveProjectToStandardPath(session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  return {
    output: `Cleared label on [${ref}]`,
    isError: false,
    newState: { ...state, session },
  };
}

// ── /undo ─────────────────────────────────────────────────────────────────────

async function dispatchUndo(state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };

  const result = undoSession(state.session);
  if (!result.ok) return { output: "Nothing to undo.", isError: false };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  return {
    output: `Undid: ${result.label}`,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /redo ─────────────────────────────────────────────────────────────────────

async function dispatchRedo(state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };

  const result = redoSession(state.session);
  if (!result.ok) return { output: "Nothing to redo.", isError: false };

  const saved = await saveProjectToStandardPath(result.session);
  if (!saved.ok) return { output: `Error saving project: ${saved.error}`, isError: true };

  return {
    output: `Redid: ${result.label}`,
    isError: false,
    newState: { ...state, session: result.session },
  };
}

// ── /export ───────────────────────────────────────────────────────────────────

async function dispatchExport(args: string[], state: ReplState): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };
  if (!args[0]) return { output: "Usage: /export <output-file>", isError: true };

  const clips = clipsInOrder(state.session.state.timeline);
  if (clips.length === 0) return { output: "Timeline is empty. Use /open to add clips.", isError: true };

  const outputPath = path.resolve(args[0]);
  const sourceMap = new Map(state.session.state.sources.map((s) => [s.id, s]));

  // Single clip — direct trim
  if (clips.length === 1) {
    const clip = clips[0]!;
    const source = sourceMap.get(clip.sourceId);
    if (!source) return { output: "Source file missing for clip [1].", isError: true };

    const result = await execute({ type: "trim", input: source.filePath, start: clip.inPoint, end: clip.outPoint, output: outputPath });
    if (!result.ok) return { output: `Export failed: ${result.error}`, isError: true };

    return {
      output: `Exported: ${outputPath}\nSize: ${formatFileSize(result.outputSize)}\nDuration: ${formatDuration(clip.outPoint - clip.inPoint)}`,
      isError: false,
    };
  }

  // Multi-clip — trim each to temp, then concat
  const tmpDir = path.join(os.tmpdir(), `cutcli-export-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const segPaths: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const source = sourceMap.get(clip.sourceId);
    if (!source) {
      await cleanupSegments(segPaths);
      return { output: `Source file missing for clip [${i + 1}].`, isError: true };
    }
    const seg = path.join(tmpDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    const r = await execute({ type: "trim", input: source.filePath, start: clip.inPoint, end: clip.outPoint, output: seg });
    if (!r.ok) {
      await cleanupSegments(segPaths);
      return { output: `Trim failed for clip [${i + 1}]: ${r.error}`, isError: true };
    }
    segPaths.push(seg);
  }

  const concat = await execute({ type: "concat", segments: segPaths, output: outputPath });
  await cleanupSegments(segPaths);
  if (!concat.ok) return { output: `Concat failed: ${concat.error}`, isError: true };

  const total = clips.reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
  return {
    output: `Exported: ${outputPath}\nSize: ${formatFileSize(concat.outputSize)}\nDuration: ${formatDuration(total)}  (${clips.length} clips)`,
    isError: false,
  };
}

// ── /preview ──────────────────────────────────────────────────────────────────
//
// Read-only (decisions 1 & 9): renders the CURRENT timeline (or a clip / a
// timeline-time range of it) to a temp file and opens the system player.
// Returns no newState, so no synthetic continuity message is ever injected.

async function dispatchPreview(
  args: string[],
  state: ReplState,
  options: DispatchOptions,
): Promise<DispatchResult> {
  if (!state.session) return { output: "No project open. Use /open first.", isError: true };

  const parsed = parsePreviewArgs(args);
  if (!parsed.ok) return { output: parsed.error, isError: true };

  const outcome = await previewStateScope(state.session.state, parsed.scope, {
    onProgress: options.onPreviewProgress,
    signal: options.previewSignal,
    ...options.previewDeps,
  });

  if (!outcome.ok) {
    // A user-cancelled render is a normal outcome, not an error.
    return { output: outcome.error, isError: !outcome.aborted };
  }
  return { output: outcome.message, isError: false };
}

// ── /auto ─────────────────────────────────────────────────────────────────────

function dispatchAuto(args: string[], state: ReplState): DispatchResult {
  const arg = args[0]?.toLowerCase();
  if (!arg) {
    return {
      output: `Approve-all mode is ${state.autoApprove ? "on" : "off"}. Use /auto on or /auto off to toggle.`,
      isError: false,
    };
  }
  if (arg === "on") {
    return {
      output: "Approve-all mode: on. The agent will apply plans without confirmation until /auto off.",
      isError: false,
      newState: { ...state, autoApprove: true },
    };
  }
  if (arg === "off") {
    return {
      output: "Approve-all mode: off. The agent will confirm every plan.",
      isError: false,
      newState: { ...state, autoApprove: false },
    };
  }
  return { output: "Usage: /auto [on|off]", isError: true };
}

// ── /critic ───────────────────────────────────────────────────────────────────
//
// Toggle for the 3G plan-review pass. Default ON. Not a project-state mutation —
// no synthetic continuity message, no undo entry. Exists so the critic's value
// can be A/B'd (/critic off should reproduce pre-slice behavior exactly) and
// skipped when iterating quickly.

function dispatchCritic(args: string[], state: ReplState): DispatchResult {
  const on = state.criticEnabled !== false;
  const arg = args[0]?.toLowerCase();
  if (!arg || arg === "status") {
    return {
      output: `Critic review is ${on ? "on" : "off"}. Use /critic on or /critic off to toggle.`,
      isError: false,
    };
  }
  if (arg === "on") {
    return {
      output: "Critic review: on. Compound plans get a fresh-eyes review before confirmation.",
      isError: false,
      newState: { ...state, criticEnabled: true },
    };
  }
  if (arg === "off") {
    return {
      output: "Critic review: off. Plans go straight to confirmation.",
      isError: false,
      newState: { ...state, criticEnabled: false },
    };
  }
  return { output: "Usage: /critic [on|off|status]", isError: true };
}

// ── /compact (3E-8) ───────────────────────────────────────────────────────────
//
// Manual compaction. The automatic trigger fires before an agent turn when
// the estimate crosses the threshold; this lets the user force it anytime.

async function dispatchCompact(state: ReplState, options: DispatchOptions): Promise<DispatchResult> {
  if (state.messages.length === 0) {
    return { output: "Nothing to compact — conversation is empty.", isError: false };
  }
  const compact = options.compact ?? compactHistory;
  const result = await compact(state.messages, { getProvider: () => buildDefaultProvider() });
  if (result.compactedTurns === 0) {
    return {
      output: `Nothing beyond the recent window to compact — history is ~${fmtTokens(result.beforeTokens)} tokens.`,
      isError: false,
    };
  }
  return {
    output: `Compacted ${result.compactedTurns} turn${result.compactedTurns === 1 ? "" : "s"}: ~${fmtTokens(result.beforeTokens)} → ~${fmtTokens(result.afterTokens)} tokens (${result.tiersApplied.join(" + ")}). Recent turns kept verbatim.`,
    isError: false,
    newState: { ...state, messages: result.messages },
    compacted: { turns: result.compactedTurns, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens },
  };
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── /resume (3E-8) ────────────────────────────────────────────────────────────
//
// Explicitly reopen the persisted conversation for this project. Resume is
// opt-in: startup only announces that a saved conversation exists.

async function dispatchResume(state: ReplState): Promise<DispatchResult> {
  const loaded = await loadSession(DEFAULT_PROVIDER_INFO);
  if (!loaded.ok) {
    if (loaded.reason === "missing") {
      return { output: "No saved conversation for this project.", isError: false };
    }
    return {
      output: `Saved conversation couldn't be read (${loaded.error ?? "corrupt file"}) — starting fresh. Project state is unaffected.`,
      isError: true,
    };
  }
  if (loaded.messages.length === 0) {
    return { output: "The saved conversation is empty.", isError: false };
  }
  const notes = [
    `Resumed conversation: ${loaded.messages.length} messages (saved ${loaded.savedAt}).`,
    "Old perception results were elided — the agent works from the current timeline snapshot.",
  ];
  if (loaded.strippedReasoning) {
    notes.push("Reasoning blocks were stripped: the saved session came from a different provider/model.");
  }
  return {
    output: notes.join("\n"),
    isError: false,
    newState: { ...state, messages: loaded.messages },
  };
}

// ── /clear ────────────────────────────────────────────────────────────────────

function dispatchClear(state: ReplState): DispatchResult {
  return {
    output: "Agent conversation cleared. Project state and undo history are unchanged.",
    isError: false,
    newState: { ...state, messages: [] },
    clearsInputQueue: true,
  };
}

// ── /cost ─────────────────────────────────────────────────────────────────────
//
// Session-scoped token readout by role (3K). Usage flows in through the
// default provider's tap as turns complete; this just renders the fold.

function dispatchCost(): DispatchResult {
  return { output: renderCostReport(getSessionTotals()), isError: false };
}

// ── Agent (non-slash input) ───────────────────────────────────────────────────

async function dispatchAgent(
  prompt: string,
  state: ReplState,
  options: DispatchOptions,
): Promise<DispatchResult> {
  if (!state.session) {
    return { output: "No project open. Use /open <file> first.", isError: true };
  }
  if (!options.confirm) {
    return { output: "Internal error: confirm callback not provided.", isError: true };
  }

  // 3E-8, decision 11: auto-compact BEFORE the turn when the estimate crosses
  // the threshold — never silently; the caller renders a visible divider.
  let messages = state.messages;
  let compactedInfo: DispatchResult["compacted"];
  if (shouldAutoCompact(messages)) {
    const compact = options.compact ?? compactHistory;
    const c: CompactResult = await compact(messages, { getProvider: () => buildDefaultProvider() });
    messages = c.messages;
    compactedInfo = { turns: c.compactedTurns, beforeTokens: c.beforeTokens, afterTokens: c.afterTokens };
  }

  const run = options.agent ?? runAgent;
  const result = await run({
    userPrompt: prompt,
    session: state.session,
    messages,
    autoApprove: state.autoApprove,
    criticEnabled: state.criticEnabled !== false,
    confirm: options.confirm,
    onProgress: options.onAgentProgress,
  });

  // Persist if anything in the session changed — applyPlan results AND
  // any analysis cache populated by perception tools during the loop.
  if (result.session !== state.session) {
    const saved = await saveProjectToStandardPath(result.session);
    if (!saved.ok) {
      return {
        output: `${result.output}\n\nWarning: failed to save project — ${saved.error}`,
        isError: true,
        markdown: true,
        compacted: compactedInfo,
        newState: { ...state, session: result.session, messages: result.messages },
      };
    }
  }

  return {
    output: result.output,
    isError: result.isError,
    // Agent prose — success or error — always renders through the markdown
    // seam (3I.5 fix): there is no path by which it reaches the terminal raw.
    markdown: true,
    compacted: compactedInfo,
    newState: {
      ...state,
      session: result.session,
      messages: result.messages,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanupSegments(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join("");
}

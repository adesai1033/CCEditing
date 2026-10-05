import type { ProjectState, TransitionType, PlacedClip } from "../../project/types.js";
import {
  TRANSITION_TYPES,
  DEFAULT_TRANSITION_TYPE,
  DEFAULT_TRANSITION_DURATION,
  resolveClip,
  getClipDisplayRefs,
  layoutTimeline,
} from "../../project/types.js";
import { applyPlan, type ProjectSession, type Operation } from "../../project/session.js";
import { parseTime } from "../../utils/time.js";
import { paint, glyphs } from "../../ui/theme.js";

/**
 * `/transition` and `/fade` — the edge effects between and around clips.
 *
 *   /transition <clip> [duration] [type]   crossfade from <clip> into the next
 *   /transition <clip> none                back to a hard cut
 *   /transition all [duration] [type]      every cut on the timeline (or `all none`)
 *   /transition list                       show what's set
 *   /fade <clip> in|out [duration]         fade from/to black + silence (0 or none clears)
 *   /fade in|out [duration]                shorthand for the first / last clip
 *
 * A crossfade overlaps the two clips by its duration, so the timeline gets
 * shorter by that much. Shared by the REPL and the CLI: returns text and a
 * new session; the caller persists. Every change goes through applyPlan.
 */

export const TRANSITION_USAGE = [
  "Usage:",
  "  /transition <clip> [duration] [type]     crossfade from <clip> into the next clip (default 1s fade)",
  "  /transition <clip> none                  back to a hard cut",
  "  /transition all [duration] [type]        apply to every cut (or `all none`)",
  "  /transition list",
  `Types: ${TRANSITION_TYPES.join(", ")}  (crossfade/dissolve = fade)`,
].join("\n");

export const FADE_USAGE = [
  "Usage:",
  "  /fade <clip> in|out [duration]     fade from black (in) or to black (out); default 1s, 0 or none clears",
  "  /fade in|out [duration]            the first clip's in / the last clip's out",
].join("\n");

export interface EdgeCommandResult {
  output: string;
  isError: boolean;
  session?: ProjectSession;
}

const TYPE_ALIASES: Record<string, TransitionType> = {
  crossfade: "fade", dissolve: "fade", xfade: "fade",
  black: "fadeblack", white: "fadewhite",
};

export function parseTransitionType(raw: string): TransitionType {
  const s = raw.trim().toLowerCase();
  const aliased = TYPE_ALIASES[s] ?? s;
  if (!(TRANSITION_TYPES as readonly string[]).includes(aliased)) {
    throw new Error(`Unknown transition type "${raw}" — use one of ${TRANSITION_TYPES.join(", ")}`);
  }
  return aliased as TransitionType;
}

function isDurationToken(s: string): boolean {
  return /^\d+(\.\d+)?(s)?$/.test(s) || /^\d+:\d{2}(\.\d+)?$/.test(s);
}

function parseDuration(raw: string): number {
  return parseTime(raw.replace(/s$/, ""));
}

const fmtSecs = (n: number): string => `${Number(n.toFixed(2))}s`;

function clipNotFound(state: ProjectState, ref: string): EdgeCommandResult {
  const count = layoutTimeline(state.timeline).clips.length;
  return { output: `Clip "${ref}" not found (1–${count})`, isError: true };
}

// ── /transition ───────────────────────────────────────────────────────────────

export function runTransitionCommand(args: string[], session: ProjectSession): EdgeCommandResult {
  if (args.length === 0) return { output: TRANSITION_USAGE, isError: true };
  const first = args[0]!.toLowerCase();
  try {
    if (first === "help") return { output: TRANSITION_USAGE, isError: false };
    if (first === "list" || first === "ls") return { output: renderTransitionList(session.state), isError: false };
    if (first === "all") return transitionAll(args.slice(1), session);
    return transitionOne(args, session);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }
}

/** `[duration] [type]` in either order; both optional. */
function parseTransitionSpec(tokens: string[]): { duration: number; type: TransitionType } {
  let duration = DEFAULT_TRANSITION_DURATION;
  let type = DEFAULT_TRANSITION_TYPE;
  for (const t of tokens) {
    if (isDurationToken(t)) duration = parseDuration(t);
    else type = parseTransitionType(t);
  }
  return { duration, type };
}

function transitionOne(args: string[], session: ProjectSession): EdgeCommandResult {
  const state = session.state;
  const clip = resolveClip(state.timeline, args[0]!);
  if (!clip) return clipNotFound(state, args[0]!);
  const ref = getClipDisplayRefs(state.timeline).get(clip.id) ?? args[0]!;
  const rest = args.slice(1);

  if (rest[0]?.toLowerCase() === "none" || rest[0]?.toLowerCase() === "off" || rest[0]?.toLowerCase() === "cut") {
    if (!clip.transitionOut) return { output: `Clip [${ref}] already cuts to the next clip.`, isError: false };
    const r = applyPlan(session, `remove transition after [${ref}]`, [{ type: "removeTransition", clipId: clip.id }]);
    if (!r.ok) return { output: `Error: ${r.error}`, isError: true };
    return { output: `Removed transition after [${ref}] ${clip.label}  ${glyphs.arrow}  hard cut`, isError: false, session: r.session };
  }

  const spec = parseTransitionSpec(rest);
  const r = applyPlan(session, `transition after [${ref}]`, [
    { type: "setTransition", clipId: clip.id, duration: spec.duration, transitionType: spec.type },
  ]);
  if (!r.ok) return { output: `Error: ${r.error}`, isError: true };
  const next = clip.nextId ? state.timeline.clips[clip.nextId] : undefined;
  const nextRef = next ? getClipDisplayRefs(state.timeline).get(next.id) ?? "?" : "?";
  return {
    output: `Transition [${ref}] ${glyphs.arrow} [${nextRef}]: ${spec.type} ${fmtSecs(spec.duration)}` +
      paint.muted(`  ${glyphs.bullet}  timeline now ${clock(layoutTimeline(r.session.state.timeline).duration)}`),
    isError: false,
    session: r.session,
  };
}

function transitionAll(rest: string[], session: ProjectSession): EdgeCommandResult {
  const state = session.state;
  const placed = layoutTimeline(state.timeline).clips;
  if (placed.length < 2) return { output: "Need at least two clips for a transition.", isError: true };
  const cuts = placed.slice(0, -1);

  if (rest[0]?.toLowerCase() === "none" || rest[0]?.toLowerCase() === "off") {
    const ops: Operation[] = cuts.filter((p) => p.clip.transitionOut).map((p) => ({ type: "removeTransition", clipId: p.clip.id }));
    if (ops.length === 0) return { output: "No transitions to remove.", isError: false };
    const r = applyPlan(session, "remove all transitions", ops);
    if (!r.ok) return { output: `Error: ${r.error}`, isError: true };
    return { output: `Removed ${ops.length} transition${ops.length === 1 ? "" : "s"}  ${glyphs.arrow}  hard cuts`, isError: false, session: r.session };
  }

  const spec = parseTransitionSpec(rest);
  let clamped = 0;
  const ops: Operation[] = cuts.map((p, i) => {
    const room = Math.min(p.duration, placed[i + 1]!.duration);
    const duration = Math.min(spec.duration, room);
    if (duration < spec.duration) clamped += 1;
    return { type: "setTransition", clipId: p.clip.id, duration, transitionType: spec.type };
  });
  const r = applyPlan(session, `transition all cuts`, ops);
  if (!r.ok) return { output: `Error: ${r.error}`, isError: true };
  const note = clamped > 0 ? paint.muted(`  ${glyphs.bullet}  ${clamped} shortened to fit short clips`) : "";
  return {
    output: `Transition on ${ops.length} cut${ops.length === 1 ? "" : "s"}: ${spec.type} ${fmtSecs(spec.duration)}${note}` +
      paint.muted(`  ${glyphs.bullet}  timeline now ${clock(layoutTimeline(r.session.state.timeline).duration)}`),
    isError: false,
    session: r.session,
  };
}

export function renderTransitionList(state: ProjectState): string {
  const layout = layoutTimeline(state.timeline);
  const refs = getClipDisplayRefs(state.timeline);
  const lines: string[] = [];
  layout.clips.forEach((p, i) => {
    const ref = refs.get(p.clip.id) ?? "?";
    if (p.fadeIn > 0) lines.push(`  ${paint.accent(`[${ref}]`)} fade in ${fmtSecs(p.fadeIn)}`);
    if (p.transitionOut) {
      const nextRef = refs.get(layout.clips[i + 1]!.clip.id) ?? "?";
      lines.push(`  ${paint.accent(`[${ref}]`)} ${glyphs.arrow} ${paint.accent(`[${nextRef}]`)} ${p.transitionOut.type} ${fmtSecs(p.transitionOut.duration)}`);
    }
    if (p.fadeOut > 0) lines.push(`  ${paint.accent(`[${ref}]`)} fade out ${fmtSecs(p.fadeOut)}`);
  });
  if (lines.length === 0) return "No transitions or fades. Every cut is a hard cut.";
  return lines.join("\n") + "\n" + paint.muted(`  timeline ${clock(layout.duration)}`);
}

// ── /fade ─────────────────────────────────────────────────────────────────────

export function runFadeCommand(args: string[], session: ProjectSession): EdgeCommandResult {
  if (args.length === 0) return { output: FADE_USAGE, isError: true };
  if (args[0]!.toLowerCase() === "help") return { output: FADE_USAGE, isError: false };
  const state = session.state;
  const layout = layoutTimeline(state.timeline);
  if (layout.clips.length === 0) return { output: "No clips on timeline. Use /open to add a file.", isError: true };

  try {
    // Shorthand: `/fade in [d]` → head; `/fade out [d]` → tail.
    let placed: PlacedClip | undefined;
    let rest: string[];
    const a0 = args[0]!.toLowerCase();
    if (a0 === "in" || a0 === "out") {
      placed = a0 === "in" ? layout.clips[0] : layout.clips[layout.clips.length - 1];
      rest = args;
    } else {
      const clip = resolveClip(state.timeline, args[0]!);
      if (!clip) return clipNotFound(state, args[0]!);
      placed = layout.clips.find((p) => p.clip.id === clip.id);
      rest = args.slice(1);
    }
    const edgeRaw = rest[0]?.toLowerCase();
    if (edgeRaw !== "in" && edgeRaw !== "out") return { output: FADE_USAGE, isError: true };
    const edge = edgeRaw;
    const durRaw = rest[1];
    const duration = durRaw === undefined ? DEFAULT_TRANSITION_DURATION
      : (durRaw.toLowerCase() === "none" || durRaw.toLowerCase() === "off") ? 0
      : parseDuration(durRaw);

    const clip = placed!.clip;
    const ref = getClipDisplayRefs(state.timeline).get(clip.id) ?? "?";
    const r = applyPlan(session, duration > 0 ? `fade ${edge} on [${ref}]` : `remove fade ${edge} on [${ref}]`, [
      { type: "setFade", clipId: clip.id, edge, duration },
    ]);
    if (!r.ok) return { output: `Error: ${r.error}`, isError: true };
    return {
      output: duration > 0
        ? `Fade ${edge} on [${ref}] ${clip.label}: ${fmtSecs(duration)}`
        : `Removed fade ${edge} on [${ref}] ${clip.label}`,
      isError: false,
      session: r.session,
    };
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const secStr = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${m}:${secStr}`;
}

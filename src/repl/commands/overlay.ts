import path from "node:path";
import type { ProjectState, OverlayAnchor, OverlayFit, Overlay } from "../../project/types.js";
import {
  OVERLAY_ANCHORS,
  OVERLAY_FITS,
  overlaysOf,
  resolveClip,
  resolveOverlay,
  getOverlayDisplayRefs,
} from "../../project/types.js";
import { applyPlan, type ProjectSession, type Operation } from "../../project/session.js";
import { OVERLAY_DEFAULTS } from "../../project/mutations.js";
import { probeFile, type ProbeResult } from "../../media/probe.js";
import { parseTime } from "../../utils/time.js";
import { formatOverlayPosition, formatOverlaySize, formatOverlaySpan, pct } from "../../display/overlay-format.js";
import { paint, glyphs } from "../../ui/theme.js";

/**
 * `/overlay` — the picture-in-picture track. One command, verb-first:
 *
 *   /overlay <file|clip> [--at t] [--pos p] [--size s] [--from t --to t]   add
 *   /overlay list                                                         show
 *   /overlay move <o#> <pos>                                              reposition
 *   /overlay size <o#> <size>                                             rescale
 *   /overlay time <o#> <at> [from to]                                     retime
 *   /overlay delete <o#>                                                  remove
 *
 * Positions: an anchor name (top-right, center, bottom-left, …; pinned 3% in
 * from the edges, or `--margin`) or explicit `x,y` fractions/percents of the
 * frame for the overlay's top-left corner (`--anchor` picks another corner).
 * Sizes are the overlay's width as a fraction/percent of the frame width.
 *
 * Shared by the REPL and the CLI: it returns text and a new session; the
 * caller persists. Every change goes through applyPlan (one undo entry).
 */

export const OVERLAY_USAGE = [
  "Usage:",
  "  /overlay <file|clip> [--at <time>] [--pos <anchor|x,y>] [--size <pct>] [--from <t> --to <t>] [--fit cover|contain]",
  "  /overlay list",
  "  /overlay move <o#> <anchor|x,y> [--margin <pct>] [--anchor <anchor>]",
  "  /overlay size <o#> <pct>",
  "  /overlay time <o#> <at> [<from> <to>]",
  "  /overlay delete <o#>",
  `Anchors: ${OVERLAY_ANCHORS.join(", ")}`,
  "--fit makes a full-frame cutaway (cover crops to fill, contain letterboxes); the main track's sound keeps playing.",
].join("\n");

const DEFAULT_MARGIN = 0.03;

export interface OverlayCommandResult {
  output: string;
  isError: boolean;
  session?: ProjectSession;
}

export interface OverlayCommandDeps {
  /** Injected for tests. Defaults to ffprobe. */
  probe?: (absPath: string) => Promise<ProbeResult>;
}

// ── Value parsing ─────────────────────────────────────────────────────────────

/** "25%" | "0.25" | "25" → 0.25. Bare numbers above 1 are read as percents. */
export function parseFraction(raw: string, what = "value"): number {
  const s = raw.trim();
  const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(s);
  if (!m) throw new Error(`Invalid ${what} "${raw}" — use a percent like 25% or a fraction like 0.25`);
  const n = parseFloat(m[1]!);
  if (m[2] === "%" || n > 1) return n / 100;
  return n;
}

export interface ParsedPosition { anchor: OverlayAnchor; x: number; y: number }

/**
 * An anchor name → that corner/edge/center pinned `margin` in from the frame
 * edges; "x,y" → the (default top-left) anchor pinned at those fractions.
 */
export function parsePosition(raw: string, opts: { margin?: number; anchor?: OverlayAnchor } = {}): ParsedPosition {
  const s = raw.trim().toLowerCase();
  const margin = opts.margin ?? DEFAULT_MARGIN;
  if ((OVERLAY_ANCHORS as readonly string[]).includes(s)) {
    const anchor = s as OverlayAnchor;
    const x = anchor.endsWith("left") ? margin : anchor.endsWith("right") ? 1 - margin : 0.5;
    const y = anchor.startsWith("top") ? margin : anchor.startsWith("bottom") ? 1 - margin : 0.5;
    return { anchor, x, y };
  }
  const pair = s.split(",");
  if (pair.length === 2) {
    return {
      anchor: opts.anchor ?? "top-left",
      x: parseFraction(pair[0]!, "x position"),
      y: parseFraction(pair[1]!, "y position"),
    };
  }
  throw new Error(`Invalid position "${raw}" — use an anchor (${OVERLAY_ANCHORS.join(", ")}) or x,y like 10%,80%`);
}

function parseAnchor(raw: string): OverlayAnchor {
  const s = raw.trim().toLowerCase();
  if (!(OVERLAY_ANCHORS as readonly string[]).includes(s)) {
    throw new Error(`Unknown anchor "${raw}" — use one of ${OVERLAY_ANCHORS.join(", ")}`);
  }
  return s as OverlayAnchor;
}

/** Split `--flag value` pairs out of an arg list; the rest stay positional. */
function splitFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`Option ${a} needs a value`);
        flags.set(a.slice(2), v);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const KNOWN_FLAGS = new Set(["at", "pos", "size", "from", "to", "margin", "anchor", "fit"]);

function parseFit(raw: string): OverlayFit {
  const s = raw.trim().toLowerCase();
  if (!(OVERLAY_FITS as readonly string[]).includes(s)) throw new Error(`Unknown fit "${raw}" — use ${OVERLAY_FITS.join(" or ")}`);
  return s as OverlayFit;
}

// ── Command ───────────────────────────────────────────────────────────────────

const VERBS = new Set(["list", "ls", "move", "size", "scale", "time", "delete", "remove", "rm", "help"]);

export async function runOverlayCommand(
  rawArgs: string[],
  session: ProjectSession,
  deps: OverlayCommandDeps = {},
): Promise<OverlayCommandResult> {
  if (rawArgs.length === 0) return { output: OVERLAY_USAGE, isError: true };
  const verb = rawArgs[0]!.toLowerCase();

  try {
    if (VERBS.has(verb)) {
      const rest = rawArgs.slice(1);
      switch (verb) {
        case "help":   return { output: OVERLAY_USAGE, isError: false };
        case "list": case "ls":
          return { output: renderOverlayList(session.state), isError: false };
        case "move":   return moveOverlay(rest, session);
        case "size": case "scale":
          return sizeOverlay(rest, session);
        case "time":   return timeOverlay(rest, session);
        case "delete": case "remove": case "rm":
          return deleteOverlay(rest, session);
      }
    }
    return await addOverlayCommand(rawArgs, session, deps);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }
}

// ── add ───────────────────────────────────────────────────────────────────────

async function addOverlayCommand(
  rawArgs: string[],
  session: ProjectSession,
  deps: OverlayCommandDeps,
): Promise<OverlayCommandResult> {
  const { positional, flags } = splitFlags(rawArgs);
  for (const k of flags.keys()) {
    if (!KNOWN_FLAGS.has(k)) return { output: `Unknown option --${k}.\n${OVERLAY_USAGE}`, isError: true };
  }
  const target = positional[0];
  if (!target || positional.length > 1) return { output: OVERLAY_USAGE, isError: true };

  const margin = flags.has("margin") ? parseFraction(flags.get("margin")!, "margin") : undefined;
  const anchorFlag = flags.has("anchor") ? parseAnchor(flags.get("anchor")!) : undefined;
  const pos = flags.has("pos")
    ? parsePosition(flags.get("pos")!, { margin, anchor: anchorFlag })
    : anchorFlag !== undefined
      ? parsePosition(anchorFlag, { margin })
      : parsePosition(OVERLAY_DEFAULTS.anchor, { margin });
  const scale = flags.has("size") ? parseFraction(flags.get("size")!, "size") : undefined;
  const at = flags.has("at") ? parseTime(flags.get("at")!) : undefined;
  const from = flags.has("from") ? parseTime(flags.get("from")!) : undefined;
  const to = flags.has("to") ? parseTime(flags.get("to")!) : undefined;

  const fit = flags.has("fit") ? parseFit(flags.get("fit")!) : undefined;
  const placement = { at, anchor: pos.anchor, x: pos.x, y: pos.y, scale, ...(fit ? { fit } : {}) };

  // A clip ref overlays that clip's source, defaulting to the clip's own
  // in/out range; anything else is a file path.
  const clip = resolveClip(session.state.timeline, target);
  let op: Operation;
  let label: string;
  if (clip) {
    op = {
      type: "addOverlay",
      sourceId: clip.sourceId,
      ...placement,
      inPoint: from ?? clip.inPoint,
      outPoint: to ?? clip.outPoint,
    };
    label = `clip ${target}`;
  } else {
    const absPath = path.resolve(target);
    const probe = await (deps.probe ?? probeFile)(absPath);
    if (!probe.ok) {
      return {
        output: probe.code === "NOT_FOUND"
          ? `"${target}" is neither a clip on the timeline nor a file that exists.`
          : `Error: ${probe.error}`,
        isError: true,
      };
    }
    op = { type: "addOverlayFromFile", mediaInfo: probe.data, ...placement, inPoint: from, outPoint: to };
    label = probe.data.fileName;
  }

  const result = applyPlan(session, `add overlay ${label}`, [op]);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };

  const overlays = overlaysOf(result.session.state.timeline);
  const added = overlays[overlays.length - 1]!;
  const ref = getOverlayDisplayRefs(result.session.state.timeline).get(added.id) ?? "?";
  return {
    output: `Added overlay [${ref}] ${added.label}  ${describe(added)}\n` +
      paint.muted(`${glyphs.bullet} overlay audio is not mixed in; /preview to check placement`),
    isError: false,
    session: result.session,
  };
}

// ── move / size / time / delete ───────────────────────────────────────────────

function requireOverlay(state: ProjectState, ref: string | undefined, usage: string):
  | { ok: true; overlay: Overlay; ref: string }
  | { ok: false; result: OverlayCommandResult } {
  if (!ref) return { ok: false, result: { output: usage, isError: true } };
  const overlay = resolveOverlay(state.timeline, ref);
  if (!overlay) {
    const n = overlaysOf(state.timeline).length;
    return {
      ok: false,
      result: {
        output: n === 0 ? "No overlays yet. Add one with /overlay <file|clip>." : `Overlay "${ref}" not found (o1–o${n})`,
        isError: true,
      },
    };
  }
  return { ok: true, overlay, ref: getOverlayDisplayRefs(state.timeline).get(overlay.id) ?? ref };
}

function moveOverlay(args: string[], session: ProjectSession): OverlayCommandResult {
  const { positional, flags } = splitFlags(args);
  const found = requireOverlay(session.state, positional[0], "Usage: /overlay move <o#> <anchor|x,y> [--margin <pct>] [--anchor <anchor>]");
  if (!found.ok) return found.result;
  if (!positional[1]) return { output: "Usage: /overlay move <o#> <anchor|x,y> [--margin <pct>] [--anchor <anchor>]", isError: true };

  const margin = flags.has("margin") ? parseFraction(flags.get("margin")!, "margin") : undefined;
  const anchor = flags.has("anchor") ? parseAnchor(flags.get("anchor")!) : undefined;
  const pos = parsePosition(positional[1], { margin, anchor });

  const result = applyPlan(session, `move overlay [${found.ref}]`, [
    { type: "updateOverlay", overlayId: found.overlay.id, anchor: pos.anchor, x: pos.x, y: pos.y },
  ]);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };
  const updated = resolveOverlay(result.session.state.timeline, found.overlay.id)!;
  return {
    output: `Moved overlay [${found.ref}] ${updated.label} ${glyphs.arrow} ${formatOverlayPosition(updated)}`,
    isError: false,
    session: result.session,
  };
}

function sizeOverlay(args: string[], session: ProjectSession): OverlayCommandResult {
  const found = requireOverlay(session.state, args[0], "Usage: /overlay size <o#> <pct>");
  if (!found.ok) return found.result;
  if (!args[1]) return { output: "Usage: /overlay size <o#> <pct>", isError: true };
  const scale = parseFraction(args[1], "size");

  const result = applyPlan(session, `resize overlay [${found.ref}]`, [
    { type: "updateOverlay", overlayId: found.overlay.id, scale },
  ]);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };
  return {
    output: `Resized overlay [${found.ref}] ${found.overlay.label} ${glyphs.arrow} ${pct(scale)} of frame width`,
    isError: false,
    session: result.session,
  };
}

function timeOverlay(args: string[], session: ProjectSession): OverlayCommandResult {
  const usage = "Usage: /overlay time <o#> <at> [<from> <to>]";
  const found = requireOverlay(session.state, args[0], usage);
  if (!found.ok) return found.result;
  if (!args[1] || (args.length !== 2 && args.length !== 4)) return { output: usage, isError: true };

  const at = parseTime(args[1]);
  const range = args.length === 4 ? { inPoint: parseTime(args[2]!), outPoint: parseTime(args[3]!) } : {};
  const result = applyPlan(session, `retime overlay [${found.ref}]`, [
    { type: "updateOverlay", overlayId: found.overlay.id, at, ...range },
  ]);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };
  const updated = resolveOverlay(result.session.state.timeline, found.overlay.id)!;
  return {
    output: `Retimed overlay [${found.ref}] ${updated.label} ${glyphs.arrow} ${formatOverlaySpan(updated)}`,
    isError: false,
    session: result.session,
  };
}

function deleteOverlay(args: string[], session: ProjectSession): OverlayCommandResult {
  const found = requireOverlay(session.state, args[0], "Usage: /overlay delete <o#>");
  if (!found.ok) return found.result;
  const result = applyPlan(session, `delete overlay [${found.ref}]`, [
    { type: "removeOverlay", overlayId: found.overlay.id },
  ]);
  if (!result.ok) return { output: `Error: ${result.error}`, isError: true };
  const remaining = overlaysOf(result.session.state.timeline).length;
  return {
    output: `Deleted overlay ${found.overlay.label}  ${glyphs.bullet}  ${remaining} overlay${remaining === 1 ? "" : "s"} remaining`,
    isError: false,
    session: result.session,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function describe(o: Overlay): string {
  return paint.muted(`${formatOverlaySpan(o)}  ${glyphs.bullet}  ${formatOverlayPosition(o)}  ${glyphs.bullet}  ${formatOverlaySize(o)}`);
}

export function renderOverlayList(state: ProjectState): string {
  const overlays = overlaysOf(state.timeline);
  if (overlays.length === 0) return "No overlays. Add one with /overlay <file|clip> [--at <time>] [--pos <anchor>] [--size <pct>].";
  const refs = getOverlayDisplayRefs(state.timeline);
  const nameWidth = Math.min(32, Math.max(12, ...overlays.map((o) => o.label.length)));
  return overlays.map((o) => {
    const ref = paint.accent(`[${refs.get(o.id) ?? "?"}]`.padEnd(5));
    const name = paint.emphasis(o.label.slice(0, nameWidth).padEnd(nameWidth));
    return `  ${ref} ${name} ${describe(o)}`;
  }).join("\n");
}

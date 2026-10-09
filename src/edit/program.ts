import type { ProjectState, OverlayAnchor, TranscriptSegment } from "../project/types.js";
import { clipsInOrder, overlaysOf, syncOffset, layoutTimeline } from "../project/types.js";
import type { Operation } from "../project/session.js";

/**
 * A PROGRAM is how a story edit is described: the editor's decisions, not
 * timeline arithmetic.
 *
 *   spine  — the source whose sound carries the story (a call, narration);
 *   keep   — which stretches of the spine play, in order;
 *   shots  — what the viewer SEES over stretches of spine time.
 *
 * A multicam edit: a SYNCED angle (measured by media/sync.ts) shown over
 * spine time t displays its own frame at t + offset — so the picture always
 * matches the moment that is being heard, and when the spine skips a pause
 * the angle skips the same pause. The model never computes an in/out point or
 * a timeline index for a synced angle; this module does, from measurements.
 * Unsynced material (B-roll with no shared sound) states where it starts.
 *
 * Anything not covered by a shot shows the spine. The compiler emits ordinary
 * Operations, so undo, preview, export and persistence are unchanged.
 */

export type ShotFraming = "full" | "fill" | "pip";

export interface ProgramShot {
  /** Spine seconds. */
  from: number;
  to: number;
  /** Source to show. */
  angle: string;
  /** Unsynced angles only: the angle's time at `from` (it then plays continuously). */
  sourceIn?: number;
  /** full: whole picture in frame (letterboxed if needed) · fill: fill the frame, cropping · pip: a window. */
  framing?: ShotFraming;
  pip?: { anchor?: OverlayAnchor; scale?: number };
}

export interface Program {
  spine: string;
  keep: Array<{ start: number; end: number }>;
  shots: ProgramShot[];
  fade?: { in?: number; out?: number };
}

export type CompileResult =
  | { ok: true; ops: Operation[] }
  | { ok: false; error: string };

const EPS = 0.05;
const PIP_MARGIN = 0.03;

function pipPosition(anchor: OverlayAnchor): { x: number; y: number } {
  const x = anchor.endsWith("left") ? PIP_MARGIN : anchor.endsWith("right") ? 1 - PIP_MARGIN : 0.5;
  const y = anchor.startsWith("top") ? PIP_MARGIN : anchor.startsWith("bottom") ? 1 - PIP_MARGIN : 0.5;
  return { x, y };
}

/** Program time at which spine time `t` plays, or null if `t` was cut. */
export function programTime(keep: Program["keep"], t: number): number | null {
  let acc = 0;
  for (const r of keep) {
    if (t >= r.start - EPS && t <= r.end + EPS) return acc + Math.max(0, Math.min(r.end, t) - r.start);
    acc += r.end - r.start;
  }
  return null;
}

export function compileProgram(state: ProjectState, program: Program): CompileResult {
  const byId = new Map(state.sources.map((s) => [s.id, s]));
  const spine = byId.get(program.spine);
  if (!spine) return { ok: false, error: `Spine source not found: ${program.spine}` };
  const name = (id: string) => byId.get(id)?.fileName ?? id;

  // ── keep ──────────────────────────────────────────────────────────────────
  if (program.keep.length === 0) return { ok: false, error: "keep is empty — keep at least one stretch of the spine" };
  for (const [i, r] of program.keep.entries()) {
    if (!(r.end > r.start)) return { ok: false, error: `keep[${i}] (${r.start}–${r.end}s) is empty` };
    if (r.start < -EPS || r.end > spine.duration + EPS) {
      return { ok: false, error: `keep[${i}] (${r.start}–${r.end}s) is outside ${spine.fileName} (0–${spine.duration.toFixed(2)}s)` };
    }
    if (i > 0 && r.start < program.keep[i - 1]!.end - EPS) {
      return { ok: false, error: `keep must be in order without overlaps (keep[${i}] starts before keep[${i - 1}] ends)` };
    }
  }
  const keep = program.keep.map((r) => ({ start: Math.max(0, r.start), end: Math.min(spine.duration, r.end) }));

  // ── a fresh main track: the kept spine, in order ─────────────────────────
  const ops: Operation[] = [];
  for (const c of clipsInOrder(state.timeline)) ops.push({ type: "delete", clipId: c.id });
  for (const o of overlaysOf(state.timeline)) ops.push({ type: "removeOverlay", overlayId: o.id });
  keep.forEach((r, i) => ops.push({ type: "insertClip", sourceId: spine.id, inPoint: r.start, outPoint: r.end, index: i, newClipId: `spine-${i + 1}` }));
  if (program.fade?.in) ops.push({ type: "setFade", clipId: "spine-1", edge: "in", duration: program.fade.in });
  if (program.fade?.out) ops.push({ type: "setFade", clipId: `spine-${keep.length}`, edge: "out", duration: program.fade.out });

  // ── shots → overlays ──────────────────────────────────────────────────────
  for (const [i, shot] of program.shots.entries()) {
    const label = `shots[${i}] (${name(shot.angle)} over spine ${shot.from}–${shot.to}s)`;
    if (!(shot.to > shot.from)) return { ok: false, error: `${label}: \`to\` must be after \`from\`` };
    const angle = byId.get(shot.angle);
    if (!angle) return { ok: false, error: `${label}: source not found` };
    if (shot.angle === spine.id) continue;   // the spine is what shows anyway

    const offset = syncOffset(state.sync, spine.id, angle.id);
    if (offset === null && shot.sourceIn === undefined) {
      return {
        ok: false,
        error: `${label}: ${angle.fileName} is not synced with ${spine.fileName}, so give \`sourceIn\` — where in ${angle.fileName} the shot starts (from its beat map or a description).`,
      };
    }

    // The parts of the shot that survive the cuts.
    const pieces = keep
      .map((r) => ({ start: Math.max(r.start, shot.from), end: Math.min(r.end, shot.to) }))
      .filter((p) => p.end - p.start > EPS);
    if (pieces.length === 0) return { ok: false, error: `${label}: none of it is inside the kept spine` };

    const framing = shot.framing ?? "full";
    const firstAt = programTime(keep, pieces[0]!.start)!;
    for (const piece of pieces) {
      const at = programTime(keep, piece.start)!;
      const len = piece.end - piece.start;
      // Synced: the angle's own clock (it skips what the spine skips).
      // Unsynced: plays on from sourceIn as one continuous take.
      const inPoint = offset !== null ? piece.start + offset : shot.sourceIn! + (at - firstAt);
      const outPoint = inPoint + len;
      if (inPoint < -EPS || outPoint > angle.duration + EPS) {
        return {
          ok: false,
          error: `${label}: ${angle.fileName} has no footage for that moment (needs ${inPoint.toFixed(2)}–${outPoint.toFixed(2)}s; the file is 0–${angle.duration.toFixed(2)}s)` +
            (offset !== null ? ` — it is synced at ${offset >= 0 ? "+" : ""}${offset.toFixed(2)}s, so it covers spine ${(-offset).toFixed(2)}–${(angle.duration - offset).toFixed(2)}s` : ""),
        };
      }
      const geometry = framing === "pip"
        ? (() => {
            const anchor = shot.pip?.anchor ?? "right";
            return { anchor, ...pipPosition(anchor), scale: shot.pip?.scale ?? 0.3 };
          })()
        : { fit: framing === "fill" ? ("cover" as const) : ("contain" as const) };
      ops.push({
        type: "addOverlay",
        sourceId: angle.id,
        inPoint: Math.max(0, inPoint),
        outPoint: Math.min(angle.duration, outPoint),
        at,
        ...geometry,
      });
    }
  }
  return { ok: true, ops };
}

// ── Reading a timeline back as shots ──────────────────────────────────────────

export interface ShotListEntry {
  start: number;            // program seconds
  end: number;
  /** What fills the frame. */
  picture: string;
  /** Picture-in-picture windows on top. */
  pips: string[];
  /** What is heard (the main track's source). */
  sound: string;
  /** Spoken lines that start in this shot. */
  lines: string[];
}

/**
 * The timeline as a viewer experiences it: a list of shots, each with the
 * picture, any windows on top, the sound, and the lines spoken. Used by the
 * confirm gate and the reviewer — the same view a human editor works from.
 */
export function shotList(state: ProjectState): ShotListEntry[] {
  const layout = layoutTimeline(state.timeline);
  const byId = new Map(state.sources.map((s) => [s.id, s]));
  const name = (id: string) => byId.get(id)?.fileName ?? id;
  const overlays = overlaysOf(state.timeline).map((o) => ({ o, start: o.at, end: o.at + (o.outPoint - o.inPoint) }));
  const marks = new Set<number>([0, layout.duration]);
  for (const p of layout.clips) { marks.add(p.start); marks.add(p.end); }
  for (const x of overlays) { if (x.start < layout.duration) marks.add(x.start); if (x.end < layout.duration) marks.add(x.end); }
  const ts = [...marks].sort((a, b) => a - b);

  // Spoken lines in program time.
  const spoken: Array<{ at: number; text: string }> = [];
  for (const p of layout.clips) {
    const t = byId.get(p.clip.sourceId)?.analyses.transcript;
    for (const l of t?.segments ?? []) {
      if (l.start >= p.clip.inPoint - EPS && l.start < p.clip.outPoint) spoken.push({ at: p.start + (l.start - p.clip.inPoint), text: l.text.trim() });
    }
  }

  const out: ShotListEntry[] = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const a = ts[i]!, b = ts[i + 1]!;
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    const main = layout.clips.find((p) => mid >= p.start && mid < p.end);
    const live = overlays.filter((x) => mid >= x.start && mid < x.end);
    const full = [...live].reverse().find((x) => x.o.fit);
    const picture = full ? name(full.o.sourceId) : main ? name(main.clip.sourceId) : "(nothing)";
    const pips = live.filter((x) => !x.o.fit && (!full || live.indexOf(x) > live.indexOf(full))).map((x) => name(x.o.sourceId));
    const sound = main ? name(main.clip.sourceId) : "(silence)";
    const prev = out[out.length - 1];
    if (prev && prev.picture === picture && prev.sound === sound && prev.pips.join() === pips.join()) {
      prev.end = b;
    } else {
      out.push({ start: a, end: b, picture, pips, sound, lines: [] });
    }
  }
  for (const s of spoken) {
    const shot = out.find((x) => s.at >= x.start - EPS && s.at < x.end);
    shot?.lines.push(s.text);
  }
  return out;
}

export function renderShotList(shots: ShotListEntry[]): string[] {
  const t = (n: number) => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, "0")}`;
  return shots.map((s) => {
    const pip = s.pips.length > 0 ? ` + ${s.pips.join(", ")} window` : "";
    const said = s.lines.length > 0 ? ` — "${s.lines.join(" ")}"` : "";
    return `${t(s.start)}–${t(s.end)} (${(s.end - s.start).toFixed(1)}s) ${s.picture}${pip}${said}`;
  });
}

/** Spine lines with their spine times, for prompts. */
export function spineLines(state: ProjectState, spineId: string): TranscriptSegment[] {
  return state.sources.find((s) => s.id === spineId)?.analyses.transcript?.segments ?? [];
}

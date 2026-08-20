import chalk, { type ChalkInstance } from "chalk";

/**
 * The design system (3I). Every visual decision in `src/repl/` and
 * `src/display/` draws from here: semantic color roles, status glyphs,
 * border treatments, and animation timing. Nothing outside this module names
 * a color or a status glyph — that rule is enforced by the presentation guard
 * in architecture.test.ts, and it's what makes retheming a one-file change.
 *
 * Two consumption surfaces, one palette:
 *  - `ui.*` / `panels.*` — prop bags spread onto Ink components
 *    (<Text {...ui.muted}>). Components never set color/dimColor directly.
 *  - `paint.*` — chalk-based string stylers for the pure-string renderers
 *    (timeline, clip list, media info, slash-command output).
 *
 * Capability degrade (decision 4): chalk reports the terminal's color depth;
 * rich hex values are used on 256/truecolor terminals and named ANSI-16
 * colors otherwise. At level 0 (no color, e.g. piped output/tests) chalk
 * strips styling entirely — which is why the string renderers stay testable
 * as plain text.
 */

// ── Semantic roles (decision 3) ───────────────────────────────────────────────

export type Role =
  | "accent"     // brand / interactive highlights
  | "success"    // completed, applied, confirmed
  | "warning"    // caution, critic concerns, the confirm gate
  | "danger"     // errors, failures, rejections
  | "info"       // secondary informative accents
  | "inFlight";  // work happening right now (never dim — decision 6)

type Palette = Record<Role, string>;

// Sleek-professional palette (3K.1), inspired by Claude Code's terminal look:
// default-foreground prose, gray chrome, ONE warm terracotta accent, and
// muted status colors. No saturated neon anywhere.
const RICH: Palette = {
  accent:   "#d97757",
  success:  "#8fb88f",
  warning:  "#d9a860",
  danger:   "#cc7a7a",
  info:     "#8fa3b8",
  inFlight: "#d97757",
};

const BASIC: Palette = {
  accent:   "yellow",
  success:  "green",
  warning:  "yellow",
  danger:   "red",
  info:     "blue",
  inFlight: "yellow",
};

/** chalk's detected color depth: 0 none, 1 ANSI-16, 2 ANSI-256, 3 truecolor. */
export function colorLevel(): 0 | 1 | 2 | 3 {
  return chalk.level;
}

/** Pure palette selection, exported for tests. Hex needs ≥256 colors. */
export function paletteForLevel(level: number): Palette {
  return level >= 2 ? RICH : BASIC;
}

const palette = paletteForLevel(chalk.level);

// ── Glyph vocabulary ──────────────────────────────────────────────────────────

export const glyphs = {
  done: "✓",
  failed: "✗",
  caution: "⚠",
  thinking: "✻",
  bullet: "·",
  arrow: "→",
  prompt: "›",
  ellipsis: "…",
  label: "♦",
  sync: "⟳",
  revise: "↺",
  queued: "⧗",
  enter: "↵",
  clippedLeft: "◀",
  clippedRight: "▶",
} as const;

// One shared ticker drives every animation (decision 5): few frames, slow
// tick, so streaming re-renders don't tear.
export const spinnerFrames  = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"] as const;
export const thinkingFrames = ["✻", "✢", "✻", "✽", "✻", "✢"] as const;
export const animation = { tickMs: 180 } as const;

export function spinnerFrame(frame: number): string {
  return spinnerFrames[frame % spinnerFrames.length]!;
}
export function thinkingFrame(frame: number): string {
  return thinkingFrames[frame % thinkingFrames.length]!;
}

// ── Ink prop bags ─────────────────────────────────────────────────────────────

export interface TextRoleStyle {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export const ui = {
  accent:          { color: palette.accent },
  success:         { color: palette.success },
  warning:         { color: palette.warning },
  danger:          { color: palette.danger },
  info:            { color: palette.info },
  inFlight:        { color: palette.inFlight },
  muted:           { dimColor: true },
  emphasis:        { bold: true },
  heading:         { color: palette.accent, bold: true },
  prompt:          { color: palette.accent, bold: true },
  key:             { color: palette.accent, bold: true },
  thinking:        { dimColor: true, italic: true },
  successEmphasis: { color: palette.success, bold: true },
  warningEmphasis: { color: palette.warning, bold: true },
  dangerEmphasis:  { color: palette.danger, bold: true },
} satisfies Record<string, TextRoleStyle>;

/** Border prop bags for Ink <Box>. Chrome is gray and quiet; the confirm gate
 *  is the one bordered moment that carries color. */
export const panels = {
  header:  { borderStyle: "round" as const, borderColor: "gray" },
  input:   { borderStyle: "round" as const, borderColor: "gray" },
  gate:    { borderStyle: "round" as const, borderColor: palette.warning },
  waiting: { borderStyle: "round" as const, borderColor: "gray" },
};

// ── String stylers (chalk) for the pure-string renderers ─────────────────────

const NAMED: Record<string, ChalkInstance> = {
  cyan: chalk.cyan,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,
  magenta: chalk.magenta,
};

function styler(color: string, opts: { bold?: boolean } = {}): (s: string) => string {
  let c = color.startsWith("#") ? chalk.hex(color) : (NAMED[color] ?? chalk);
  if (opts.bold) c = c.bold;
  return (s: string) => c(s);
}

export const paint = {
  accent:          styler(palette.accent),
  success:         styler(palette.success),
  warning:         styler(palette.warning),
  danger:          styler(palette.danger),
  info:            styler(palette.info),
  muted:           (s: string) => chalk.dim(s),
  emphasis:        (s: string) => chalk.bold(s),
  italic:          (s: string) => chalk.italic(s),
  heading:         styler(palette.accent, { bold: true }),
  successEmphasis: styler(palette.success, { bold: true }),
};

// The clip-color cycle for the timeline bar: adjacent clips must read as
// distinct, but in muted tones — terracotta, slate, sage, sand.
const CLIP_CYCLE = chalk.level >= 2
  ? ["#d97757", "#7c96b8", "#8fb88f", "#c2a878"]
  : ["yellow", "blue", "green", "cyan"];

const clipStylers = CLIP_CYCLE.map((c) => styler(c));

export function clipPaint(index: number): (s: string) => string {
  return clipStylers[index % clipStylers.length]!;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Strip ANSI escapes — the one implementation for measuring styled strings. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

/**
 * Clear the terminal viewport and scrollback (Ctrl+L, 3K). Purely visual —
 * conversation memory, project state, and committed history are untouched
 * (unlike /clear, which resets agent memory). Lives here because this module
 * is the one sanctioned home for terminal escape sequences.
 */
export function clearTerminal(): void {
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
}

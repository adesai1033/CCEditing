import { paint, glyphs } from "./theme.js";

/**
 * Markdown → terminal for agent prose (3I.5 fix). The model is instructed to
 * write plain text (see the Reply style section of the system prompt), but
 * instructions are probabilistic — this renderer is the guarantee: NO raw
 * markdown syntax ever reaches the terminal, from any agent-text path.
 *
 * Contract:
 *  - Handled constructs render through theme stylers (bold, inline code,
 *    headers, bullets, numbered lists, tables, fences, quotes, links, rules).
 *  - Anything else strips to clean text rather than passing delimiters
 *    through verbatim. Never print raw syntax.
 *  - Plain text is a byte-identical no-op — slash-command output and status
 *    lines pass through `presentOutput` unharmed.
 *  - Intraword underscores are text, not emphasis: test_trimmed.mp4 style
 *    filenames must never be mangled. `_x_` italics are deliberately
 *    unsupported for the same reason.
 *
 * All styling comes from theme.ts; this module emits no literal ANSI.
 */

// ── Public API ────────────────────────────────────────────────────────────────

/** Render agent prose (possibly markdown) for the terminal. */
export function renderAgentProse(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }  // drop fence lines
    if (inFence) { out.push(paint.muted("  " + line)); continue; }

    if (isTableRow(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        if (!isTableSeparator(lines[i]!)) rows.push(parseTableRow(lines[i]!));
        i++;
      }
      i--;
      out.push(...renderTable(rows));
      continue;
    }

    out.push(renderLine(line));
  }
  return out.join("\n");
}

/**
 * Markdown → plain text, no ANSI. For contexts wrapped in a single style by
 * the component (the dim-italic thinking line), where embedded style resets
 * would cancel the outer treatment.
 */
export function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => stripInline(
      line
        .replace(/^\s*```.*$/, "")
        .replace(/^(#{1,6})\s+/, "")
        .replace(/^(\s*)[-*+]\s+/, "$1")
        .replace(/^\s*>\s?/, ""),
    ))
    .join("\n");
}

/** The one presentation seam for committed REPL output: agent prose renders,
 *  everything else (slash output, status lines) passes through untouched. */
export function presentOutput(output: string, isAgentProse: boolean): string {
  return isAgentProse ? renderAgentProse(output) : output;
}

// ── Line-level constructs ─────────────────────────────────────────────────────

function renderLine(line: string): string {
  const header = /^(#{1,6})\s+(.*)$/.exec(line);
  if (header) return paint.heading(stripInline(header[2]!));

  if (/^\s*([-_*])\1{2,}\s*$/.test(line)) return paint.muted("─".repeat(24));

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}  ${paint.muted(glyphs.bullet)} ${renderInline(bullet[2]!)}`;

  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) return `${numbered[1]}  ${paint.muted(`${numbered[2]}.`)} ${renderInline(numbered[3]!)}`;

  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return paint.muted(`  │ ${stripInline(quote[1]!)}`);

  return renderInline(line);
}

// ── Inline constructs ─────────────────────────────────────────────────────────

const INLINE_RULES: Array<{ re: RegExp; render: (c: string, extra?: string) => string; strip: (c: string, extra?: string) => string }> = [
  { re: /`([^`\n]+)`/g,                       render: (c) => paint.accent(c),   strip: (c) => c },
  { re: /\*\*([^*\n]+)\*\*/g,                 render: (c) => paint.emphasis(c), strip: (c) => c },
  // __bold__ only at word boundaries — my__file__name.mp4 is text, not markup.
  { re: /(?<![\w])__([^_\n]+)__(?![\w])/g,    render: (c) => paint.emphasis(c), strip: (c) => c },
  // *italic* flanked by non-word/non-star so products like 2*3*4 stay intact.
  { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/g,  render: (c) => paint.italic(c),   strip: (c) => c },
  { re: /~~([^~\n]+)~~/g,                     render: (c) => c,                 strip: (c) => c },
  {
    re: /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    render: (text, url) => `${text} ${paint.muted(`(${url})`)}`,
    strip: (text, url) => `${text} (${url})`,
  },
];

function renderInline(s: string): string {
  let t = s;
  for (const rule of INLINE_RULES) t = t.replace(rule.re, (_, a, b) => rule.render(a, b));
  return t;
}

function stripInline(s: string): string {
  let t = s;
  for (const rule of INLINE_RULES) t = t.replace(rule.re, (_, a, b) => rule.strip(a, b));
  return t;
}

// ── Tables ────────────────────────────────────────────────────────────────────

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|[\s\-:|]+\|\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => stripInline(c.trim()));
}

/** Aligned columns via theme styling: emphasized header, muted rule, plain rows. */
function renderTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? ""));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...grid.map((r) => r[c]!.length)));

  const [header, ...body] = grid;
  const lines = [
    "  " + header!.map((cell, c) => paint.emphasis(cell.padEnd(widths[c]!))).join("  ").trimEnd(),
    "  " + paint.muted(widths.map((w) => "─".repeat(w)).join("──")),
  ];
  for (const row of body) {
    lines.push("  " + row.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd());
  }
  return lines;
}

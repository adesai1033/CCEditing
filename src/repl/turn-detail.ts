import { stripMarkdown } from "../ui/markdown.js";

/**
 * Retained tool detail for Ctrl+R expansion (3K). The default view suppresses
 * tool arguments and results (3E-4); auditing a turn — did the agent actually
 * verify its ranges before proposing? why did the critic revise? — needs them
 * back on demand.
 *
 * Bounds (stated, per the slice): detail is kept for the LAST
 * `MAX_DETAIL_TURNS` agent turns, oldest evicted; every rendered value is
 * truncated to `MAX_DETAIL_ITEM_CHARS`. A long session never accumulates
 * unbounded scout/transcript payloads — worst case is
 * MAX_DETAIL_TURNS × items × MAX_DETAIL_ITEM_CHARS of text.
 */

export const MAX_DETAIL_TURNS = 5;
export const MAX_DETAIL_ITEM_CHARS = 600;

export type DetailItem =
  | { kind: "tool"; name: string; input: unknown; ok: boolean; result: unknown }
  | {
      kind: "critic";
      verdict: "approve" | "revise";
      concerns: Array<{ severity: "minor" | "major"; operationIndex?: number; issue: string }>;
    };

export interface TurnDetail {
  id: string;
  prompt: string;
  items: DetailItem[];
}

/** Append, evicting the oldest beyond the retention cap. */
export function pushTurnDetail(list: TurnDetail[], detail: TurnDetail): TurnDetail[] {
  const next = [...list, detail];
  return next.length > MAX_DETAIL_TURNS ? next.slice(next.length - MAX_DETAIL_TURNS) : next;
}

/**
 * One value → one bounded display string. Model-written text can carry
 * markdown (scout gists, critic issues), so the result is markdown-STRIPPED —
 * 3I.5's rendering discipline extends to this surface: no raw syntax, and no
 * styled rendering inside what is data, not prose.
 */
export function formatDetailValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 1) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = stripMarkdown(text);
  if (text.length > MAX_DETAIL_ITEM_CHARS) {
    text = text.slice(0, MAX_DETAIL_ITEM_CHARS) + " …(truncated)";
  }
  return text;
}

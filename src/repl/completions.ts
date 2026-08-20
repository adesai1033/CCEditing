import type { ProjectState } from "../project/types.js";
import { clipsInOrder, getClipDisplayRefs } from "../project/types.js";

/**
 * `@` clip-reference autocomplete (3K). Pure input affordance: `@` opens
 * completion over the live timeline's display refs (split-group refs like 2a
 * included), and selecting inserts the PLAIN ref — the agent's prompt
 * vocabulary is unchanged; no `@`-token ever reaches the model.
 */

export interface ClipCompletion {
  ref: string;        // display ref: "1", "2a", …
  name: string;       // clip label (usually the filename)
  fileName: string;   // source filename, when known
  userLabel?: string; // 3E-3 /label annotation, the thing that makes a ref meaningful
}

/** The `@`-token under composition at the end of the input, or null. */
export function completionQuery(value: string): string | null {
  const m = /(?:^|\s)@([a-zA-Z0-9]*)$/.exec(value);
  return m ? m[1]! : null;
}

/** Completions over live refs, filtered by prefix. Empty timeline → []. */
export function clipCompletions(state: ProjectState | null, prefix: string): ClipCompletion[] {
  if (!state) return [];
  const clips = clipsInOrder(state.timeline);
  if (clips.length === 0) return [];
  const refs = getClipDisplayRefs(state.timeline);
  const sourceById = new Map(state.sources.map((s) => [s.id, s]));
  const lower = prefix.toLowerCase();

  return clips
    .map((clip) => ({
      ref: refs.get(clip.id) ?? "?",
      name: clip.label,
      fileName: sourceById.get(clip.sourceId)?.fileName ?? "",
      ...(clip.userLabel !== undefined ? { userLabel: clip.userLabel } : {}),
    }))
    .filter((c) => c.ref.toLowerCase().startsWith(lower));
}

/** Replace the trailing `@token` with the plain ref plus a space. */
export function applyCompletion(value: string, ref: string): string {
  return value.replace(/@[a-zA-Z0-9]*$/, `${ref} `);
}

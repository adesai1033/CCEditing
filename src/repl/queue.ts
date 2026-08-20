/**
 * Queued input during an active turn (3K). Pure model, wired by the App:
 * while a turn streams, keystrokes compose here instead of the (disabled)
 * prompt; what happens at turn end depends on whether the user finished the
 * line with Enter.
 *
 * Semantics (stated, per the slice):
 *  - Enter marks the line READY → it auto-submits when the turn completes.
 *  - A draft without Enter is never auto-fired — it moves back into the
 *    prompt for editing. Auto-submitting a half-typed line is worse than
 *    making the user press Enter once.
 *  - On turn ABORT the queue is ALWAYS preserved as a draft, ready or not —
 *    aborting a turn usually means rethinking the follow-up. (The Esc
 *    interrupt itself is 3J; this model is its landing point.)
 *  - One queued line only; typing after Enter resumes editing that line.
 */

export interface InputQueue {
  text: string;
  ready: boolean;
}

export const EMPTY_QUEUE: InputQueue = { text: "", ready: false };

/** Append printable input; typing after Enter un-readies and keeps editing. */
export function typeIntoQueue(q: InputQueue, input: string): InputQueue {
  return { text: q.text + input, ready: false };
}

export function backspaceQueue(q: InputQueue): InputQueue {
  return { text: q.text.slice(0, -1), ready: false };
}

/** Enter: mark the composed line ready to fire. Empty lines never arm. */
export function markQueueReady(q: InputQueue): InputQueue {
  const text = q.text.trim();
  return text.length === 0 ? EMPTY_QUEUE : { text: q.text, ready: true };
}

export interface QueueDrain {
  queue: InputQueue;
  /** Submit this line now (Enter was pressed while the turn ran). */
  submit: string | null;
  /** Put this text back into the prompt for editing (no Enter yet). */
  draft: string | null;
}

/** Turn completed normally: ready → submit, unfinished → back to the prompt. */
export function drainQueueOnComplete(q: InputQueue): QueueDrain {
  const text = q.text.trim();
  if (text.length === 0) return { queue: EMPTY_QUEUE, submit: null, draft: null };
  if (q.ready) return { queue: EMPTY_QUEUE, submit: q.text, draft: null };
  return { queue: EMPTY_QUEUE, submit: null, draft: q.text };
}

/** Turn aborted: preserve, never fire — even a ready line goes back as a draft. */
export function preserveQueueOnAbort(q: InputQueue): QueueDrain {
  const text = q.text.trim();
  return {
    queue: EMPTY_QUEUE,
    submit: null,
    draft: text.length === 0 ? null : q.text,
  };
}

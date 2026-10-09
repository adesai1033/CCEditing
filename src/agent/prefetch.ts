import { statSync } from "node:fs";

/**
 * Background preparation of the expensive per-source perception (transcript,
 * visual beat map — the beat map also builds the source's 720p master proxy).
 *
 * The mechanism is a process-wide memo of the BACKEND calls, keyed by file
 * identity (path + size + mtime). `/open` starts the calls fire-and-forget;
 * when the agent later asks, the tool calls the same memoized backend and
 * gets the finished — or still in-flight — result instead of starting over.
 * No project state is touched from the background: the tool still writes its
 * own cache entry as before, so nothing about persistence or undo changes.
 *
 * Measured motivation: on the product-video prompt the agent spent its first
 * turns waiting on perception it was always going to request.
 */

interface MemoEntry {
  size: number;
  mtimeMs: number;
  promise: Promise<unknown>;
}

const memo = new Map<string, MemoEntry>();

/**
 * Run `fn` once per (kind, file identity); later callers share the promise.
 * A rejected call is forgotten so the next caller retries.
 */
export function memoized<T>(kind: string, filePath: string, fn: () => Promise<T>): Promise<T> {
  let size = -1;
  let mtimeMs = -1;
  try {
    const st = statSync(filePath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return fn();   // unreadable file: let the real call produce its own error
  }
  const key = `${kind}:${filePath}`;
  const hit = memo.get(key);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.promise as Promise<T>;

  const promise = fn();
  const entry: MemoEntry = { size, mtimeMs, promise };
  memo.set(key, entry);
  promise.catch(() => { if (memo.get(key) === entry) memo.delete(key); });
  return promise;
}

/** Test seam. */
export function clearPrefetchMemo(): void {
  memo.clear();
}

export interface PrefetchJobs {
  transcribe?: () => Promise<unknown>;
  mapVisualBeats?: () => Promise<unknown>;
}

/**
 * Start the jobs that apply, fire-and-forget. Failures are swallowed here —
 * the tool that later needs the result retries and reports its own error.
 * Returns the names of the jobs started (for the /open status line).
 */
export function prefetchSource(jobs: PrefetchJobs): string[] {
  if (process.env["CUTCLI_PREFETCH"] === "0") return [];
  const started: string[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!job) continue;
    started.push(name);
    void job().catch(() => { /* surfaced later by the tool that needs it */ });
  }
  return started;
}

import { indexVideo } from "./backends/twelvelabs.js";

/**
 * Background TwelveLabs indexing (3E-6). Indexing is slow; starting it at
 * `/open` — when the user has already said the file matters — moves the cost
 * off the critical path so the first perception request usually finds the
 * index ready (or at least in flight) instead of paying the whole wait.
 *
 * This registry is the single coordination point:
 *  - one job per source, DEDUPED — concurrent demands (background start, a
 *    perception tool, N parallel scouts) share one in-flight promise; nothing
 *    ever double-indexes.
 *  - a concurrency cap bounds simultaneous index jobs so `/open`-ing many
 *    files queues instead of hammering the API.
 *  - failures are captured, never thrown into the REPL: a failed job marks the
 *    source `failed` and surfaces only when a tool actually needs the index.
 *    A later demand retries (matching the pre-slice lazy behavior where each
 *    tool call re-attempted indexing).
 *
 * The registry is in-process state about work; the durable "is this source
 * indexed" fact stays where it always lived — `analyses.twelveLabs` in the
 * project file, written by the tool that consumes the result. Callers check
 * that cache first and skip the registry entirely on a hit.
 *
 * Read-only by construction: this module is on the scout path and imports no
 * write functions (guarded by the architecture test). Jobs are not cancellable
 * yet (out of scope), but each job is a tracked entry with its own promise, so
 * adding cancellation later is a field on the job, not a restructure.
 */

export type IndexStatus = "pending" | "running" | "ready" | "failed";

export interface IndexResult {
  indexId: string;
  videoId: string;
}

export interface IndexJobInfo {
  status: IndexStatus;
  error?: string;
  result?: IndexResult;
}

export type IndexFn = (filePath: string) => Promise<IndexResult>;

interface Job {
  status: IndexStatus;
  promise: Promise<IndexResult>;
  result?: IndexResult;
  error?: string;
}

export const INDEX_CONCURRENCY_DEFAULT = 2;

export class IndexRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly indexFn: IndexFn;
  private readonly cap: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: { indexFn?: IndexFn; concurrency?: number } = {}) {
    this.indexFn = opts.indexFn ?? indexVideo;
    this.cap = opts.concurrency ?? INDEX_CONCURRENCY_DEFAULT;
  }

  /** Current job state for a source; undefined when never demanded. */
  status(sourceId: string): IndexJobInfo | undefined {
    const job = this.jobs.get(sourceId);
    if (!job) return undefined;
    return {
      status: job.status,
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
    };
  }

  /**
   * Demand the index for a source. Dedupes: a pending/running/ready job is
   * shared (`indexFn` runs at most once per attempt); a failed job is retried
   * on the next demand. Rejects with the backend error — callers surface it as
   * a clean tool error.
   */
  ensure(source: { id: string; filePath: string }, indexFn?: IndexFn): Promise<IndexResult> {
    const existing = this.jobs.get(source.id);
    if (existing && existing.status !== "failed") return existing.promise;

    const fn = indexFn ?? this.indexFn;
    const job: Job = { status: "pending", promise: undefined as unknown as Promise<IndexResult> };
    job.promise = this.run(job, source.filePath, fn);
    this.jobs.set(source.id, job);
    return job.promise;
  }

  /**
   * Fire-and-forget demand for `/open`: starts (or joins) the job and swallows
   * the rejection — the failure is captured in job status and surfaces later,
   * when something actually needs the index. Never blocks, never throws.
   */
  start(source: { id: string; filePath: string }): void {
    this.ensure(source).catch(() => { /* captured in job.status/job.error */ });
  }

  private async run(job: Job, filePath: string, fn: IndexFn): Promise<IndexResult> {
    await this.acquire();
    job.status = "running";
    try {
      const result = await fn(filePath);
      job.status = "ready";
      job.result = result;
      return result;
    } catch (err: unknown) {
      job.status = "failed";
      job.error = (err as Error).message;
      throw err;
    } finally {
      this.release();
    }
  }

  // ── Concurrency cap (simple FIFO semaphore) ─────────────────────────────────

  private acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ── Default instance ────────────────────────────────────────────────────────────
//
// One registry per process so /open, perception tools, and scouts all
// coordinate through the same job table. Swappable for tests only.

let defaultRegistry = new IndexRegistry();

export function getDefaultIndexRegistry(): IndexRegistry {
  return defaultRegistry;
}

/** Test hook — replace the process-wide registry (e.g. with a hanging indexFn). */
export function setDefaultIndexRegistry(registry: IndexRegistry): void {
  defaultRegistry = registry;
}

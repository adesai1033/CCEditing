import { createReadStream } from "node:fs";
import { makeProxy, INDEX_PROXY } from "../../media/proxy.js";
import { normalizeMomentHits, type MomentHit } from "../../project/types.js";
import { TwelveLabs } from "twelvelabs-js";

const INDEX_NAME_DEFAULT = "cutcli";
export const MODEL_NAME = "marengo3.0";

let cachedClient: TwelveLabs | null = null;
let cachedIndexId: string | null = null;

function client(): TwelveLabs {
  if (cachedClient) return cachedClient;
  const apiKey = process.env["TWELVELABS_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "TWELVELABS_API_KEY is not set. Get one at https://playground.twelvelabs.io and export it before running this command.",
    );
  }
  cachedClient = new TwelveLabs({ apiKey });
  return cachedClient;
}

/**
 * Find or create the cutcli index. Idempotent: reuses an existing remote index
 * named `cutcli` across processes; caches the id in-process.
 */
async function ensureIndex(): Promise<string> {
  if (cachedIndexId) return cachedIndexId;

  const c = client();
  const page = await c.indexes.list();
  for await (const idx of page) {
    if (idx.indexName === INDEX_NAME_DEFAULT && idx.id) {
      cachedIndexId = idx.id;
      return cachedIndexId;
    }
  }

  const created = await c.indexes.create({
    indexName: INDEX_NAME_DEFAULT,
    models: [{ modelName: MODEL_NAME, modelOptions: ["visual"] }],
  });
  if (!created.id) {
    throw new Error("TwelveLabs: index creation returned no id");
  }
  cachedIndexId = created.id;
  return cachedIndexId;
}

/**
 * Upload a local video file and wait for indexing to complete. Returns
 * `{ indexId, videoId }` once searchable.
 */
export async function indexVideo(filePath: string): Promise<{ indexId: string; videoId: string }> {
  const indexId = await ensureIndex();
  const c = client();

  // Index a 720p proxy rather than the original: a 1 GB 4K/60fps source
  // becomes ~8 MB with identical timestamps (media/proxy.ts), so search hits
  // are still valid source times.
  const proxy = await makeProxy(filePath, INDEX_PROXY);
  const task = await c.tasks.create({
    indexId,
    videoFile: createReadStream(proxy.path),
  });
  if (!task.id) throw new Error("TwelveLabs: task creation returned no id");

  const done = await c.tasks.waitForDone(task.id, { sleepInterval: 5.0 });
  if (done.status !== "ready") {
    throw new Error(`TwelveLabs indexing failed for ${filePath}: status=${done.status ?? "unknown"}`);
  }
  if (!done.videoId) {
    throw new Error(`TwelveLabs indexing finished but returned no videoId for ${filePath}`);
  }
  return { indexId, videoId: done.videoId };
}

/**
 * Search the cutcli index for a natural-language event description, scoped
 * to one video. TwelveLabs returns hits with an integer `rank` and no score,
 * so that is what we report: 1-based, best first. (This used to be turned into
 * a "confidence" of 1/(1+rank), which made every top hit look like a 50%
 * match — an ordering dressed up as a probability.)
 */
export async function searchMoments(
  indexId: string,
  videoId: string,
  query: string,
): Promise<MomentHit[]> {
  const c = client();
  const page = await c.search.query({
    indexId,
    queryText: query,
    searchOptions: ["visual"],
    filter: JSON.stringify({ id: [videoId] }),
  });

  const raw: Array<{ start: number; end: number; rank?: number }> = [];
  for await (const item of page) {
    if (typeof item.start === "number" && typeof item.end === "number") {
      raw.push({ start: item.start, end: item.end, ...(typeof item.rank === "number" ? { rank: item.rank } : {}) });
    }
  }
  return normalizeMomentHits(raw);
}

// Exposed for test injection — tools accept an optional backend that defaults
// to this, so tests can pass a mock without touching network.
export const realBackend = { indexVideo, searchMoments };
export type TwelveLabsBackend = typeof realBackend;

import { createReadStream } from "node:fs";
import { TwelveLabs } from "twelvelabs-js";

const INDEX_NAME_DEFAULT = "cutcli";
const MODEL_NAME = "marengo2.7";

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

  const task = await c.tasks.create({
    indexId,
    videoFile: createReadStream(filePath),
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
 * to one video. Returns timestamp ranges with confidence scores. The
 * SearchItem `rank` field is integer-ranked across all hits; we expose it
 * as `confidence` for the agent's purposes (lower rank = better match, so
 * we normalize: confidence = 1 / (1 + rank)).
 */
export async function searchMoments(
  indexId: string,
  videoId: string,
  query: string,
): Promise<Array<{ start: number; end: number; confidence: number }>> {
  const c = client();
  const page = await c.search.query({
    indexId,
    queryText: query,
    searchOptions: ["visual"],
    filter: JSON.stringify({ id: [videoId] }),
  });

  const hits: Array<{ start: number; end: number; confidence: number }> = [];
  for await (const item of page) {
    if (typeof item.start === "number" && typeof item.end === "number") {
      const rank = typeof item.rank === "number" ? item.rank : 999;
      hits.push({
        start: item.start,
        end: item.end,
        confidence: 1 / (1 + rank),
      });
    }
  }
  return hits;
}

// Exposed for test injection — tools accept an optional backend that defaults
// to this, so tests can pass a mock without touching network.
export const realBackend = { indexVideo, searchMoments };
export type TwelveLabsBackend = typeof realBackend;

/**
 * Cheap auth check for each provider key. Not part of `npm test` — it makes
 * real (but minimal) API calls. Invoke after `npm run build`:
 *
 *   npm run check-keys
 *
 * Each provider is exercised with the SAME model constant the app uses, so a
 * pass here means the real code paths can reach the API. Model names are
 * imported, never re-declared — a hardcoded copy here would drift and report
 * green while the app 404s (which is exactly how gemini-2.5-flash went stale).
 *
 * No video is uploaded or indexed; see smoke-tools.ts for that.
 */
import "../utils/env.js"; // must stay first — populates process.env from .env
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { TwelveLabs } from "twelvelabs-js";
import OpenAI from "openai";

import { MODEL_DEFAULT } from "../agent/providers/anthropic.js";
import { DESCRIBE_MODEL } from "../agent/backends/gemini.js";
import { MODEL_NAME as TL_MODEL } from "../agent/backends/twelvelabs.js";
import { WHISPER_MODEL } from "../agent/backends/transcription.js";

const pad = (s: string) => s.padEnd(18);
const brief = (e: unknown) => String((e as Error).message).replace(/\s+/g, " ").slice(0, 140);

async function checkAnthropic(): Promise<string> {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) return `${pad("ANTHROPIC_API_KEY")} not set`;
  try {
    const r = await new Anthropic({ apiKey: key }).messages.create({
      model: MODEL_DEFAULT,
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
    });
    return `${pad("ANTHROPIC_API_KEY")} OK   (${r.model})`;
  } catch (e) {
    return `${pad("ANTHROPIC_API_KEY")} FAIL (${MODEL_DEFAULT}) — ${brief(e)}`;
  }
}

async function checkGemini(): Promise<string> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) return `${pad("GEMINI_API_KEY")} not set`;
  try {
    await new GoogleGenAI({ apiKey: key }).models.generateContent({
      model: DESCRIBE_MODEL,
      contents: "hi",
    });
    return `${pad("GEMINI_API_KEY")} OK   (${DESCRIBE_MODEL})`;
  } catch (e) {
    return `${pad("GEMINI_API_KEY")} FAIL (${DESCRIBE_MODEL}) — ${brief(e)}`;
  }
}

async function checkTwelveLabs(): Promise<string> {
  const key = process.env["TWELVELABS_API_KEY"];
  if (!key) return `${pad("TWELVELABS_API_KEY")} not set`;
  try {
    const page = await new TwelveLabs({ apiKey: key }).indexes.list();
    const n = Array.isArray(page?.data) ? page.data.length : 0;
    return `${pad("TWELVELABS_API_KEY")} OK   (auth ok, ${n} index(es); model ${TL_MODEL} unverified until upload)`;
  } catch (e) {
    return `${pad("TWELVELABS_API_KEY")} FAIL — ${brief(e)}`;
  }
}

async function checkOpenAI(): Promise<string> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) return `${pad("OPENAI_API_KEY")} not set`;
  try {
    // Retrieving the model is enough to prove auth + reachability, without
    // paying for a transcription on every check.
    const m = await new OpenAI({ apiKey: key }).models.retrieve(WHISPER_MODEL);
    return `${pad("OPENAI_API_KEY")} OK   (${m.id})`;
  } catch (e) {
    return `${pad("OPENAI_API_KEY")} FAIL (${WHISPER_MODEL}) — ${brief(e)}`;
  }
}

const results = await Promise.all([checkAnthropic(), checkGemini(), checkTwelveLabs(), checkOpenAI()]);
for (const line of results) console.log(line);
if (results.some((r) => r.includes("FAIL"))) process.exit(1);

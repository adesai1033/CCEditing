import { GoogleGenAI } from "@google/genai";

export const DESCRIBE_MODEL = "gemini-2.5-flash";

let cachedAi: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  if (cachedAi) return cachedAi;
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey and export it before running this command.",
    );
  }
  cachedAi = new GoogleGenAI({ apiKey });
  return cachedAi;
}

/**
 * Upload a local video file via the Files API and prompt Gemini for a
 * 2–3 sentence content description. Returns plain text.
 */
export async function describeVideo(filePath: string): Promise<string> {
  const g = ai();

  // Upload via the Files API — handles videos up to ~2GB
  const file = await g.files.upload({
    file: filePath,
    config: { mimeType: "video/mp4" },
  });

  // The file may need a moment to become ACTIVE; poll briefly.
  let active = file;
  for (let i = 0; i < 60 && active.state !== "ACTIVE"; i++) {
    if (active.state === "FAILED") {
      throw new Error(`Gemini Files API failed to process ${filePath}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    active = await g.files.get({ name: active.name! });
  }
  if (active.state !== "ACTIVE") {
    throw new Error(`Gemini Files API timed out processing ${filePath}`);
  }

  const response = await g.models.generateContent({
    model: DESCRIBE_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { mimeType: active.mimeType!, fileUri: active.uri! } },
          {
            text:
              "Describe what happens in this video in 2-3 sentences. " +
              "Focus on concrete actions, subjects, and setting — the kind of " +
              "description an editor would use to decide whether to include " +
              "this clip in a narrative. Do not speculate about emotions or " +
              "off-screen context.",
          },
        ],
      },
    ],
  });

  const text = response.text;
  if (!text || text.trim().length === 0) {
    throw new Error(`Gemini returned an empty description for ${filePath}`);
  }
  return text.trim();
}

export const realBackend = { describeVideo };
export type GeminiBackend = typeof realBackend;

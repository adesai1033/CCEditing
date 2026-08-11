import { AnthropicProvider } from "./anthropic.js";
import type { ChatProvider } from "./types.js";

/**
 * The default production provider, cached. Lazy so the fail-fast missing-key
 * error surfaces on first use, not at import time. Shared by the director loop
 * and by survey_sources' scouts, so they reuse one client (and its connection
 * pool). Lives in its own module so both importers avoid a cycle through loop.ts.
 */
let cachedProvider: ChatProvider | null = null;

export function buildDefaultProvider(): ChatProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = new AnthropicProvider();
  return cachedProvider;
}

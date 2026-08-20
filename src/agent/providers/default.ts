import { AnthropicProvider } from "./anthropic.js";
import type { ChatProvider, ChatResponse } from "./types.js";

/**
 * The default production provider, cached. Lazy so the fail-fast missing-key
 * error surfaces on first use, not at import time. Shared by the director loop,
 * survey_sources' scouts, and the critic, so they reuse one client (and its
 * connection pool). Lives in its own module so importers avoid a cycle through
 * loop.ts.
 *
 * 3K: the cached provider is wrapped with a usage tap. Every send/stream that
 * completes reports (request.role, usage) to the registered listener — one
 * chokepoint that sees director, scout, and critic traffic alike, because all
 * three build from this module. `/cost` is a fold over these reports. The tap
 * changes no behavior: same requests, same responses.
 */

export type UsageRole = "director" | "scout" | "critic";
export type UsageListener = (role: UsageRole, usage: ChatResponse["usage"]) => void;

let usageListener: UsageListener | null = null;

/** The REPL registers here; null clears. Untracked when unset. */
export function setUsageListener(listener: UsageListener | null): void {
  usageListener = listener;
}

/** Wrap any provider so completed calls report their usage. Pure decoration. */
export function withUsageReporting(inner: ChatProvider, report: UsageListener): ChatProvider {
  return {
    send: async (request) => {
      const response = await inner.send(request);
      report(request.role ?? "director", response.usage);
      return response;
    },
    stream: (request) => {
      const handle = inner.stream(request);
      return {
        [Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
        finalResponse: async () => {
          const response = await handle.finalResponse();
          report(request.role ?? "director", response.usage);
          return response;
        },
      };
    },
  };
}

let cachedProvider: ChatProvider | null = null;

export function buildDefaultProvider(): ChatProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = withUsageReporting(
    new AnthropicProvider(),
    (role, usage) => usageListener?.(role, usage),
  );
  return cachedProvider;
}

import { AnthropicProvider, MODEL_DEFAULT } from "./anthropic.js";
import type { ChatProvider, ChatResponse } from "./types.js";

/**
 * Identity of the default provider/model, stamped into the persisted session
 * sidecar (3E-8): reasoning blocks are model-bound, so a load under a
 * different provider or model strips them rather than replaying them.
 */
export type UsageRole = "director" | "scout" | "critic";

/**
 * Model per role. Each role can be pointed at a different model through the
 * environment (CUTCLI_DIRECTOR_MODEL, CUTCLI_CRITIC_MODEL, CUTCLI_SCOUT_MODEL)
 * so model changes can be measured side by side on the same prompt before a
 * default changes. Unset → MODEL_DEFAULT.
 */
export function modelForRole(role: UsageRole): string {
  const env = {
    director: process.env["CUTCLI_DIRECTOR_MODEL"],
    critic: process.env["CUTCLI_CRITIC_MODEL"],
    scout: process.env["CUTCLI_SCOUT_MODEL"],
  }[role];
  return env && env.trim() ? env.trim() : MODEL_DEFAULT;
}

/** The director's model — what a persisted conversation's reasoning is bound to. */
export const DEFAULT_PROVIDER_INFO = { provider: "anthropic", model: modelForRole("director") } as const;

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

/** Wall time and model of one completed call, alongside its token usage. */
export interface CallMeta {
  durationMs: number;
  model: string;
}

export type UsageListener = (role: UsageRole, usage: ChatResponse["usage"], meta: CallMeta) => void;

let usageListener: UsageListener | null = null;

/** The REPL registers here; null clears. Untracked when unset. */
export function setUsageListener(listener: UsageListener | null): void {
  usageListener = listener;
}

/**
 * Wrap any provider so completed calls report their usage, wall time and
 * model, and so each request is sent to its role's model. Timing covers the
 * whole call — for a stream, from opening it to the final response.
 */
export function withUsageReporting(inner: ChatProvider, report: UsageListener): ChatProvider {
  const routed = (request: Parameters<ChatProvider["send"]>[0]) => {
    const role = request.role ?? "director";
    return { role, request: { ...request, model: request.model ?? modelForRole(role) } };
  };
  return {
    send: async (req) => {
      const { role, request } = routed(req);
      const t0 = Date.now();
      const response = await inner.send(request);
      report(role, response.usage, { durationMs: Date.now() - t0, model: request.model });
      return response;
    },
    stream: (req) => {
      const { role, request } = routed(req);
      const t0 = Date.now();
      const handle = inner.stream(request);
      return {
        [Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
        finalResponse: async () => {
          const response = await handle.finalResponse();
          report(role, response.usage, { durationMs: Date.now() - t0, model: request.model });
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
    (role, usage, meta) => usageListener?.(role, usage, meta),
  );
  return cachedProvider;
}

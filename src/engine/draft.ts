import type { ProjectState } from "../project/types.js";
import { layoutTimeline, overlaysOf } from "../project/types.js";
import { makeProxy, INDEX_PROXY } from "../media/proxy.js";
import { overlayLayersFor } from "./layers.js";
import { renderPreviewFromSegments, type PreviewSegment, type RenderPreviewResult, type RenderPreviewOpts } from "./preview.js";

/**
 * Drafts: fast renders for looking at a cut (the reviewer, /preview), never
 * for delivery.
 *
 * withProxies() returns a copy of the project whose sources point at their
 * cached 720p master proxies (media/proxy.ts). The masters keep the sources'
 * timestamps, so every clip, overlay and sync offset means the same thing —
 * but decoding them takes seconds where a 4K/60 HEVC original takes minutes.
 * The export always reads the originals.
 */
export async function withProxies(state: ProjectState): Promise<ProjectState> {
  const used = new Set<string>([
    ...layoutTimeline(state.timeline).clips.map((p) => p.clip.sourceId),
    ...overlaysOf(state.timeline).map((o) => o.sourceId),
  ]);
  const sources = await Promise.all(state.sources.map(async (s) => {
    if (!used.has(s.id)) return s;
    try {
      const proxy = await makeProxy(s.filePath, INDEX_PROXY);
      return { ...s, filePath: proxy.path };
    } catch {
      return s;   // fall back to the original rather than fail the draft
    }
  }));
  return { ...state, sources };
}

/** The whole timeline as preview segments, with its edge effects. */
export function timelineSegments(state: ProjectState): PreviewSegment[] {
  const byId = new Map(state.sources.map((s) => [s.id, s]));
  const layout = layoutTimeline(state.timeline);
  const anyEffects = layout.clips.some((p) => p.transitionOut !== null || p.fadeIn > 0 || p.fadeOut > 0);
  return layout.clips.map((p) => {
    const src = byId.get(p.clip.sourceId)!;
    const seg: PreviewSegment = { input: src.filePath, start: p.clip.inPoint, end: p.clip.outPoint };
    if (anyEffects) {
      seg.effects = {
        hasAudio: src.audioCodec != null,
        ...(p.fadeIn > 0 ? { fadeIn: p.fadeIn } : {}),
        ...(p.fadeOut > 0 ? { fadeOut: p.fadeOut } : {}),
        ...(p.transitionOut ? { transitionOut: p.transitionOut } : {}),
      };
    }
    return seg;
  });
}

/** Render the whole timeline from proxies to a draft file. */
export async function renderDraft(state: ProjectState, opts: RenderPreviewOpts = {}): Promise<RenderPreviewResult> {
  const proxied = await withProxies(state);
  const layers = overlayLayersFor(proxied);
  if (!layers.ok) return { ok: false, code: "MISSING_SOURCE", error: layers.error };
  return renderPreviewFromSegments(timelineSegments(proxied), {
    ...opts,
    ...(layers.layers.length > 0 ? { overlays: layers.layers } : {}),
  });
}

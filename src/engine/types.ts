import type { OverlayAnchor, OverlayFit, Transition } from "../project/types.js";

export interface TrimOperation {
  type: "trim";
  input: string;   // absolute or relative file path
  start: number;   // seconds
  end: number;     // seconds
  output: string;  // file path
}

export interface ConcatOperation {
  type: "concat";
  segments: string[]; // absolute paths to pre-trimmed segment files, in order
  output: string;
}

/**
 * One already-trimmed segment entering a filter-graph join, plus the effects
 * applied at its edges. `transitionOut` overlaps this segment with the next
 * by its duration (xfade + acrossfade); fades go to/from black and silence.
 */
export interface JoinSegment {
  path: string;
  duration: number;       // seconds (out - in of the trim that produced it)
  hasAudio: boolean;
  fadeIn?: number;        // seconds; 0/undefined = none
  fadeOut?: number;
  transitionOut?: Transition | null;
}

/**
 * Join trimmed segments with transitions and fades. Unlike ConcatOperation
 * (a stream copy) this re-encodes: every input is normalized to the first
 * segment's size and frame rate so xfade/concat accept them.
 */
export interface JoinOperation {
  type: "join";
  segments: JoinSegment[];
  output: string;
}

/**
 * One layer to composite onto a base video. Geometry is in base-frame
 * fractions (see project/types.ts Overlay); the engine resolves it to pixels
 * against the base's real dimensions at run time, so the same layer renders
 * correctly on a 480p preview and a 4K export.
 */
export interface OverlayLayer {
  input: string;        // overlay source file path
  inPoint: number;      // seconds within the overlay source
  outPoint: number;
  at: number;           // seconds into the BASE where the layer starts
  anchor: OverlayAnchor;
  x: number;
  y: number;
  scale: number;
  sourceWidth: number;  // overlay source dimensions (for aspect)
  sourceHeight: number;
  fit?: OverlayFit;     // full-frame cutaway; geometry above is ignored
}

export interface OverlayOperation {
  type: "overlay";
  base: string;           // fully rendered main-track video
  layers: OverlayLayer[]; // bottom → top
  output: string;
}

export type EditOperation = TrimOperation | ConcatOperation | JoinOperation | OverlayOperation;

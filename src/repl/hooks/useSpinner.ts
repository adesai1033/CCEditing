import { useEffect, useState } from "react";
import { animation, spinnerFrames } from "../../ui/theme.js";

/**
 * One shared animation ticker (3I, decision 5). The App runs a single instance
 * and passes the frame index down, so every animated glyph in the tree steps
 * in lockstep on one slow interval — no per-component timers, no tearing
 * against the 3E-4 stream. Stops (and resets) when nothing is animating.
 */
export function useSpinnerFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const id = setInterval(
      () => setFrame((f) => (f + 1) % spinnerFrames.length),
      animation.tickMs,
    );
    return () => clearInterval(id);
  }, [active]);
  return frame;
}

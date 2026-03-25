/**
 * Parse a time string into seconds (float).
 *
 * Accepted formats:
 *   5          → 5.0
 *   90.5       → 90.5
 *   1:30       → 90.0   (MM:SS)
 *   00:05      → 5.0
 *   1:30:00    → 5400.0 (HH:MM:SS)
 *   0:01:30.5  → 90.5   (HH:MM:SS.ms)
 */
export function parseTime(input: string): number {
  const s = input.trim();
  if (s === "") throw new Error("Time string cannot be empty");

  // Pure number
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n < 0) throw new Error(`Time cannot be negative: ${input}`);
    return n;
  }

  // HH:MM:SS[.ms] or MM:SS[.ms]
  const parts = s.split(":");
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => {
      const n = parseFloat(p);
      if (isNaN(n) || n < 0) throw new Error(`Invalid time component "${p}" in: ${input}`);
      return n;
    });

    if (parts.length === 2) {
      // MM:SS
      const [mm, ss] = nums as [number, number];
      if (ss >= 60) throw new Error(`Seconds out of range in: ${input}`);
      return mm * 60 + ss;
    } else {
      // HH:MM:SS
      const [hh, mm, ss] = nums as [number, number, number];
      if (mm >= 60) throw new Error(`Minutes out of range in: ${input}`);
      if (ss >= 60) throw new Error(`Seconds out of range in: ${input}`);
      return hh * 3600 + mm * 60 + ss;
    }
  }

  throw new Error(`Unrecognized time format: ${input}`);
}

/**
 * Format seconds as a human-readable time string.
 *   90     → "1:30"
 *   5400   → "1:30:00"
 *   90.5   → "1:30.5"
 */
export function formatTime(seconds: number): string {
  const totalSecs = Math.floor(seconds);
  const frac = seconds - totalSecs;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;

  const fracStr = frac > 0 ? `.${String(Math.round(frac * 10))}` : "";
  const secStr = String(s).padStart(2, "0") + fracStr;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${secStr}`;
  }
  return `${m}:${secStr}`;
}

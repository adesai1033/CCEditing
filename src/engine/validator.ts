import { access, constants } from "node:fs/promises";
import path from "node:path";
import { probeFile } from "../media/probe.js";
import type { TrimOperation } from "./types.js";

export type ValidationResult =
  | { ok: true; duration: number }
  | { ok: false; error: string };

export async function validateTrim(op: TrimOperation): Promise<ValidationResult> {
  // Probe the input file (also checks existence)
  const probe = await probeFile(op.input);
  if (!probe.ok) {
    return { ok: false, error: probe.error };
  }

  const { duration } = probe.data;

  if (op.start < 0) {
    return { ok: false, error: `Start time cannot be negative` };
  }

  if (op.end <= op.start) {
    return {
      ok: false,
      error: `End time (${formatSec(op.end)}) must be after start time (${formatSec(op.start)})`,
    };
  }

  if (op.start >= duration) {
    return {
      ok: false,
      error: `Start time (${formatSec(op.start)}) exceeds video duration (${formatSec(duration)})`,
    };
  }

  if (op.end > duration) {
    return {
      ok: false,
      error: `End time (${formatSec(op.end)}) exceeds video duration (${formatSec(duration)})`,
    };
  }

  // Check output directory is writable
  const outDir = path.dirname(path.resolve(op.output));
  try {
    await access(outDir, constants.W_OK);
  } catch {
    return { ok: false, error: `Output directory is not writable: ${outDir}` };
  }

  return { ok: true, duration };
}

function formatSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

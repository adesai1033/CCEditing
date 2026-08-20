import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  paletteForLevel,
  paint,
  ui,
  panels,
  glyphs,
  spinnerFrames,
  thinkingFrames,
  spinnerFrame,
  thinkingFrame,
  clipPaint,
  stripAnsi,
  colorLevel,
} from "../ui/theme.js";

describe("theme — palette capability fallback", () => {
  test("limited-color terminals get named ANSI colors, not hex", () => {
    for (const level of [0, 1]) {
      const p = paletteForLevel(level);
      for (const [role, value] of Object.entries(p)) {
        assert.ok(!value.startsWith("#"), `${role} at level ${level} must be a named color, got ${value}`);
      }
    }
  });

  test("256/truecolor terminals get the rich hex palette", () => {
    for (const level of [2, 3]) {
      const p = paletteForLevel(level);
      for (const [role, value] of Object.entries(p)) {
        assert.match(value, /^#[0-9a-f]{6}$/i, `${role} at level ${level} must be hex, got ${value}`);
      }
    }
  });

  test("every semantic role resolves at every level", () => {
    const roles = ["accent", "success", "warning", "danger", "info", "inFlight"];
    for (const level of [0, 1, 2, 3]) {
      const p = paletteForLevel(level) as Record<string, string>;
      for (const role of roles) {
        assert.ok(p[role] && p[role].length > 0, `${role} missing at level ${level}`);
      }
    }
  });

  test("colorLevel reports a sane depth", () => {
    const level = colorLevel();
    assert.ok(level >= 0 && level <= 3);
  });
});

describe("theme — stylers", () => {
  test("paint stylers preserve their content", () => {
    for (const [name, fn] of Object.entries(paint)) {
      const styled = fn("hello");
      assert.equal(stripAnsi(styled), "hello", `paint.${name} must not alter the text`);
    }
  });

  test("clipPaint cycles and preserves content", () => {
    assert.equal(stripAnsi(clipPaint(0)("x")), "x");
    // The cycle wraps: index i and i+cycle produce identical styling.
    assert.equal(clipPaint(1)("x"), clipPaint(5)("x"));
  });

  test("ui prop bags carry only Ink text props", () => {
    const allowed = new Set(["color", "dimColor", "bold", "italic"]);
    for (const [role, bag] of Object.entries(ui)) {
      assert.ok(Object.keys(bag).length > 0, `ui.${role} is empty`);
      for (const key of Object.keys(bag)) {
        assert.ok(allowed.has(key), `ui.${role} has unexpected prop ${key}`);
      }
    }
  });

  test("panels define a border style", () => {
    for (const [name, bag] of Object.entries(panels)) {
      assert.equal(bag.borderStyle, "round", `panels.${name} must set a border style`);
      assert.ok(bag.borderColor, `panels.${name} must set a border color`);
    }
  });
});

describe("theme — glyphs and animation", () => {
  test("status glyphs are defined and distinct", () => {
    assert.ok(glyphs.done && glyphs.failed && glyphs.caution && glyphs.thinking);
    assert.notEqual(glyphs.done, glyphs.failed);
  });

  test("spinner and thinking frames stay in lockstep and wrap", () => {
    assert.ok(spinnerFrames.length >= 2, "animation needs frames");
    assert.equal(spinnerFrames.length, thinkingFrames.length, "one ticker drives both");
    assert.equal(spinnerFrame(0), spinnerFrames[0]);
    assert.equal(spinnerFrame(spinnerFrames.length), spinnerFrames[0], "frame index wraps");
    assert.equal(thinkingFrame(thinkingFrames.length + 1), thinkingFrames[1]);
  });

  test("stripAnsi strips styling and nothing else", () => {
    assert.equal(stripAnsi("\x1B[36mplain\x1B[39m"), "plain");
    assert.equal(stripAnsi("already plain"), "already plain");
  });
});

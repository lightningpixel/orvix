import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateTokens } from "../src/render/tokens.js";

/**
 * The characters-per-token figure appears in four places, and it cannot be
 * shared from one.
 *
 * The hook scripts are deliberately standalone — they are copied into a
 * project and must run without resolving anything back to the package, which
 * is what makes them portable to agents other than Claude Code. The benchmark
 * and the measure script are plain node scripts that may run before a build.
 *
 * So the constant is duplicated on purpose, and this test is what stops the
 * copies drifting: if they disagree, a saving measured by one is not
 * comparable with a saving measured by another, and every number Orvix
 * publishes about itself quietly stops meaning the same thing.
 */
const SOURCES = [
  "hooks/orvix-compress.mjs",
  "scripts/measure.mjs",
  "benchmarks/run.mjs",
];

describe("characters per token", () => {
  test("agrees everywhere it is written down", () => {
    // Compared by behaviour rather than by value: estimateTokens rounds up, so
    // the ratio cannot be recovered exactly from its output, and what has to
    // match is the count each copy would produce — not the literal itself.
    const lengths = [1, 7, 100, 999, 5000, 123_457];

    for (const path of SOURCES) {
      const source = readFileSync(resolve(path), "utf8");
      const match = /CHARS_PER_TOKEN\s*=\s*([\d.]+)/.exec(source);

      expect(match, `${path} does not declare CHARS_PER_TOKEN`).not.toBeNull();
      const perToken = Number(match![1]);

      for (const length of lengths) {
        expect(
          Math.ceil(length / perToken),
          `${path} counts ${length} characters differently from src/render/tokens.ts`,
        ).toBe(estimateTokens("a".repeat(length)));
      }
    }
  });

  test("the hook scripts import nothing outside node builtins", () => {
    // The property that forces the duplication above: a hook is copied into
    // the user's project, so anything it imports has to be there too.
    for (const path of ["hooks/orvix-compress.mjs", "hooks/orvix-dirty.mjs", "hooks/orvix-reconcile.mjs"]) {
      const source = readFileSync(resolve(path), "utf8");

      for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
        expect(match[1], `${path} imports ${match[1]}`).toMatch(/^node:/);
      }
    }
  });
});

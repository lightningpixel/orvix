import { afterEach, describe, expect, test } from "vitest";
import { runIndex } from "../src/commands/indexCommand.js";
import { runMap } from "../src/commands/map.js";
import { run as runQuery } from "../src/query/run.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * A small parser and its one private caller, buried under a busy exported
 * surface that dominates the global ranking.
 */
function busyProject(): Record<string, string> {
  const widgets: string[] = ["export function hub() {}\n"];
  for (let n = 0; n < 12; n += 1) {
    widgets.push(`export function widget${n}() { hub(); }\n`);
  }

  return {
    "src/parser.ts": `export function parse(text: string) {\n  return text;\n}\n`,
    "src/extract.ts":
      `import { parse } from "./parser";\n` +
      `function extractFile(text: string) {\n  return parse(text);\n}\n` +
      `function unrelatedHelper() {}\n`,
    "src/ui.ts": widgets.join(""),
  };
}

async function indexed(files: Record<string, string>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  await runIndex(made.root);
  return made.root;
}

const TIGHT = 60;

describe("orvix map --focus", () => {
  test("the unfocused map leaves the private caller out at this budget", async () => {
    // Guards the next test: if the global ranking already showed
    // extractFile, focusing would prove nothing.
    const { output } = await runMap(await indexed(busyProject()), { budget: TIGHT });

    expect(output).not.toContain("extractFile");
  });

  test("brings a focused symbol's neighbours ahead of the busy surface", async () => {
    const { output, ok } = await runMap(await indexed(busyProject()), {
      budget: TIGHT,
      focus: ["parse"],
    });

    expect(ok).toBe(true);
    expect(output).toContain("function parse");
    expect(output).toContain("extractFile");
    expect(output).not.toContain("widget0");
  });

  test("reaches callers as well as callees", async () => {
    // Focus walks edges both ways. Following calls alone would leave
    // `parse`, which calls nothing, with no neighbourhood at all.
    const { output } = await runMap(await indexed(busyProject()), {
      budget: TIGHT,
      focus: ["extractFile"],
    });

    expect(output).toContain("function parse");
    expect(output).not.toContain("widget0");
  });

  test("ranks a symbol with a path to the focus above one without", async () => {
    const { output } = await runMap(await indexed(busyProject()), {
      budget: TIGHT,
      focus: ["parse"],
    });

    expect(output).toContain("extractFile");
    expect(output).not.toContain("unrelatedHelper");
  });

  test("accepts a file, focusing on every symbol in it", async () => {
    const { output, ok } = await runMap(await indexed(busyProject()), {
      budget: TIGHT,
      focus: ["src/parser.ts"],
    });

    expect(ok).toBe(true);
    expect(output).toContain("extractFile");
  });

  test("still honours the budget", async () => {
    const { output } = await runMap(await indexed(busyProject()), {
      budget: TIGHT,
      focus: ["parse"],
    });

    expect(Math.ceil(output.length / 3.5)).toBeLessThanOrEqual(TIGHT);
  });

  test("fails with a pointer to find when nothing matches", async () => {
    const { output, ok } = await runMap(await indexed(busyProject()), {
      focus: ["nothingLikeThis"],
    });

    expect(ok).toBe(false);
    expect(output).toContain("nothingLikeThis");
    expect(output).toContain("orvix find");
  });

  test("ignores a target it cannot match when another one matches", async () => {
    // A prompt mentions several names and some of them will not be symbols.
    const { ok, output } = await runMap(await indexed(busyProject()), {
      budget: TIGHT,
      focus: ["parse", "nothingLikeThis"],
    });

    expect(ok).toBe(true);
    expect(output).toContain("extractFile");
  });

  test("is reachable through orvix-query, comma-separated", async () => {
    const root = await indexed(busyProject());

    const { output, ok } = await runQuery([
      "map", "-p", root, "-b", String(TIGHT), "--focus", "parse,src/parser.ts",
    ]);

    expect(ok).toBe(true);
    expect(output).toContain("extractFile");
  });
});

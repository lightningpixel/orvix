import { afterEach, describe, expect, test } from "vitest";
import { buildIndex } from "../src/core/indexer.js";
import { buildCallGraph } from "../src/core/resolve.js";
import { rankSymbols } from "../src/core/rank.js";
import { emptyIndex } from "../src/core/store.js";
import { estimateTokens } from "../src/render/tokens.js";
import { renderMap } from "../src/render/map.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function mapOf(
  files: Record<string, string>,
  budget = 4000,
): Promise<string> {
  const made = await makeProject(files);
  cleanup = made.cleanup;

  const { index } = await buildIndex(made.root);
  const graph = buildCallGraph(index);

  return renderMap(index, graph, rankSymbols(index, graph), { budget });
}

describe("estimateTokens", () => {
  test("scales with length", () => {
    expect(estimateTokens("a".repeat(400))).toBeGreaterThan(
      estimateTokens("a".repeat(40)),
    );
  });

  test("treats empty text as free", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("renderMap", () => {
  test("groups symbols under their file", async () => {
    const out = await mapOf({
      "src/a.ts": `export function alpha() {}\n`,
      "src/b.ts": `export function beta() {}\n`,
    });

    expect(out).toMatch(/^src\/a\.ts$/m);
    expect(out).toMatch(/^src\/b\.ts$/m);
    expect(out.indexOf("src/a.ts")).toBeLessThan(out.indexOf("src/b.ts"));
  });

  test("shows a short id, the signature and the line number", async () => {
    const out = await mapOf({
      "src/a.ts": `export function greet(name: string): string {\n  return name;\n}\n`,
    });

    expect(out).toMatch(/[0-9a-z]{4}.*function greet\(name: string\): string.*:1/);
  });

  test("marks exported symbols and leaves private ones unmarked", async () => {
    const out = await mapOf({
      "src/a.ts": `export function pub() {}\nfunction priv() {}\n`,
    });

    expect(out).toMatch(/\*.*function pub/);
    expect(out).not.toMatch(/\*.*function priv/);
  });

  test("shows the inbound caller count when there is one", async () => {
    const out = await mapOf({
      "src/a.ts": `function hot() {}\nfunction c1() { hot(); }\nfunction c2() { hot(); }\n`,
    });

    expect(out).toMatch(/function hot\(\).*←2/);
    expect(out).not.toMatch(/function c1\(\).*←/);
  });

  test("qualifies a method with its container", async () => {
    const out = await mapOf({
      "src/a.ts": `export class Service {\n  validate(email: string) {}\n}\n`,
    });

    expect(out).toContain("Service.validate");
  });

  test("qualifies at the name, not in front of a leading keyword", async () => {
    // A Python signature starts with `def`, so prefixing the whole string
    // would render `Service.def run(self)`.
    const out = await mapOf({
      "src/a.py": `class Service:\n    def run(self):\n        pass\n`,
    });

    expect(out).toContain("Service.run");
    expect(out).not.toContain("Service.def");
  });

  test("says so plainly when the project has no symbols", () => {
    const index = emptyIndex();
    const graph = buildCallGraph(index);

    expect(renderMap(index, graph, rankSymbols(index, graph), { budget: 100 }))
      .toContain("no symbols");
  });
});

describe("renderMap — token budget", () => {
  const wide: Record<string, string> = {};
  for (let f = 0; f < 12; f += 1) {
    const body = Array.from(
      { length: 12 },
      (_, i) =>
        `export function file${f}symbol${i}(argument: SomeLongTypeName): AnotherLongReturnType {}\n`,
    ).join("");
    wide[`src/mod${f}.ts`] = body;
  }

  test("stays within the budget it is given", async () => {
    for (const budget of [80, 200, 600, 1500]) {
      const out = await mapOf(wide, budget);
      expect(estimateTokens(out), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  test("a larger budget shows more", async () => {
    const small = await mapOf(wide, 200);
    const large = await mapOf(wide, 1500);

    expect(large.length).toBeGreaterThan(small.length);
  });

  test("keeps the most important symbols when it has to cut", async () => {
    const out = await mapOf(
      {
        "src/a.ts":
          `export function hot() {}\n` +
          Array.from({ length: 30 }, (_, i) => `function filler${i}() { hot(); }\n`).join(""),
      },
      120,
    );

    expect(out).toContain("hot");
  });

  test("reports how many symbols it hid", async () => {
    const out = await mapOf(wide, 300);

    expect(out).toMatch(/\d+ more/);
  });

  test("degrades to a summary rather than overflowing a tiny budget", async () => {
    const out = await mapOf(wide, 20);

    expect(estimateTokens(out)).toBeLessThanOrEqual(20);
    expect(out).toMatch(/\d+ files/);
  });
});

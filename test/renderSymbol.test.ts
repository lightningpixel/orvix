import { afterEach, describe, expect, test } from "vitest";
import { buildIndex } from "../src/core/indexer.js";
import { projectionOf, tableOf, graphOf } from "./helpers/projection.js";
import { renderList, renderSource } from "../src/render/symbol.js";
import type { IndexedSymbol, OrvixIndex } from "../src/types.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function indexOf(files: Record<string, string>): Promise<OrvixIndex> {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  return (await buildIndex(made.root)).index;
}

const find = (index: OrvixIndex, name: string): IndexedSymbol =>
  Object.values(index.files)
    .flatMap((entry) => entry.symbols)
    .find((symbol) => symbol.name === name)!;

const SOURCE = `function before() {}\nfunction target(a: number) {\n  return a + 1;\n}\nfunction after() {}\n`;

describe("renderSource", () => {
  test("prints the file and line range in the header", async () => {
    const index = await indexOf({ "src/a.ts": SOURCE });

    const out = renderSource(find(index, "target"), SOURCE);

    expect(out.split("\n")[0]).toContain("src/a.ts:2-4");
  });

  test("prints the symbol's own source, exactly", async () => {
    const index = await indexOf({ "src/a.ts": SOURCE });

    const out = renderSource(find(index, "target"), SOURCE);

    expect(out).toContain("function target(a: number) {\n  return a + 1;\n}");
  });

  test("prints nothing from the surrounding code", async () => {
    const index = await indexOf({ "src/a.ts": SOURCE });

    const out = renderSource(find(index, "target"), SOURCE);

    expect(out).not.toContain("before");
    expect(out).not.toContain("after");
  });
});

describe("renderList", () => {
  test("shows one line per symbol, with file and line", async () => {
    const index = await indexOf({ "src/a.ts": SOURCE });
    const { table, graph } = projectionOf(index);

    const out = renderList([find(index, "target")], table, graph);

    expect(out).toMatch(/src\/a\.ts:2/);
    expect(out.split("\n")).toHaveLength(1);
  });

  test("marks exported symbols", async () => {
    const index = await indexOf({
      "src/a.ts": `export function pub() {}\nfunction priv() {}\n`,
    });
    const { table, graph } = projectionOf(index);

    expect(renderList([find(index, "pub")], table, graph)).toContain("*");
    expect(renderList([find(index, "priv")], table, graph)).not.toContain("*");
  });

  test("shows the inbound caller count", async () => {
    const index = await indexOf({
      "src/a.ts": `function hot() {}\nfunction c1() { hot(); }\n`,
    });
    const { table, graph } = projectionOf(index);

    expect(renderList([find(index, "hot")], table, graph)).toContain("←1");
  });

  test("says so plainly when there is nothing to list", async () => {
    const index = await indexOf({ "src/a.ts": SOURCE });

    expect(renderList([], tableOf(index), graphOf(index))).toContain("none");
  });
});

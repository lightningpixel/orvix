import { afterEach, describe, expect, test } from "vitest";
import { buildIndex } from "../src/core/indexer.js";
import { buildCallGraph } from "../src/core/resolve.js";
import { rankSymbols } from "../src/core/rank.js";
import { emptyIndex } from "../src/core/store.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Ranks one project, keyed by symbol name for readable assertions. */
async function ranksOf(source: string): Promise<Map<string, number>> {
  const made = await makeProject({ "src/a.ts": source });
  cleanup = made.cleanup;

  const { index } = await buildIndex(made.root);
  const ranks = rankSymbols(index, buildCallGraph(index));

  const byName = new Map<string, number>();
  for (const entry of Object.values(index.files)) {
    for (const symbol of entry.symbols) {
      byName.set(symbol.name, ranks.get(symbol.id) ?? 0);
    }
  }
  return byName;
}

describe("rankSymbols", () => {
  test("ranks a widely called symbol above an uncalled one", async () => {
    const ranks = await ranksOf(
      `function hot() {}\nfunction cold() {}\n` +
        `function c1() { hot(); }\nfunction c2() { hot(); }\nfunction c3() { hot(); }\n`,
    );

    expect(ranks.get("hot")!).toBeGreaterThan(ranks.get("cold")!);
  });

  test("propagates importance through the graph", async () => {
    // `target` is called once, by a hub that is itself called three times.
    // `other` is called once, by a function nothing calls.
    const ranks = await ranksOf(
      `function target() {}\nfunction other() {}\n` +
        `function hub() { target(); }\nfunction weak() { other(); }\n` +
        `function a1() { hub(); }\nfunction a2() { hub(); }\nfunction a3() { hub(); }\n`,
    );

    expect(ranks.get("target")!).toBeGreaterThan(ranks.get("other")!);
  });

  test("ranks an exported symbol above an equivalent private one", async () => {
    const ranks = await ranksOf(`export function pub() {}\nfunction priv() {}\n`);

    expect(ranks.get("pub")!).toBeGreaterThan(ranks.get("priv")!);
  });

  test("keeps an exported type visible even though nothing calls it", async () => {
    // Types are never call targets, so without the exported bias they would
    // always sink to the bottom of the map.
    const ranks = await ranksOf(
      `export interface Config { url: string }\nconst LOCAL_DEFAULT = 1;\n`,
    );

    expect(ranks.get("Config")!).toBeGreaterThan(ranks.get("LOCAL_DEFAULT")!);
  });
});

describe("numerical behaviour", () => {
  test("ranks form a probability distribution", async () => {
    const ranks = await ranksOf(
      `export function a() { b(); }\nfunction b() { c(); }\nfunction c() {}\n`,
    );

    const total = [...ranks.values()].reduce((sum, r) => sum + r, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  test("converges on a cycle instead of diverging", async () => {
    const ranks = await ranksOf(`function a() { b(); }\nfunction b() { a(); }\n`);

    for (const value of ranks.values()) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  test("is deterministic", async () => {
    const source = `export function a() { b(); }\nfunction b() {}\n`;

    expect([...(await ranksOf(source)).entries()]).toEqual([
      ...(await ranksOf(source)).entries(),
    ]);
  });

  test("returns an empty map for an empty project", () => {
    const index = emptyIndex();

    expect(rankSymbols(index, buildCallGraph(index)).size).toBe(0);
  });
});

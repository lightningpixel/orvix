import { afterEach, describe, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  INDEX_VERSION,
  emptyGraph,
  emptySymbols,
  emptyIndex,
  graphPath,
  indexPath,
  loadGraph,
  loadIndex,
  loadSymbols,
  saveIndex,
  saveProjection,
  symbolsPath,
} from "../src/core/store.js";
import { PROJECTION_VERSION } from "../src/core/project.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function project() {
  const made = await makeProject({ "src/a.ts": "export function a() {}\n" });
  cleanup = made.cleanup;
  return made.root;
}

async function writeRaw(root: string, contents: string) {
  const path = indexPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

describe("loadIndex", () => {
  test("returns an empty index when the project has never been indexed", async () => {
    expect(await loadIndex(await project())).toEqual(emptyIndex());
  });

  test("returns an empty index when the stored file is corrupt", async () => {
    const root = await project();
    await writeRaw(root, "{ not json");

    expect(await loadIndex(root)).toEqual(emptyIndex());
  });

  test("returns an empty index when the stored version is older", async () => {
    const root = await project();
    await writeRaw(
      root,
      JSON.stringify({ version: INDEX_VERSION - 1, files: { "x.ts": {} } }),
    );

    expect(await loadIndex(root)).toEqual(emptyIndex());
  });
});

describe("saveIndex", () => {
  test("round-trips an index through disk", async () => {
    const root = await project();
    const index = emptyIndex();
    index.files["src/a.ts"] = {
      language: "typescript",
      mtimeMs: 1234,
      size: 22,
      symbols: [
        {
          id: "abcd12345678",
          file: "src/a.ts",
          name: "a",
          kind: "function",
          signature: "function a()",
          startLine: 1,
          endLine: 1,
          startByte: 7,
          endByte: 22,
          exported: true,
        },
      ],
      references: [],
      imports: [],
    };

    await saveIndex(root, index);

    expect(await loadIndex(root)).toEqual(index);
  });

  test("creates the .orvix directory", async () => {
    const root = await project();

    await saveIndex(root, emptyIndex());

    expect(existsSync(join(root, ".orvix"))).toBe(true);
  });

  test("writes the current version", async () => {
    const root = await project();

    await saveIndex(root, emptyIndex());

    const raw = JSON.parse(await readFile(indexPath(root), "utf8"));
    expect(raw.version).toBe(INDEX_VERSION);
  });
});

const sampleProjection = {
  symbols: {
    version: PROJECTION_VERSION,
    symbols: {
      abcd12345678: {
        id: "abcd12345678",
        file: "src/a.ts",
        name: "a",
        kind: "function" as const,
        signature: "function a()",
        startLine: 1,
        endLine: 1,
        startByte: 7,
        endByte: 22,
        exported: true,
      },
    },
    byName: { a: ["abcd12345678"] },
    byFile: { "src/a.ts": ["abcd12345678"] },
    ranks: { abcd12345678: 0.5 },
  },
  graph: {
    version: PROJECTION_VERSION,
    callers: {},
    callees: {},
    fileCallers: {},
    refsByName: { helper: ["src/a.ts"] },
    exportSig: { "src/a.ts": "deadbeef" },
    ambiguous: [],
    dispatch: {},
    unresolvedByFile: {},
    unresolved: 0,
  },
};

describe("saveProjection", () => {
  test("round-trips the symbol table through disk", async () => {
    const root = await project();

    await saveProjection(root, sampleProjection);

    expect(await loadSymbols(root)).toEqual(sampleProjection.symbols);
  });

  test("round-trips the graph through disk", async () => {
    const root = await project();

    await saveProjection(root, sampleProjection);

    expect(await loadGraph(root)).toEqual(sampleProjection.graph);
  });

  test("writes the symbol table without any call sites", async () => {
    // The whole point of the split: references are the bulk, and a query never
    // needs them. If they leak in here, query cost tracks project size again.
    const root = await project();

    await saveProjection(root, sampleProjection);

    const raw = await readFile(symbolsPath(root), "utf8");
    expect(raw).not.toContain("references");
  });

  test("is byte-identical when written twice", async () => {
    const root = await project();

    await saveProjection(root, sampleProjection);
    const first = await readFile(graphPath(root), "utf8");
    await saveProjection(root, sampleProjection);

    expect(await readFile(graphPath(root), "utf8")).toBe(first);
  });
});

describe("loadSymbols and loadGraph", () => {
  test("return empty projections when nothing has been indexed", async () => {
    const root = await project();

    expect(await loadSymbols(root)).toEqual(emptySymbols());
    expect(await loadGraph(root)).toEqual(emptyGraph());
  });

  test("return empty projections when the stored file is corrupt", async () => {
    const root = await project();
    await mkdir(dirname(symbolsPath(root)), { recursive: true });
    await writeFile(symbolsPath(root), "{ not json", "utf8");
    await writeFile(graphPath(root), "{ not json", "utf8");

    expect(await loadSymbols(root)).toEqual(emptySymbols());
    expect(await loadGraph(root)).toEqual(emptyGraph());
  });

  test("return lookups that cannot see Object.prototype", async () => {
    // JSON.parse hands back plain objects, so a query for a symbol named
    // `toString` would otherwise get an inherited function back and treat a
    // miss as a hit.
    const root = await project();
    await saveProjection(root, sampleProjection);

    const symbols = await loadSymbols(root);
    const graph = await loadGraph(root);

    expect(symbols.byName["toString"]).toBeUndefined();
    expect(symbols.symbols["constructor"]).toBeUndefined();
    expect(symbols.byFile["valueOf"]).toBeUndefined();
    expect(symbols.ranks["toString"]).toBeUndefined();
    expect(graph.callers["toString"]).toBeUndefined();
    expect(graph.callees["constructor"]).toBeUndefined();
    expect(graph.refsByName["toString"]).toBeUndefined();
    expect(graph.exportSig["constructor"]).toBeUndefined();
  });

  test("discard a projection written by an older version", async () => {
    const root = await project();
    await saveProjection(root, sampleProjection);
    await writeFile(
      symbolsPath(root),
      JSON.stringify({ ...sampleProjection.symbols, version: PROJECTION_VERSION - 1 }),
      "utf8",
    );

    expect(await loadSymbols(root)).toEqual(emptySymbols());
  });
});

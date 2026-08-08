import { describe, expect, test } from "vitest";
import { projectIndex, serialise } from "../src/core/project.js";
import { buildCallGraph } from "../src/core/resolve.js";
import { rankSymbols } from "../src/core/rank.js";
import { emptyIndex } from "../src/core/store.js";
import type { IndexedSymbol, OrvixIndex, RawReference } from "../src/types.js";

/** Builds an index by hand so a projection can be checked against known input. */
function indexOf(
  files: Record<
    string,
    { symbols: Partial<IndexedSymbol>[]; references?: Partial<RawReference>[] }
  >,
): OrvixIndex {
  const index = emptyIndex();

  for (const [path, spec] of Object.entries(files)) {
    index.files[path] = {
      language: "typescript",
      mtimeMs: 1,
      size: 1,
      symbols: spec.symbols.map((symbol, position) => ({
        id: symbol.id ?? `id${position}`,
        file: path,
        name: symbol.name ?? "anon",
        kind: symbol.kind ?? "function",
        signature: symbol.signature ?? `function ${symbol.name ?? "anon"}()`,
        startLine: symbol.startLine ?? position + 1,
        endLine: symbol.endLine ?? position + 1,
        startByte: symbol.startByte ?? 0,
        endByte: symbol.endByte ?? 1,
        exported: symbol.exported ?? false,
        ...(symbol.container ? { container: symbol.container } : {}),
      })),
      references: (spec.references ?? []).map((reference) => ({
        name: reference.name ?? "x",
        line: reference.line ?? 1,
        byte: reference.byte ?? 0,
        fromSymbol: reference.fromSymbol ?? null,
        viaMember: reference.viaMember ?? false,
      })),
      imports: [],
    };
  }

  return index;
}

function projectionOf(index: OrvixIndex) {
  const graph = buildCallGraph(index);
  return projectIndex(index, graph, rankSymbols(index, graph));
}

describe("projectIndex — symbol table", () => {
  test("keys every symbol by its id", () => {
    const index = indexOf({
      "a.ts": { symbols: [{ id: "aaa", name: "alpha" }] },
      "b.ts": { symbols: [{ id: "bbb", name: "beta" }] },
    });

    const { symbols } = projectionOf(index);

    expect(Object.keys(symbols.symbols).sort()).toEqual(["aaa", "bbb"]);
    expect(symbols.symbols["aaa"]?.name).toBe("alpha");
  });

  test("indexes a symbol under its lowercased bare name", () => {
    const index = indexOf({ "a.ts": { symbols: [{ id: "aaa", name: "Alpha" }] } });

    expect(projectionOf(index).symbols.byName["alpha"]).toEqual(["aaa"]);
  });

  test("indexes a contained symbol under both bare and qualified name", () => {
    const index = indexOf({
      "a.ts": {
        symbols: [{ id: "aaa", name: "validate", container: "Service", kind: "method" }],
      },
    });

    const { byName } = projectionOf(index).symbols;

    expect(byName["validate"]).toEqual(["aaa"]);
    expect(byName["service.validate"]).toEqual(["aaa"]);
  });

  test("collects every id sharing a name", () => {
    const index = indexOf({
      "a.ts": { symbols: [{ id: "aaa", name: "run" }] },
      "b.ts": { symbols: [{ id: "bbb", name: "run" }] },
    });

    expect(projectionOf(index).symbols.byName["run"]?.sort()).toEqual(["aaa", "bbb"]);
  });

  test("lists a file's symbols in source order", () => {
    const index = indexOf({
      "a.ts": {
        symbols: [
          { id: "second", name: "b", startLine: 10 },
          { id: "first", name: "a", startLine: 1 },
        ],
      },
    });

    expect(projectionOf(index).symbols.byFile["a.ts"]).toEqual(["second", "first"]);
  });

  test("indexes a symbol whose name collides with Object.prototype", () => {
    // `constructor`, `toString` and friends are ordinary method names in real
    // code. Looked up on a plain object they return an inherited function
    // rather than undefined, so an accumulator keyed by name has to be
    // prototype-free or it treats the inherited member as an existing bucket.
    const index = indexOf({
      "a.ts": {
        symbols: [
          { id: "ctor", name: "constructor", container: "Service", kind: "method" },
          { id: "str", name: "toString", container: "Service", kind: "method" },
        ],
        references: [{ name: "hasOwnProperty" }],
      },
    });

    const { symbols, graph } = projectionOf(index);

    expect(symbols.byName["constructor"]).toEqual(["ctor"]);
    expect(symbols.byName["service.tostring"]).toEqual(["str"]);
    expect(graph.refsByName["hasOwnProperty"]).toEqual(["a.ts"]);
  });

  test("carries the precomputed rank for every symbol", () => {
    const index = indexOf({ "a.ts": { symbols: [{ id: "aaa", name: "alpha" }] } });

    const { ranks } = projectionOf(index).symbols;

    expect(typeof ranks["aaa"]).toBe("number");
    expect(ranks["aaa"]).toBeGreaterThan(0);
  });
});

describe("projectIndex — graph", () => {
  test("stores callers and callees as arrays", () => {
    const index = indexOf({
      "a.ts": {
        symbols: [
          { id: "caller", name: "caller" },
          { id: "callee", name: "callee" },
        ],
        references: [{ name: "callee", fromSymbol: 0 }],
      },
    });

    const { graph } = projectionOf(index);

    expect(graph.callers["callee"]).toEqual(["caller"]);
    expect(graph.callees["caller"]).toEqual(["callee"]);
  });

  test("maps a referenced name to the files that reference it", () => {
    const index = indexOf({
      "a.ts": { symbols: [{ id: "aaa", name: "target", exported: true }] },
      "b.ts": { symbols: [{ id: "bbb", name: "other" }], references: [{ name: "target" }] },
      "c.ts": { symbols: [{ id: "ccc", name: "third" }], references: [{ name: "target" }] },
    });

    expect(projectionOf(index).graph.refsByName["target"]).toEqual(["b.ts", "c.ts"]);
  });

  test("records a reference name even when it resolves to nothing", () => {
    const index = indexOf({
      "a.ts": { symbols: [{ id: "aaa", name: "alpha" }], references: [{ name: "missing" }] },
    });

    // A name that resolves to nothing today may resolve once something exports
    // it, so the file still has to be reachable for invalidation.
    expect(projectionOf(index).graph.refsByName["missing"]).toEqual(["a.ts"]);
  });

  test("hashes each file's exported surface", () => {
    const index = indexOf({
      "a.ts": { symbols: [{ id: "aaa", name: "alpha", exported: true }] },
    });

    expect(projectionOf(index).graph.exportSig["a.ts"]).toMatch(/^[0-9a-z]+$/);
  });

  test("the export signature changes when an exported signature changes", () => {
    const before = projectionOf(
      indexOf({
        "a.ts": {
          symbols: [
            { id: "aaa", name: "alpha", exported: true, signature: "function alpha()" },
          ],
        },
      }),
    );
    const after = projectionOf(
      indexOf({
        "a.ts": {
          symbols: [
            { id: "aaa", name: "alpha", exported: true, signature: "function alpha(x)" },
          ],
        },
      }),
    );

    expect(after.graph.exportSig["a.ts"]).not.toBe(before.graph.exportSig["a.ts"]);
  });

  test("the export signature changes when a symbol stops being exported", () => {
    const exported = projectionOf(
      indexOf({ "a.ts": { symbols: [{ id: "aaa", name: "alpha", exported: true }] } }),
    );
    const internal = projectionOf(
      indexOf({ "a.ts": { symbols: [{ id: "aaa", name: "alpha", exported: false }] } }),
    );

    expect(internal.graph.exportSig["a.ts"]).not.toBe(exported.graph.exportSig["a.ts"]);
  });

  test("the export signature ignores a body-only edit", () => {
    // This is the whole point: editing a body must not invalidate callers.
    const before = projectionOf(
      indexOf({
        "a.ts": {
          symbols: [
            { id: "aaa", name: "alpha", exported: true, endLine: 10, endByte: 100 },
          ],
        },
      }),
    );
    const after = projectionOf(
      indexOf({
        "a.ts": {
          symbols: [
            { id: "aaa", name: "alpha", exported: true, endLine: 40, endByte: 900 },
          ],
        },
      }),
    );

    expect(after.graph.exportSig["a.ts"]).toBe(before.graph.exportSig["a.ts"]);
  });
});

describe("serialise", () => {
  test("is byte-identical for the same projection", () => {
    const index = indexOf({
      "a.ts": {
        symbols: [
          { id: "aaa", name: "alpha", exported: true },
          { id: "bbb", name: "beta" },
        ],
        references: [{ name: "beta", fromSymbol: 0 }],
      },
    });

    expect(serialise(projectionOf(index).symbols)).toBe(
      serialise(projectionOf(index).symbols),
    );
  });

  test("orders keys independently of insertion order", () => {
    // The case that matters for incremental reindexing: a rebuilt file's
    // symbols get reinserted in a different order than a full rebuild would
    // produce. Ordinary string keys keep insertion order in JS, so without an
    // explicit sort the two runs serialise differently despite agreeing.
    const forward = indexOf({
      "a.ts": { symbols: [{ id: "aaa", name: "a" }] },
      "b.ts": { symbols: [{ id: "bbb", name: "b" }] },
    });
    const reverse = indexOf({
      "b.ts": { symbols: [{ id: "bbb", name: "b" }] },
      "a.ts": { symbols: [{ id: "aaa", name: "a" }] },
    });

    expect(serialise(projectionOf(reverse).symbols)).toBe(
      serialise(projectionOf(forward).symbols),
    );
  });
});

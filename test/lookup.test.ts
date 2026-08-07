import { afterEach, describe, expect, test } from "vitest";
import { buildIndex } from "../src/core/indexer.js";
import { lookupSymbol } from "../src/core/lookup.js";
import type { OrvixIndex } from "../src/types.js";
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

const idFor = (index: OrvixIndex, name: string) =>
  Object.values(index.files)
    .flatMap((entry) => entry.symbols)
    .find((symbol) => symbol.name === name)!.id;

describe("lookupSymbol", () => {
  test("finds a symbol by its full id", async () => {
    const index = await indexOf({ "src/a.ts": `export function greet() {}\n` });
    const id = idFor(index, "greet");

    expect(lookupSymbol(index, id)).toMatchObject({
      status: "found",
      symbol: { name: "greet" },
    });
  });

  test("finds a symbol by a short id prefix", async () => {
    const index = await indexOf({ "src/a.ts": `export function greet() {}\n` });
    const id = idFor(index, "greet");

    expect(lookupSymbol(index, id.slice(0, 4))).toMatchObject({
      status: "found",
      symbol: { name: "greet" },
    });
  });

  test("finds a symbol by name when the name is unique", async () => {
    const index = await indexOf({ "src/a.ts": `export function greet() {}\n` });

    expect(lookupSymbol(index, "greet")).toMatchObject({
      status: "found",
      symbol: { name: "greet" },
    });
  });

  test("matches a name regardless of case", async () => {
    const index = await indexOf({ "src/a.ts": `export function Greet() {}\n` });

    expect(lookupSymbol(index, "greet")).toMatchObject({ status: "found" });
  });

  test("finds a method by its qualified name", async () => {
    const index = await indexOf({
      "src/a.ts": `export class Service {\n  run() {}\n}\nexport class Other {\n  run() {}\n}\n`,
    });

    expect(lookupSymbol(index, "Service.run")).toMatchObject({
      status: "found",
      symbol: { name: "run", container: "Service" },
    });
  });

  test("reports every candidate for an ambiguous name", async () => {
    const index = await indexOf({
      "src/a.ts": `export function run() {}\n`,
      "src/b.ts": `export function run() {}\n`,
    });

    const result = lookupSymbol(index, "run");

    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.matches).toHaveLength(2);
  });

  test("reports an unknown query", async () => {
    const index = await indexOf({ "src/a.ts": `export function greet() {}\n` });

    expect(lookupSymbol(index, "nothingLikeThis")).toEqual({ status: "unknown" });
  });

  test("prefers an id match over a name that shares the prefix", async () => {
    const index = await indexOf({ "src/a.ts": `export function greet() {}\n` });
    const id = idFor(index, "greet");

    expect(lookupSymbol(index, id)).toMatchObject({
      status: "found",
      symbol: { id },
    });
  });
});

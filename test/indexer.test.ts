import { afterEach, describe, expect, test } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIndex } from "../src/core/indexer.js";
import { extractFile } from "../src/core/extract.js";
import { loadIndex } from "../src/core/store.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function project(files: Record<string, string>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  return made.root;
}

const GREET = `export function greet(name: string) {\n  return name;\n}\n`;

describe("buildIndex", () => {
  test("indexes a fresh project", async () => {
    const root = await project({ "src/a.ts": GREET, "README.md": "# x" });

    const { index, stats } = await buildIndex(root);

    expect(stats).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: 0 });
    expect(Object.keys(index.files)).toEqual(["src/a.ts"]);
    expect(index.files["src/a.ts"]?.symbols[0]).toMatchObject({
      name: "greet",
      file: "src/a.ts",
    });
  });

  test("gives every symbol an id", async () => {
    const root = await project({ "src/a.ts": GREET });

    const { index } = await buildIndex(root);

    expect(index.files["src/a.ts"]?.symbols[0]?.id).toMatch(/^[0-9a-z]{12}$/);
  });

  test("reparses nothing when no file changed", async () => {
    const root = await project({ "src/a.ts": GREET });
    await buildIndex(root);

    const { stats } = await buildIndex(root);

    expect(stats).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 1 });
  });

  test("reparses a file whose contents changed", async () => {
    const root = await project({ "src/a.ts": GREET });
    await buildIndex(root);

    await writeFile(
      join(root, "src/a.ts"),
      `export function greet(name: string) {\n  return name.trim().toUpperCase();\n}\n`,
      "utf8",
    );
    const { stats, index } = await buildIndex(root);

    expect(stats).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(index.files["src/a.ts"]?.symbols[0]?.endLine).toBe(3);
  });

  test("keeps a symbol's id stable across an edit to its body", async () => {
    const root = await project({ "src/a.ts": GREET });
    const before = (await buildIndex(root)).index.files["src/a.ts"]?.symbols[0]
      ?.id;

    await writeFile(
      join(root, "src/a.ts"),
      `export function greet(name: string) {\n  // a comment that changes the size\n  return name;\n}\n`,
      "utf8",
    );
    const after = (await buildIndex(root)).index.files["src/a.ts"]?.symbols[0]
      ?.id;

    expect(after).toBe(before);
  });

  test("picks up a newly added file", async () => {
    const root = await project({ "src/a.ts": GREET });
    await buildIndex(root);

    await writeFile(join(root, "src/b.ts"), `export const B = 1;\n`, "utf8");
    const { stats, index } = await buildIndex(root);

    expect(stats).toMatchObject({ added: 1, unchanged: 1 });
    expect(Object.keys(index.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("drops a file that was deleted", async () => {
    const root = await project({ "src/a.ts": GREET, "src/b.ts": "const b = 1;\n" });
    await buildIndex(root);

    await rm(join(root, "src/b.ts"));
    const { stats, index } = await buildIndex(root);

    expect(stats).toMatchObject({ removed: 1 });
    expect(Object.keys(index.files)).toEqual(["src/a.ts"]);
  });

  test("persists the index so a later load sees it", async () => {
    const root = await project({ "src/a.ts": GREET });

    const { index } = await buildIndex(root);

    expect(await loadIndex(root)).toEqual(index);
  });

  test("produces the same index when run twice", async () => {
    const root = await project({ "src/a.ts": GREET, "src/b.ts": "export const B = 1;\n" });

    const first = (await buildIndex(root)).index;
    const second = (await buildIndex(root)).index;

    expect(second).toEqual(first);
  });

  test("skips a file that cannot be extracted, without aborting the run", async () => {
    // A grammar that fails to load, a query file that is missing, a language
    // registered before its query exists: any of these must cost one file,
    // never the whole index run.
    const root = await project({ "src/good.ts": GREET, "src/bad.ts": GREET });

    const { index, stats, skippedFiles } = await buildIndex(root, {
      extract: async (source, language, path) => {
        if (path === "src/bad.ts") throw new Error("grammar unavailable");
        return extractFile(source, language);
      },
    });

    expect(Object.keys(index.files)).toEqual(["src/good.ts"]);
    expect(stats.skipped).toBe(1);
    expect(skippedFiles).toEqual(["src/bad.ts"]);
  });

  test("gives distinct ids to two symbols with the same identity", async () => {
    // A getter and a setter share file, name and kind. They are still two
    // symbols, and `orvix show` must be able to tell them apart.
    const root = await project({
      "src/a.ts": `export class A {\n  get value() { return 1; }\n  set value(v: number) {}\n}\n`,
    });

    const { index } = await buildIndex(root);
    const ids = index.files["src/a.ts"]!.symbols.map((s) => s.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keeps the first occurrence's id stable when a duplicate appears", async () => {
    const root = await project({
      "src/a.ts": `export class A {\n  get value() { return 1; }\n}\n`,
    });
    const before = (await buildIndex(root)).index.files["src/a.ts"]!.symbols.find(
      (s) => s.name === "value",
    )!.id;

    await writeFile(
      join(root, "src/a.ts"),
      `export class A {\n  get value() { return 1; }\n  set value(v: number) {}\n}\n`,
      "utf8",
    );
    const after = (await buildIndex(root)).index.files["src/a.ts"]!.symbols.find(
      (s) => s.name === "value",
    )!.id;

    expect(after).toBe(before);
  });

  test("refuses a project larger than the file cap instead of exhausting memory", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) files[`src/f${i}.ts`] = GREET;
    const root = await project(files);

    await expect(buildIndex(root, { maxFiles: 5 })).rejects.toThrow(
      /\.orvixignore/,
    );
  });

  test("refuses a project whose total source size would exhaust memory", async () => {
    // File count is a poor proxy for cost: a few hundred large generated files
    // exhaust memory long before tens of thousands of ordinary ones.
    const big = `export function f() {\n  return "${"x".repeat(4000)}";\n}\n`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) files[`src/f${i}.ts`] = big;
    const root = await project(files);

    await expect(buildIndex(root, { maxBytes: 10_000 })).rejects.toThrow(
      /\.orvixignore/,
    );
  });

  test("never indexes its own cache directory", async () => {
    const root = await project({ "src/a.ts": GREET });
    await buildIndex(root);

    const { index } = await buildIndex(root);

    expect(
      Object.keys(index.files).some((path) => path.startsWith(".orvix/")),
    ).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  INDEX_VERSION,
  emptyIndex,
  indexPath,
  loadIndex,
  saveIndex,
} from "../src/core/store.js";
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

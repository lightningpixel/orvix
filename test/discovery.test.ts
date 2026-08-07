import { afterEach, describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discover } from "../src/core/discovery.js";
import { makeProject } from "./helpers/tmpProject.js";

const TS = { extensions: [".ts"] };

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

describe("discover", () => {
  test("returns only files whose extension is requested", async () => {
    const root = await project({
      "src/a.ts": "export const a = 1;",
      "README.md": "# hi",
      "logo.png": "\x89PNG",
    });

    expect(await discover(root, TS)).toEqual(["src/a.ts"]);
  });

  test("returns posix-style relative paths sorted alphabetically", async () => {
    const root = await project({
      "src/z.ts": "",
      "src/nested/deep/a.ts": "",
      "b.ts": "",
    });

    expect(await discover(root, TS)).toEqual([
      "b.ts",
      "src/nested/deep/a.ts",
      "src/z.ts",
    ]);
  });

  test("honours the root .gitignore", async () => {
    const root = await project({
      ".gitignore": "generated/\n*.gen.ts\n",
      "src/keep.ts": "",
      "src/thing.gen.ts": "",
      "generated/out.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["src/keep.ts"]);
  });

  test("honours a nested .gitignore relative to its own directory", async () => {
    const root = await project({
      "src/keep.ts": "",
      "src/inner/.gitignore": "skip.ts\n",
      "src/inner/skip.ts": "",
      "src/inner/use.ts": "",
      "skip.ts": "",
    });

    // "skip.ts" at the root is untouched: the nested rule is scoped to src/inner.
    expect(await discover(root, TS)).toEqual([
      "skip.ts",
      "src/inner/use.ts",
      "src/keep.ts",
    ]);
  });

  test("honours .orvixignore in addition to .gitignore", async () => {
    const root = await project({
      ".gitignore": "a.ts\n",
      ".orvixignore": "b.ts\n",
      "a.ts": "",
      "b.ts": "",
      "c.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["c.ts"]);
  });

  test("negation patterns re-include a previously ignored file", async () => {
    const root = await project({
      ".gitignore": "*.ts\n!keep.ts\n",
      "keep.ts": "",
      "drop.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["keep.ts"]);
  });

  test("always skips node_modules, .git and .orvix even when not ignored", async () => {
    const root = await project({
      "src/a.ts": "",
      "node_modules/pkg/index.ts": "",
      ".git/hooks/x.ts": "",
      ".orvix/cache.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["src/a.ts"]);
  });

  test("skips generated and vendored directories by default", async () => {
    // Projects without a .gitignore are common, and walking a virtualenv or a
    // bundler's output directory is both useless and ruinously expensive.
    const root = await project({
      "src/keep.ts": "",
      "venv/lib/x.ts": "",
      ".venv/lib/y.ts": "",
      "__pycache__/z.ts": "",
      "dist/out.ts": "",
      "build/out.ts": "",
      "target/out.ts": "",
      "vendor/dep.ts": "",
      ".next/page.ts": "",
      "coverage/report.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["src/keep.ts"]);
  });

  test("skips installed dependencies wherever they sit", async () => {
    // A virtualenv is not reliably named: `venv`, `.venv`, `build-env`, `env`.
    // What is reliable is site-packages, so that is what is matched.
    const root = await project({
      "src/keep.ts": "",
      "tools/build-env/Lib/site-packages/torch/x.ts": "",
      "deps/lib/python3.12/site-packages/numpy/y.ts": "",
      "web/bower_components/z.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["src/keep.ts"]);
  });

  test("lets .orvixignore re-include a directory ignored by default", async () => {
    const root = await project({
      ".orvixignore": "!dist/\n",
      "src/keep.ts": "",
      "dist/out.ts": "",
    });

    expect(await discover(root, TS)).toEqual(["dist/out.ts", "src/keep.ts"]);
  });

  test("skips files larger than maxFileSize", async () => {
    const root = await project({ "small.ts": "x", "big.ts": "" });
    await writeFile(join(root, "big.ts"), "y".repeat(5000), "utf8");

    const found = await discover(root, { extensions: [".ts"], maxFileSize: 1000 });

    expect(found).toEqual(["small.ts"]);
  });

  test("matches extensions case-insensitively", async () => {
    const root = await project({ "A.TS": "", "b.ts": "" });

    expect(await discover(root, TS)).toEqual(["A.TS", "b.ts"]);
  });
});

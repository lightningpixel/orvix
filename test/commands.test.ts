import { afterEach, describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runIndex } from "../src/commands/indexCommand.js";
import { runMap } from "../src/commands/map.js";
import {
  runCalls,
  runFind,
  runShow,
  runWhoCalls,
} from "../src/commands/lookupCommands.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const PROJECT = {
  "src/auth.ts":
    `export function validate(email: string): boolean {\n  return email.includes("@");\n}\n`,
  "src/login.ts":
    `import { validate } from "./auth";\n` +
    `export function login(email: string) {\n  return validate(email);\n}\n`,
  "src/boot.ts":
    `import { login } from "./login";\nexport function boot() {\n  login("a@b.c");\n}\n`,
};

async function project(files: Record<string, string> = PROJECT) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  return made.root;
}

/**
 * A project that has already been indexed.
 *
 * Read commands answer from the cache and never parse, so building the index
 * is now part of setting a project up rather than something a query does on
 * the caller's behalf.
 */
async function indexed(files: Record<string, string> = PROJECT) {
  const root = await project(files);
  await runIndex(root);
  return root;
}

describe("orvix index", () => {
  test("reports what it indexed", async () => {
    const { output, ok } = await runIndex(await project());

    expect(ok).toBe(true);
    expect(output).toContain("3 files");
    expect(output).toMatch(/\d+ symbols/);
  });

  test("emits parseable json", async () => {
    const { output } = await runIndex(await project(), { json: true });

    expect(JSON.parse(output)).toMatchObject({ files: 3, added: 3 });
  });
});

describe("orvix map", () => {
  test("lists files and symbols", async () => {
    const { output, ok } = await runMap(await indexed());

    expect(ok).toBe(true);
    expect(output).toContain("src/auth.ts");
    expect(output).toContain("function validate");
  });

  test("honours the budget flag", async () => {
    const root = await indexed();

    const wide = await runMap(root, { budget: 2000 });
    const narrow = await runMap(root, { budget: 30 });

    expect(narrow.output.length).toBeLessThan(wide.output.length);
  });

  test("rejects a budget that is not a positive number", async () => {
    const { ok, output } = await runMap(await indexed(), { budget: "banana" });

    expect(ok).toBe(false);
    expect(output).toContain("--budget");
  });

  test("emits parseable json carrying ids and ranks", async () => {
    const { output } = await runMap(await indexed(), { json: true });
    const symbols = JSON.parse(output);

    expect(symbols[0]).toHaveProperty("id");
    expect(symbols[0]).toHaveProperty("rank");
  });
});

describe("orvix show", () => {
  test("prints only the requested symbol's source", async () => {
    const { output, ok } = await runShow(await indexed(), "validate");

    expect(ok).toBe(true);
    expect(output).toContain('return email.includes("@")');
    expect(output).not.toContain("function login");
  });

  test("works from a short id taken out of the map", async () => {
    const root = await indexed();
    const map = await runMap(root);
    const id = /^\s+([0-9a-z]{4}) /m.exec(map.output)?.[1];

    const { ok, output } = await runShow(root, id!);

    expect(ok).toBe(true);
    expect(output).toContain("[");
  });

  test("suggests find when nothing matches", async () => {
    const { ok, output } = await runShow(await indexed(), "nonexistent");

    expect(ok).toBe(false);
    expect(output).toContain("orvix find");
  });

  test("lists the candidates when a name is ambiguous", async () => {
    const root = await indexed({
      "src/a.ts": `export function run() {}\n`,
      "src/b.ts": `export function run() {}\n`,
    });

    const { ok, output } = await runShow(root, "run");

    expect(ok).toBe(false);
    expect(output).toContain("matches 2 symbols");
    expect(output).toContain("src/a.ts");
    expect(output).toContain("src/b.ts");
  });
});

describe("orvix who-calls and calls", () => {
  test("who-calls names the caller", async () => {
    const { output, ok } = await runWhoCalls(await indexed(), "validate");

    expect(ok).toBe(true);
    expect(output).toContain("login");
  });

  test("calls names the callee", async () => {
    const { output } = await runCalls(await indexed(), "login");

    expect(output).toContain("validate");
  });

  test("says none when a symbol has no callers", async () => {
    const { output } = await runWhoCalls(await indexed(), "boot");

    expect(output).toBe("none");
  });
});

describe("orvix find", () => {
  test("matches on a name substring", async () => {
    const { output, ok } = await runFind(await indexed(), "valid");

    expect(ok).toBe(true);
    expect(output).toContain("validate");
  });

  test("puts an exact name match first", async () => {
    const root = await indexed({
      "src/a.ts": `export function run() {}\nexport function runFast() {}\nexport function prerun() {}\n`,
    });

    const { output } = await runFind(root, "run");

    expect(output.split("\n")[0]).toContain("function run()");
  });

  test("matches on the signature when the name does not", async () => {
    const { output } = await runFind(await indexed(), "boolean");

    expect(output).toContain("validate");
  });

  test("reports nothing found without failing", async () => {
    const { output, ok } = await runFind(await indexed(), "zzzz");

    expect(ok).toBe(true);
    expect(output).toBe("none");
  });
});

describe("the query path reads the cache", () => {
  test("does not notice a new file until the project is reindexed", async () => {
    // The query path deliberately never stats or parses: that is what keeps a
    // lookup cheap enough to sit behind a hook. Freshness is the indexer's
    // job, driven by the dirty log the edit hook writes.
    const root = await project();
    await runIndex(root);

    await writeFile(join(root, "src/late.ts"), `export function late() {}\n`, "utf8");
    const stale = await runMap(root);

    await runIndex(root);
    const fresh = await runMap(root);

    expect(stale.output).not.toContain("late");
    expect(fresh.output).toContain("late");
  });
});

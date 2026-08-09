import { afterEach, describe, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../src/commands/init.js";
import { loadConfig, saveConfig } from "../src/core/config.js";
import { makeProject } from "./helpers/tmpProject.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scratch(files: Record<string, string> = { ".keep": "" }) {
  const made = await makeProject(files);
  cleanups.push(made.cleanup);
  return made.root;
}

const SOURCE = { "src/a.ts": "export function greet() {}\n" };

const read = (root: string, file: string) =>
  readFile(join(root, file), "utf8");

describe("orvix init — instruction files", () => {
  test("writes the block into the file the chosen agent reads", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    const { ok } = await runInit(root, { agent: ["claude"], home });

    expect(ok).toBe(true);
    expect(await read(root, "CLAUDE.md")).toContain("orvix map");
  });

  test("appends to an instruction file that already exists", async () => {
    const root = await scratch({ ...SOURCE, "CLAUDE.md": "# House rules\n\nBe brief.\n" });
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });

    const contents = await read(root, "CLAUDE.md");
    expect(contents).toContain("Be brief.");
    expect(contents).toContain("orvix map");
  });

  test("leaves the file byte-identical when run twice", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });
    const first = await read(root, "CLAUDE.md");
    await runInit(root, { agent: ["claude"], home });

    expect(await read(root, "CLAUDE.md")).toBe(first);
  });

  test("writes AGENTS.md once for two agents that share it", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    const { output } = await runInit(root, { agent: ["codex", "cursor"], home });

    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(output.match(/AGENTS\.md/g)).toHaveLength(1);
  });

  test("writes one file per agent when they differ", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude", "gemini"], home });

    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(root, "GEMINI.md"))).toBe(true);
  });
});

describe("orvix init — gitignore", () => {
  test("adds the cache directory to an existing .gitignore", async () => {
    const root = await scratch({ ...SOURCE, ".gitignore": "node_modules/\n" });
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });

    const contents = await read(root, ".gitignore");
    expect(contents).toContain("node_modules/");
    expect(contents).toContain(".orvix/");
  });

  test("creates .gitignore when the project has none", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });

    expect(await read(root, ".gitignore")).toContain(".orvix/");
  });

  test("does not add the entry twice", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });
    await runInit(root, { agent: ["claude"], home });

    const lines = (await read(root, ".gitignore")).split("\n");
    expect(lines.filter((line) => line.trim() === ".orvix/")).toHaveLength(1);
  });

  test("leaves an already-ignored cache alone", async () => {
    const root = await scratch({ ...SOURCE, ".gitignore": ".orvix/\n" });
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });

    expect(await read(root, ".gitignore")).toBe(".orvix/\n");
  });
});

describe("orvix init — remembering the choice", () => {
  test("saves the chosen agents globally", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["gemini"], home });

    expect(await loadConfig(home)).toEqual({ agents: ["gemini"] });
  });

  test("reuses the saved choice without asking again", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();
    await saveConfig({ agents: ["gemini"] }, home);
    let asked = false;

    await runInit(root, {
      home,
      prompt: async () => {
        asked = true;
        return ["claude"];
      },
    });

    expect(asked).toBe(false);
    expect(existsSync(join(root, "GEMINI.md"))).toBe(true);
  });

  // Silently acting on a choice made in another repository months ago reads as
  // the tool guessing. Saying where it came from also says how to change it.
  test("says when it is reusing a saved choice, and from where", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();
    await saveConfig({ agents: ["gemini"] }, home);

    const { output } = await runInit(root, { home });

    expect(output).toContain("gemini");
    expect(output).toMatch(/saved choice|config\.json/);
  });

  test("asks when nothing has been saved yet", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { home, prompt: async () => ["claude"] });

    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(await loadConfig(home)).toEqual({ agents: ["claude"] });
  });

  test("an explicit --agent overrides the saved choice", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();
    await saveConfig({ agents: ["gemini"] }, home);

    await runInit(root, { agent: ["claude"], home });

    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(await loadConfig(home)).toEqual({ agents: ["claude"] });
  });

  test("falls back to AGENTS.md when it cannot ask", async () => {
    // No saved choice, no prompt available: a non-interactive run must still
    // produce something useful rather than fail or hang.
    const root = await scratch(SOURCE);
    const home = await scratch();

    const { ok, output } = await runInit(root, { home });

    expect(ok).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(output).toMatch(/AGENTS\.md/);
  });

  test("rejects an unknown agent name instead of silently doing nothing", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    const { ok, output } = await runInit(root, { agent: ["emacs"], home });

    expect(ok).toBe(false);
    expect(output).toContain("emacs");
  });
});

describe("orvix init — hooks", () => {
  test("installs the hook scripts for Claude Code", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });

    expect(existsSync(join(root, ".claude", "hooks", "orvix-dirty.mjs"))).toBe(true);
    expect(existsSync(join(root, ".claude", "hooks", "orvix-compress.mjs"))).toBe(true);
    expect(existsSync(join(root, ".claude", "hooks", "orvix-reconcile.mjs"))).toBe(true);
  });

  test("registers them in settings.json", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });
    const settings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    );

    expect(Object.keys(settings.hooks)).toContain("PostToolUse");
    expect(Object.keys(settings.hooks)).toContain("Stop");
  });

  test("records where orvix lives so the hooks can find it again", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });
    const runtime = JSON.parse(
      await readFile(join(root, ".orvix", "runtime.json"), "utf8"),
    );

    expect(runtime.main).toContain("main.js");
  });

  test("leaves settings.json byte-identical when run twice", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["claude"], home });
    const first = await readFile(join(root, ".claude", "settings.json"), "utf8");
    await runInit(root, { agent: ["claude"], home });

    expect(await readFile(join(root, ".claude", "settings.json"), "utf8")).toBe(first);
  });

  test("does not install hooks for an agent that cannot run them", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    await runInit(root, { agent: ["codex"], home });

    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("refuses to rewrite a settings file that is not valid JSON", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), "{ broken", "utf8");

    const { output } = await runInit(root, { agent: ["claude"], home });

    expect(output).toContain("not valid JSON");
    expect(await readFile(join(root, ".claude", "settings.json"), "utf8")).toBe(
      "{ broken",
    );
  });
});

describe("orvix init — indexing", () => {
  test("builds the index so the first query is instant", async () => {
    const root = await scratch(SOURCE);
    const home = await scratch();

    const { output } = await runInit(root, { agent: ["claude"], home });

    // The two hot files are what a query actually reads, so those are what
    // make the first query instant — the raw facts are only for reindexing.
    expect(existsSync(join(root, ".orvix", "symbols.json"))).toBe(true);
    expect(existsSync(join(root, ".orvix", "graph.json"))).toBe(true);
    expect(existsSync(join(root, ".orvix", "facts.json"))).toBe(true);
    expect(output).toMatch(/\d+ symbols/);
  });
});

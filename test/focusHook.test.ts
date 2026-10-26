import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { orvixHooks } from "../src/agents/claudeHooks.js";
import { buildIndex } from "../src/core/indexer.js";
import { makeProject } from "./helpers/tmpProject.js";

const HOOK = resolve("hooks", "orvix-focus.mjs");
const QUERY = resolve("dist", "query.js");
const built = existsSync(QUERY);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function runHook(payload: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(process.execPath, [HOOK], (error, stdout) =>
      error ? fail(error) : done(stdout),
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

/** An indexed project whose runtime.json points at this checkout's bundle. */
async function project(config?: Record<string, unknown>) {
  const made = await makeProject({
    "src/parser.ts": `export function parseSource(text: string) {\n  return text;\n}\n`,
    "src/extract.ts":
      `import { parseSource } from "./parser";\n` +
      `function extractFile(text: string) {\n  return parseSource(text);\n}\n`,
    "src/run.ts": `export function run() {}\nexport function map() {}\n`,
  });
  cleanup = made.cleanup;
  await buildIndex(made.root);

  await mkdir(join(made.root, ".orvix"), { recursive: true });
  await writeFile(
    join(made.root, ".orvix", "runtime.json"),
    JSON.stringify({ query: QUERY }),
  );
  if (config) {
    await writeFile(join(made.root, ".orvix", "config.json"), JSON.stringify(config));
  }
  return made.root;
}

async function contextFor(root: string, prompt: string) {
  const out = await runHook({
    cwd: root,
    session_id: "s1",
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
  if (out.trim() === "") return undefined;
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return parsed.hookSpecificOutput.additionalContext as string;
}

describe.skipIf(!built)("orvix-focus", () => {
  test("adds a map centred on a symbol the prompt names", async () => {
    const context = await contextFor(await project(), "Make parseSource accept a Buffer");

    expect(context).toContain("parseSource");
    // The private caller is the neighbourhood the task needs.
    expect(context).toContain("extractFile");
  });

  test("recognises a name in backticks even when it is a plain word", async () => {
    const context = await contextFor(await project(), "Why does `run` exist?");

    expect(context).toContain("function run");
  });

  test("ignores plain English words that happen to name a symbol", async () => {
    // "run" and "map" are symbols here. Prose is not a request to focus.
    expect(await contextFor(await project(), "Can you run the map again?")).toBeUndefined();
  });

  test("recognises a file path", async () => {
    const context = await contextFor(await project(), "Refactor src/parser.ts please");

    expect(context).toContain("extractFile");
  });

  test("says nothing when the prompt names no symbol", async () => {
    expect(await contextFor(await project(), "Fix the flaky CI job")).toBeUndefined();
  });

  test("can be turned off from .orvix/config.json", async () => {
    const root = await project({ focusPrompt: false });

    expect(await contextFor(root, "Make parseSource accept a Buffer")).toBeUndefined();
  });

  test("stays silent without an index", async () => {
    const made = await makeProject({ "a.ts": "export function parseSource() {}\n" });
    cleanup = made.cleanup;

    expect(await contextFor(made.root, "Make parseSource faster")).toBeUndefined();
  });

  test("survives a malformed payload", async () => {
    await expect(runHook({ nonsense: true })).resolves.toBe("");
  });
});

describe("orvix-focus registration", () => {
  test("runs when a prompt is submitted, synchronously", () => {
    // Its output has to reach the model with the prompt, so it cannot be async.
    const entry = orvixHooks()["UserPromptSubmit"]?.[0];

    expect(entry?.hooks[0]?.command).toContain("orvix-focus.mjs");
    expect(entry?.hooks[0]?.async).toBeUndefined();
  });
});

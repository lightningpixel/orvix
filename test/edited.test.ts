import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { orvixHooks } from "../src/agents/claudeHooks.js";
import { supportedExtensions } from "../src/core/languages.js";
import { runEdited } from "../src/commands/edited.js";
import { runIndex } from "../src/commands/indexCommand.js";
import { runWhoCalls } from "../src/commands/lookupCommands.js";
import { makeProject } from "./helpers/tmpProject.js";

const HOOK = resolve("hooks", "orvix-impact.mjs");
const QUERY = resolve("dist", "query.js");
const built = existsSync(QUERY);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const PROJECT = {
  "src/auth.ts": `export function validate(email: string): boolean {\n  return email.includes("@");\n}\nexport function lonely(a: number) {\n  return a;\n}\n`,
  "src/login.ts":
    `import { validate } from "./auth";\n` +
    `export function login(email: string) {\n  return validate(email);\n}\n`,
};

async function indexed() {
  const made = await makeProject(PROJECT);
  cleanup = made.cleanup;
  await runIndex(made.root);
  return made.root;
}

async function rewrite(root: string, path: string, source: string) {
  await writeFile(join(root, path), source, "utf8");
  await new Promise((done) => setTimeout(done, 12));
}

const AUTH_TAIL = `export function lonely(a: number) {\n  return a;\n}\n`;

describe("orvix-query edited", () => {
  test("names the callers of a symbol whose signature changed", async () => {
    const root = await indexed();
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string, strict: boolean): boolean {\n  return strict && email.includes("@");\n}\n` + AUTH_TAIL,
    );

    const { output, ok } = await runEdited(root, "src/auth.ts");

    expect(ok).toBe(true);
    expect(output).toContain("validate");
    expect(output).toContain("validate(email: string): boolean");
    expect(output).toContain("validate(email: string, strict: boolean): boolean");
    expect(output).toContain("src/login.ts");
  });

  test("says nothing about a body-only edit", async () => {
    const root = await indexed();
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string): boolean {\n  return email.length > 3;\n}\n` + AUTH_TAIL,
    );

    expect((await runEdited(root, "src/auth.ts")).output).toBe("");
  });

  test("names the callers left behind by a rename", async () => {
    const root = await indexed();
    await rewrite(
      root,
      "src/auth.ts",
      `export function isValid(email: string): boolean {\n  return email.includes("@");\n}\n` + AUTH_TAIL,
    );

    const { output } = await runEdited(root, "src/auth.ts");

    expect(output).toContain("validate");
    expect(output).toMatch(/no longer exists/);
    expect(output).toContain("login");
  });

  test("says nothing when the changed symbol has no callers", async () => {
    const root = await indexed();
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string): boolean {\n  return email.includes("@");\n}\nexport function lonely(a: number, b: number) {\n  return a + b;\n}\n`,
    );

    expect((await runEdited(root, "src/auth.ts")).output).toBe("");
  });

  test("leaves the index caught up, so the next query sees the edit", async () => {
    const root = await indexed();
    await rewrite(
      root,
      "src/login.ts",
      `export function login(email: string) {\n  return email;\n}\n`,
    );

    await runEdited(root, "src/login.ts");

    expect((await runWhoCalls(root, "validate")).output).toBe("none");
  });

  test("accepts an absolute path", async () => {
    const root = await indexed();
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string, strict: boolean): boolean {\n  return strict;\n}\n` + AUTH_TAIL,
    );

    expect((await runEdited(root, join(root, "src/auth.ts"))).output).toContain("src/login.ts");
  });
});

function runHook(payload: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(process.execPath, [HOOK], (error, stdout) =>
      error ? fail(error) : done(stdout),
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

async function withRuntime(root: string, config?: Record<string, unknown>) {
  await mkdir(join(root, ".orvix"), { recursive: true });
  await writeFile(join(root, ".orvix", "runtime.json"), JSON.stringify({ query: QUERY }));
  if (config) await writeFile(join(root, ".orvix", "config.json"), JSON.stringify(config));
}

describe.skipIf(!built)("orvix-impact hook", () => {
  const edit = (root: string) => ({
    cwd: root,
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src/auth.ts") },
    tool_response: { filePath: join(root, "src/auth.ts") },
  });

  test("tells the model which callers a signature change affects", async () => {
    const root = await indexed();
    await withRuntime(root);
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string, strict: boolean): boolean {\n  return strict;\n}\n` + AUTH_TAIL,
    );

    const out = JSON.parse(await runHook(edit(root)));

    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("src/login.ts");
    // Context is added; the tool's own result is left exactly as it was.
    expect(out.hookSpecificOutput.updatedToolOutput).toBeUndefined();
  });

  test("stays silent after a body-only edit", async () => {
    const root = await indexed();
    await withRuntime(root);
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string): boolean {\n  return false;\n}\n` + AUTH_TAIL,
    );

    expect(await runHook(edit(root))).toBe("");
  });

  test("can be turned off from .orvix/config.json", async () => {
    const root = await indexed();
    await withRuntime(root, { editImpact: false });
    await rewrite(
      root,
      "src/auth.ts",
      `export function validate(email: string, strict: boolean): boolean {\n  return strict;\n}\n` + AUTH_TAIL,
    );

    expect(await runHook(edit(root))).toBe("");
  });

  test("ignores a file orvix does not index", async () => {
    const root = await indexed();
    await withRuntime(root);

    expect(
      await runHook({ ...edit(root), tool_input: { file_path: join(root, "README.md") } }),
    ).toBe("");
  });

  test("survives a malformed payload", async () => {
    await expect(runHook({ nonsense: true })).resolves.toBe("");
  });
});

describe("orvix-impact registration", () => {
  test("knows every extension the language registry does", () => {
    // The hook may import nothing but node:*, so it carries its own copy.
    const source = readFileSync(HOOK, "utf8");
    const list = /const INDEXED = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    const extensions = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    expect(extensions.sort()).toEqual([...supportedExtensions()].sort());
  });

  test("runs synchronously after every edit", () => {
    // Async would deliver the warning after the model has moved on.
    const entry = orvixHooks()["PostToolUse"]!.find((e) =>
      e.hooks.some((h) => h.command.includes("orvix-impact.mjs")),
    );

    expect(entry?.matcher).toBe("Edit|Write|MultiEdit");
    expect(entry?.hooks[0]?.async).toBeUndefined();
  });
});

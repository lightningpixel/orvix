import { afterEach, describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runIndex } from "../src/commands/indexCommand.js";
import { runShow } from "../src/commands/lookupCommands.js";
import { runReplace } from "../src/commands/replace.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const AUTH =
  `export function validate(email: string): boolean {\n  return email.includes("@");\n}\n\n` +
  `export function normalise(email: string): string {\n  return email.trim();\n}\n`;

const PROJECT = {
  "src/auth.ts": AUTH,
  "src/login.ts":
    `import { validate } from "./auth";\nexport function login(email: string) {\n  return validate(email);\n}\n`,
};

async function indexed() {
  const made = await makeProject(PROJECT);
  cleanup = made.cleanup;
  await runIndex(made.root);
  return made.root;
}

const NEW_BODY = `export function validate(email: string): boolean {\n  return email.length > 3 && email.includes("@");\n}`;

describe("orvix replace", () => {
  test("only describes the change without --write", async () => {
    const root = await indexed();

    const { output, ok } = await runReplace(root, "validate", { source: NEW_BODY });

    expect(ok).toBe(true);
    expect(output).toContain("would replace");
    expect(output).toContain("--write");
    expect(await readFile(join(root, "src/auth.ts"), "utf8")).toBe(AUTH);
  });

  test("replaces exactly the symbol's source with --write", async () => {
    const root = await indexed();

    const { ok } = await runReplace(root, "validate", { source: NEW_BODY, write: true });
    const after = await readFile(join(root, "src/auth.ts"), "utf8");

    expect(ok).toBe(true);
    expect(after).toContain("email.length > 3");
    expect(after).toContain(`export function normalise(email: string): string {\n  return email.trim();\n}\n`);
    expect(after.startsWith(NEW_BODY)).toBe(true);
  });

  test("accepts the text exactly as show prints it, without the export keyword", async () => {
    // show starts at the declaration, after `export`; both spellings must land
    // in the same place without doubling the keyword.
    const root = await indexed();

    await runReplace(root, "validate", { source: NEW_BODY.replace(/^export /, ""), write: true });

    expect((await readFile(join(root, "src/auth.ts"), "utf8")).startsWith(NEW_BODY)).toBe(true);
  });

  test("leaves the index caught up", async () => {
    const root = await indexed();

    await runReplace(root, "validate", { source: NEW_BODY, write: true });

    expect((await runShow(root, "validate")).output).toContain("email.length > 3");
  });

  test("finds the symbol in the file as it is now, not as indexed", async () => {
    // Lines added above the symbol after indexing shift every offset the
    // index holds; writing at those offsets would cut into the wrong code.
    const root = await indexed();
    await writeFile(join(root, "src/auth.ts"), `// header\n// more header\n${AUTH}`, "utf8");

    await runReplace(root, "normalise", {
      source: `export function normalise(email: string): string {\n  return email.toLowerCase();\n}`,
      write: true,
    });
    const after = await readFile(join(root, "src/auth.ts"), "utf8");

    expect(after.startsWith(`// header\n// more header\nexport function validate`)).toBe(true);
    expect(after).toContain("email.toLowerCase()");
    expect(after).not.toContain("email.trim()");
  });

  test("refuses a replacement that does not parse", async () => {
    const root = await indexed();

    const { ok, output } = await runReplace(root, "validate", {
      source: `export function validate(email: string {\n  return (;\n}`,
      write: true,
    });

    expect(ok).toBe(false);
    expect(output).toMatch(/parse/);
    expect(await readFile(join(root, "src/auth.ts"), "utf8")).toBe(AUTH);
  });

  test("names the callers a new signature leaves behind", async () => {
    const root = await indexed();

    const { output } = await runReplace(root, "validate", {
      source: `export function validate(email: string, strict: boolean): boolean {\n  return strict;\n}`,
      write: true,
    });

    expect(output).toContain("src/login.ts");
  });

  test("says when the replacement renames the symbol, since its id changes", async () => {
    const root = await indexed();

    const { output } = await runReplace(root, "validate", {
      source: `export function isValid(email: string): boolean {\n  return true;\n}`,
    });

    expect(output).toMatch(/renames/);
  });

  test("explains an unknown symbol", async () => {
    const { ok, output } = await runReplace(await indexed(), "nope", { source: "x" });

    expect(ok).toBe(false);
    expect(output).toContain("orvix find");
  });

  test("refuses an empty replacement", async () => {
    const { ok } = await runReplace(await indexed(), "validate", { source: "  \n" });

    expect(ok).toBe(false);
  });
});

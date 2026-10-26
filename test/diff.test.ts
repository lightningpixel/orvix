import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runDiff } from "../src/commands/diff.js";
import { runIndex } from "../src/commands/indexCommand.js";
import { makeProject } from "./helpers/tmpProject.js";

const git = promisify(execFile);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const AUTH =
  `export function validate(email: string): boolean {\n  return email.includes("@");\n}\n` +
  `export function normalise(email: string): string {\n  return email.trim();\n}\n` +
  `export function legacy() {\n  return 1;\n}\n`;

const PROJECT = {
  "src/auth.ts": AUTH,
  "src/login.ts":
    `import { validate, legacy } from "./auth";\n` +
    `export function login(email: string) {\n  legacy();\n  return validate(email);\n}\n`,
  "src/gone.ts": `export function gone() {}\n`,
  "README.md": "# not code\n",
};

/** A committed repository, then edited in the working tree. */
async function repository(): Promise<string> {
  const made = await makeProject(PROJECT);
  cleanup = made.cleanup;
  const root = made.root;

  await git("git", ["-C", root, "init", "-q"]);
  await git("git", ["-C", root, "add", "."]);
  await git("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"]);

  await writeFile(
    join(root, "src/auth.ts"),
    `export function validate(email: string, strict: boolean): boolean {\n  return strict && email.includes("@");\n}\n` +
      `export function normalise(email: string): string {\n  return email.trim().toLowerCase();\n}\n` +
      `export function fresh() {}\n`,
  );
  await rm(join(root, "src/gone.ts"));
  await writeFile(join(root, "src/new.ts"), `export function added() {}\n`);
  await writeFile(join(root, "README.md"), "# still not code\n");

  await runIndex(root);
  return root;
}

describe("orvix diff", () => {
  test("classifies each changed symbol", async () => {
    const { output, ok } = await runDiff(await repository());

    expect(ok).toBe(true);
    expect(output).toMatch(/~ .*validate/);
    expect(output).toMatch(/· .*normalise/);
    expect(output).toMatch(/- .*legacy/);
    expect(output).toMatch(/\+ .*fresh/);
  });

  test("shows the signature before and after", async () => {
    const { output } = await runDiff(await repository());

    expect(output).toContain("validate(email: string): boolean");
    expect(output).toContain("validate(email: string, strict: boolean): boolean");
  });

  test("names the callers of a changed signature", async () => {
    const { output } = await runDiff(await repository());
    const validate = output.split("\n").findIndex((line) => /~ .*validate/.test(line));

    expect(output.split("\n").slice(validate, validate + 4).join("\n")).toContain("login");
  });

  test("names the files still referring to a removed symbol", async () => {
    const { output } = await runDiff(await repository());
    const legacy = output.split("\n").findIndex((line) => /- .*legacy/.test(line));

    expect(output.split("\n").slice(legacy, legacy + 3).join("\n")).toContain("src/login.ts");
  });

  test("covers deleted and untracked files", async () => {
    const { output } = await runDiff(await repository());

    expect(output).toContain("src/gone.ts");
    expect(output).toContain("src/new.ts");
  });

  test("leaves out files orvix does not index", async () => {
    const { output } = await runDiff(await repository());

    expect(output).not.toContain("README.md");
  });

  test("summarises the counts on the first line", async () => {
    const { output } = await runDiff(await repository());

    expect(output.split("\n")[0]).toBe(
      "3 files changed since HEAD: 2 added, 2 removed, 1 signature changed, 1 body changed",
    );
  });

  test("compares against any ref", async () => {
    const root = await repository();
    await git("git", ["-C", root, "add", "."]);
    await git("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "next"]);

    const { output } = await runDiff(root, { ref: "HEAD~1" });

    expect(output).toMatch(/~ .*validate/);
    expect((await runDiff(root)).output).toBe("no symbol changed since HEAD");
  });

  test("emits parseable json", async () => {
    const { output } = await runDiff(await repository(), { json: true });
    const parsed = JSON.parse(output);
    const auth = parsed.files.find((file: { file: string }) => file.file === "src/auth.ts");

    expect(parsed.ref).toBe("HEAD");
    expect(auth.signature[0].before.name).toBe("validate");
    expect(auth.signature[0].callers.map((c: { name: string }) => c.name)).toEqual(["login"]);
  });

  test("explains an unknown ref", async () => {
    const { output, ok } = await runDiff(await repository(), { ref: "no-such-branch" });

    expect(ok).toBe(false);
    expect(output).toContain("no-such-branch");
  });

  test("explains a directory that is not a git repository", async () => {
    const made = await makeProject({ "src/a.ts": "export function a() {}\n" });
    cleanup = made.cleanup;

    const { output, ok } = await runDiff(made.root);

    expect(ok).toBe(false);
    expect(output).toMatch(/git/);
  });
});

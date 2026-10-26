import { afterEach, describe, expect, test } from "vitest";
import { runIndex } from "../src/commands/indexCommand.js";
import { runImpact } from "../src/commands/impact.js";
import { isTestFile } from "../src/core/impact.js";
import { run as runQuery } from "../src/query/run.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const PROJECT = {
  "src/auth.ts": `export function validate(email: string): boolean {\n  return email.includes("@");\n}\n`,
  "src/login.ts":
    `import { validate } from "./auth";\n` +
    `export function login(email: string) {\n  return validate(email);\n}\n`,
  "src/boot.ts":
    `import { login } from "./login";\nexport function boot() {\n  login("a@b.c");\n}\n`,
  "src/other.ts": `export function other() {}\n`,
  // The call sits in an anonymous callback, so it belongs to no symbol.
  "test/login.test.ts":
    `import { login } from "../src/login";\n` +
    `test("logs in", () => {\n  login("a@b.c");\n});\n`,
  "test/other.test.ts":
    `import { other } from "../src/other";\ntest("other", () => {\n  other();\n});\n`,
};

async function indexed(files: Record<string, string> = PROJECT) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  await runIndex(made.root);
  return made.root;
}

describe("orvix impact", () => {
  test("lists direct and transitive callers by depth", async () => {
    const { output, ok } = await runImpact(await indexed(), "validate");

    expect(ok).toBe(true);
    const direct = output.indexOf("depth 1");
    const transitive = output.indexOf("depth 2");
    expect(direct).toBeGreaterThan(-1);
    expect(transitive).toBeGreaterThan(direct);
    expect(output.slice(direct, transitive)).toContain("login");
    expect(output.slice(transitive)).toContain("boot");
  });

  test("names the test files that reach the symbol, through file-scope calls", async () => {
    const { output } = await runImpact(await indexed(), "validate");

    expect(output).toContain("test/login.test.ts");
    expect(output).not.toContain("test/other.test.ts");
  });

  test("stops at --depth", async () => {
    const { output } = await runImpact(await indexed(), "validate", { depth: 1 });

    expect(output).toContain("login");
    expect(output).not.toContain("boot");
  });

  test("terminates on a cycle", async () => {
    const root = await indexed({
      "src/a.ts": `export function ping(n: number) { if (n) pong(n - 1); }\nexport function pong(n: number) { if (n) ping(n - 1); }\n`,
    });

    const { output, ok } = await runImpact(root, "ping");

    expect(ok).toBe(true);
    expect(output).toContain("pong");
  });

  test("says so when nothing depends on the symbol", async () => {
    const { output, ok } = await runImpact(await indexed(), "boot");

    expect(ok).toBe(true);
    expect(output).toContain("nothing in the index calls");
  });

  test("explains an unknown symbol", async () => {
    const { output, ok } = await runImpact(await indexed(), "nope");

    expect(ok).toBe(false);
    expect(output).toContain("orvix find");
  });

  test("emits parseable json", async () => {
    const { output } = await runImpact(await indexed(), "validate", { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.target.name).toBe("validate");
    expect(parsed.layers[0].depth).toBe(1);
    expect(parsed.layers[0].symbols.map((s: { name: string }) => s.name)).toEqual(["login"]);
    expect(parsed.tests).toEqual(["test/login.test.ts"]);
  });

  test("is reachable through orvix-query", async () => {
    const root = await indexed();

    const { output, ok } = await runQuery(["impact", "validate", "-p", root, "--depth", "1"]);

    expect(ok).toBe(true);
    expect(output).toContain("login");
    expect(output).not.toContain("boot");
  });
});

describe("isTestFile", () => {
  test.each([
    "test/a.ts",
    "tests/a.py",
    "src/__tests__/a.tsx",
    "src/a.test.ts",
    "src/a.spec.js",
    "pkg/a_test.go",
    "app/test_views.py",
    "src/test/java/FooTest.java",
    "Foo.Tests/BarTests.cs",
  ])("recognises %s", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  test.each(["src/testing.ts", "src/contest.ts", "src/latest/a.ts", "src/attest.py"])(
    "does not mistake %s for a test",
    (path) => {
      expect(isTestFile(path)).toBe(false);
    },
  );
});

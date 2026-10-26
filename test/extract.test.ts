import { describe, expect, test } from "vitest";
import { languageForPath } from "../src/core/languages.js";
import { extractFile } from "../src/core/extract.js";
import type { FileFacts } from "../src/types.js";

const typescript = languageForPath("a.ts")!;

function facts(source: string): Promise<FileFacts> {
  return extractFile(source, typescript);
}

function names(f: FileFacts): string[] {
  return f.symbols.map((s) => s.name);
}

describe("extractFile — definitions", () => {
  test("finds a top-level function with its signature and line", async () => {
    const f = await facts(`function greet(name: string): string {\n  return name;\n}\n`);

    expect(f.symbols).toHaveLength(1);
    expect(f.symbols[0]).toMatchObject({
      name: "greet",
      kind: "function",
      signature: "function greet(name: string): string",
      startLine: 1,
      endLine: 3,
      exported: false,
    });
  });

  test("marks exported declarations", async () => {
    const f = await facts(
      `export function a() {}\nfunction b() {}\nexport const c = 1;\n`,
    );

    expect(
      Object.fromEntries(f.symbols.map((s) => [s.name, s.exported])),
    ).toEqual({ a: true, b: false, c: true });
  });

  test("finds a class and attributes its methods to it", async () => {
    const f = await facts(
      `class LoginService {\n  validate(email: string): boolean {\n    return true;\n  }\n}\n`,
    );

    expect(names(f).sort()).toEqual(["LoginService", "validate"]);

    const method = f.symbols.find((s) => s.name === "validate");
    expect(method).toMatchObject({
      kind: "method",
      container: "LoginService",
      signature: "validate(email: string): boolean",
    });

    expect(f.symbols.find((s) => s.name === "LoginService")?.container)
      .toBeUndefined();
  });

  test("finds interfaces, their method signatures, and type aliases", async () => {
    const f = await facts(
      `interface Repo {\n  find(id: string): User;\n}\ntype User = { id: string };\n`,
    );

    const byName = Object.fromEntries(f.symbols.map((s) => [s.name, s]));
    expect(byName["Repo"]?.kind).toBe("interface");
    expect(byName["find"]?.kind).toBe("method");
    expect(byName["find"]?.container).toBe("Repo");
    expect(byName["User"]?.kind).toBe("type");
  });

  test("records an arrow-function const as a function, exactly once", async () => {
    const f = await facts(`const handler = (req: Request) => {\n  return 1;\n};\n`);

    expect(f.symbols).toHaveLength(1);
    expect(f.symbols[0]).toMatchObject({ name: "handler", kind: "function" });
  });

  test("records a plain const as a constant", async () => {
    const f = await facts(`const MAX = 10;\n`);

    expect(f.symbols).toHaveLength(1);
    expect(f.symbols[0]).toMatchObject({ name: "MAX", kind: "constant" });
  });

  test("finds enums", async () => {
    const f = await facts(`enum Color { Red, Blue }\n`);

    expect(f.symbols[0]).toMatchObject({ name: "Color", kind: "enum" });
  });
});

describe("extractFile — locals are not symbols", () => {
  test("ignores declarations inside a function body", async () => {
    const f = await facts(
      `function outer() {\n  const local = 1;\n  const inner = () => 2;\n}\n`,
    );

    expect(names(f)).toEqual(["outer"]);
  });

  test("ignores declarations nested two levels deep", async () => {
    const f = await facts(
      `function outer() {\n  const mid = () => {\n    const deep = 1;\n  };\n}\n`,
    );

    expect(names(f)).toEqual(["outer"]);
  });

  test("ignores declarations inside an anonymous callback", async () => {
    // The callback is not itself a named definition, so nesting cannot be
    // judged from the symbols alone — it has to come from the syntax tree.
    const f = await facts(
      `describe("suite", () => {\n  const root = 1;\n  test("x", async () => {\n    const inner = 2;\n  });\n});\n`,
    );

    expect(names(f)).toEqual([]);
  });

  test("ignores declarations inside a function expression", async () => {
    const f = await facts(
      `const wrapped = (function () {\n  const hidden = 1;\n  return hidden;\n})();\n`,
    );

    expect(names(f)).toEqual(["wrapped"]);
  });

  test("keeps file-scope constants", async () => {
    const f = await facts(`const MAX = 10;\nfunction f() {}\n`);

    expect(names(f).sort()).toEqual(["MAX", "f"]);
  });

  test("drops declarations inside a top-level block", async () => {
    // A const in `try { … }` or `if (…) { … }` at file scope is block-scoped:
    // nothing outside the block can name it. Found by diffing this repository,
    // where a hook's `const input` inside a top-level try showed up as a
    // module constant.
    const f = await facts(
      `try {
  const input = 1;
} catch {}
if (ready) {
  const flag = 2;
  function helper() {}
}
{
  let scoped = 3;
}
export const kept = 4;
`,
    );

    expect(names(f)).toEqual(["kept"]);
  });

  test("keeps the members of a namespace, whose body is also a block", async () => {
    const f = await facts(`export namespace Shapes {
  export function area() {}
}
`);

    expect(names(f)).toContain("area");
  });

  test("keeps methods, which are nested but not local", async () => {
    const f = await facts(`class A {\n  run() {\n    const x = 1;\n  }\n}\n`);

    expect(names(f).sort()).toEqual(["A", "run"]);
  });

  test("attributes a call to the enclosing function, not to a local variable", async () => {
    const f = await facts(
      `function outer() {\n  const cache = new Map();\n}\n`,
    );

    const outer = f.symbols.findIndex((s) => s.name === "outer");
    expect(f.references.find((r) => r.name === "Map")?.fromSymbol).toBe(outer);
  });
});

describe("extractFile — exported surface", () => {
  test("methods of an exported class count as exported", async () => {
    const f = await facts(`export class A {\n  run() {}\n}\n`);

    expect(f.symbols.find((s) => s.name === "run")?.exported).toBe(true);
  });

  test("methods of a non-exported class do not", async () => {
    const f = await facts(`class A {\n  run() {}\n}\n`);

    expect(f.symbols.find((s) => s.name === "run")?.exported).toBe(false);
  });
});

describe("extractFile — references", () => {
  test("attributes a call to the symbol that encloses it", async () => {
    const f = await facts(
      `function inner() {}\nfunction outer() {\n  inner();\n}\n`,
    );

    const outer = f.symbols.findIndex((s) => s.name === "outer");
    const call = f.references.find((r) => r.name === "inner");

    expect(call).toMatchObject({ name: "inner", line: 3, fromSymbol: outer });
  });

  test("records method calls by their property name", async () => {
    const f = await facts(`function f() {\n  service.validate(x);\n}\n`);

    expect(f.references.map((r) => r.name)).toContain("validate");
  });

  test("records constructor calls", async () => {
    const f = await facts(`function f() {\n  return new LoginService();\n}\n`);

    expect(f.references.map((r) => r.name)).toContain("LoginService");
  });

  test("leaves fromSymbol null for a call outside any definition", async () => {
    const f = await facts(`bootstrap();\n`);

    expect(f.references).toHaveLength(1);
    expect(f.references[0]?.fromSymbol).toBeNull();
  });

  test("attributes a call inside a method to that method", async () => {
    const f = await facts(
      `class A {\n  run() {\n    helper();\n  }\n}\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "helper")?.fromSymbol).toBe(run);
  });
});

describe("extractFile — imports", () => {
  test("records the module specifier and the imported names", async () => {
    const f = await facts(
      `import { a, b } from "./m";\nimport d from "pkg";\nimport * as ns from "./n";\n`,
    );

    expect(f.imports).toEqual([
      { source: "./m", names: ["a", "b"], line: 1 },
      { source: "pkg", names: ["d"], line: 2 },
      { source: "./n", names: ["ns"], line: 3 },
    ]);
  });

  test("records aliased imports under their local name", async () => {
    const f = await facts(`import { a as b } from "./m";\n`);

    expect(f.imports[0]?.names).toEqual(["b"]);
  });
});

describe("extractFile — resilience", () => {
  test("still returns the symbols around a syntax error", async () => {
    const f = await facts(`function ok() {}\nfunction (\n`);

    expect(names(f)).toContain("ok");
  });
});

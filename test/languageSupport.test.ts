import { describe, expect, test } from "vitest";
import { extractFile } from "../src/core/extract.js";
import { languageForPath } from "../src/core/languages.js";
import type { FileFacts } from "../src/types.js";

function facts(path: string, source: string): Promise<FileFacts> {
  const language = languageForPath(path);
  if (!language) throw new Error(`no language for ${path}`);
  return extractFile(source, language);
}

const summary = (f: FileFacts) =>
  Object.fromEntries(
    f.symbols.map((s) => [
      s.container ? `${s.container}.${s.name}` : s.name,
      `${s.kind}${s.exported ? "*" : ""}`,
    ]),
  );

describe("tsx", () => {
  test("reads components and hooks", async () => {
    const f = await facts(
      "src/App.tsx",
      `export interface Props { title: string }\n` +
        `export function App({ title }: Props) {\n  return <h1>{title}</h1>;\n}\n` +
        `const helper = () => 1;\n`,
    );

    expect(summary(f)).toEqual({
      Props: "interface*",
      App: "function*",
      helper: "function",
    });
  });
});

describe("javascript", () => {
  test("reads functions, classes and methods", async () => {
    const f = await facts(
      "src/a.js",
      `export function greet(name) {}\n` +
        `class Service {\n  run() {\n    greet("x");\n  }\n}\n` +
        `const MAX = 10;\n`,
    );

    expect(summary(f)).toEqual({
      greet: "function*",
      Service: "class",
      "Service.run": "method",
      MAX: "constant",
    });
  });

  test("attributes a call to the method it sits in", async () => {
    const f = await facts(
      "src/a.js",
      `function greet() {}\nclass S {\n  run() {\n    greet();\n  }\n}\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "greet")?.fromSymbol).toBe(run);
  });
});

describe("python", () => {
  test("reads functions, classes and methods", async () => {
    const f = await facts(
      "src/a.py",
      `def greet(name):\n    return name\n\n` +
        `class Service:\n    def run(self):\n        return greet("x")\n\n` +
        `def _private():\n    pass\n`,
    );

    expect(summary(f)).toEqual({
      greet: "function*",
      Service: "class*",
      "Service.run": "method*",
      _private: "function",
    });
  });

  test("drops the trailing colon from a signature", async () => {
    const f = await facts("src/a.py", `def run(x):\n    pass\n\nclass A(Base):\n    pass\n`);

    expect(f.symbols.map((s) => s.signature)).toEqual([
      "def run(x)",
      "class A(Base)",
    ]);
  });

  test("treats a leading underscore as private", async () => {
    const f = await facts("src/a.py", `def _hidden():\n    pass\n`);

    expect(f.symbols[0]?.exported).toBe(false);
  });

  test("records a call and its caller", async () => {
    const f = await facts(
      "src/a.py",
      `def helper():\n    pass\n\ndef run():\n    helper()\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "helper")?.fromSymbol).toBe(run);
  });

  test("ignores variables local to a function", async () => {
    const f = await facts(
      "src/a.py",
      `TOP = 1\n\ndef run():\n    inner = 2\n    return inner\n`,
    );

    expect(f.symbols.map((s) => s.name).sort()).toEqual(["TOP", "run"]);
  });

  // The query matches a module-level assignment through its `(module ...)`
  // parent. Capturing the definition on that parent rather than on the
  // assignment gave every constant the whole file as its range, so `show`
  // printed the file. Nothing else pinned a constant's span.
  test("spans only the assignment, not the enclosing module", async () => {
    const f = await facts(
      "src/a.py",
      `import os\n\nTHRESHOLD = 42\n\ndef run():\n    return THRESHOLD\n`,
    );

    const threshold = f.symbols.find((s) => s.name === "THRESHOLD");
    expect(threshold?.startLine).toBe(3);
    expect(threshold?.endLine).toBe(3);
  });
});

describe("go", () => {
  test("reads functions, methods, structs and interfaces", async () => {
    const f = await facts(
      "main.go",
      `package main\n\n` +
        `type Service struct { url string }\n\n` +
        `type Runner interface { Run() error }\n\n` +
        `func (s *Service) Run() error {\n\treturn nil\n}\n\n` +
        `func helper() {}\n\n` +
        `func Exported() {\n\thelper()\n}\n`,
    );

    const found = summary(f);
    expect(found["Service"]).toBe("class*");
    expect(found["Runner"]).toBe("interface*");
    expect(found["Run"]).toBe("method*");
    expect(found["helper"]).toBe("function");
    expect(found["Exported"]).toBe("function*");
  });

  test("treats a capitalised name as exported", async () => {
    const f = await facts("main.go", `package main\nfunc lower() {}\nfunc Upper() {}\n`);

    expect(
      Object.fromEntries(f.symbols.map((s) => [s.name, s.exported])),
    ).toEqual({ lower: false, Upper: true });
  });

  test("records a call and its caller", async () => {
    const f = await facts(
      "main.go",
      `package main\nfunc helper() {}\nfunc run() {\n\thelper()\n}\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "helper")?.fromSymbol).toBe(run);
  });

  // A grouped `type ( … )` is one type_declaration holding several type_specs.
  // Anchoring the definition on the declaration gave every type in the group
  // the whole block as its range, so `show Alpha` printed Beta as well.
  test("gives each type in a grouped declaration its own span", async () => {
    const f = await facts(
      "main.go",
      `package main\n\n` +
        `type (\n\tAlpha struct {\n\t\tx int\n\t}\n\tBeta struct {\n\t\ty int\n\t}\n)\n`,
    );

    const alpha = f.symbols.find((s) => s.name === "Alpha");
    const beta = f.symbols.find((s) => s.name === "Beta");

    expect([alpha?.startLine, alpha?.endLine]).toEqual([4, 6]);
    expect([beta?.startLine, beta?.endLine]).toEqual([7, 9]);
  });
});

describe("java", () => {
  test("reads classes, interfaces, methods and enums", async () => {
    const f = await facts(
      "src/Service.java",
      `package com.example;\n\n` +
        `public interface Runner {\n  void run();\n}\n\n` +
        `public enum Mode { FAST, SLOW }\n\n` +
        `public class Service {\n` +
        `  public int run() {\n    return helper();\n  }\n` +
        `  private int helper() {\n    return 1;\n  }\n}\n`,
    );

    const found = summary(f);
    expect(found["Runner"]).toBe("interface*");
    expect(found["Mode"]).toBe("enum*");
    expect(found["Service"]).toBe("class*");
    expect(found["Service.run"]).toBe("method*");
  });

  // Java says private out loud. Inferring visibility from the enclosing class,
  // as the ECMAScript path does, would contradict the source.
  test("treats a private member as not exported", async () => {
    const f = await facts(
      "src/Service.java",
      `public class Service {\n  public int open() { return 1; }\n  private int shut() { return 2; }\n}\n`,
    );

    expect(
      Object.fromEntries(f.symbols.map((s) => [s.name, s.exported])),
    ).toEqual({ Service: true, open: true, shut: false });
  });

  test("records a call and its caller", async () => {
    const f = await facts(
      "src/Service.java",
      `class Service {\n  int helper() { return 1; }\n  int run() {\n    return helper();\n  }\n}\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "helper")?.fromSymbol).toBe(run);
  });

  test("ignores variables local to a method", async () => {
    const f = await facts(
      "src/Service.java",
      `class Service {\n  int run() {\n    int inner = 2;\n    return inner;\n  }\n}\n`,
    );

    expect(f.symbols.map((s) => s.name).sort()).toEqual(["Service", "run"]);
  });

  test("distinguishes a call through a receiver from a bare one", async () => {
    const f = await facts(
      "src/Service.java",
      `class Service {\n  int run(Helper h) {\n    return h.compute() + local();\n  }\n  int local() { return 1; }\n}\n`,
    );

    const compute = f.references.find((r) => r.name === "compute");
    const local = f.references.find((r) => r.name === "local");

    expect(compute?.viaMember).toBe(true);
    expect(local?.viaMember).toBe(false);
  });
});

describe("csharp", () => {
  test("reads types and members", async () => {
    const f = await facts(
      "src/Service.cs",
      `namespace App {\n` +
        `  public interface IRunner { void Run(); }\n` +
        `  public enum Mode { Fast }\n` +
        `  public struct Point { public int X; }\n` +
        `  public class Service {\n` +
        `    public int Run() { return Helper(); }\n` +
        `    private int Helper() => 1;\n  }\n}\n`,
    );

    const found = summary(f);
    expect(found["IRunner"]).toBe("interface*");
    expect(found["Mode"]).toBe("enum*");
    expect(found["Point"]).toBe("class*");
    expect(found["Service.Run"]).toBe("method*");
    expect(found["Service.Helper"]).toBe("method");
  });

  test("distinguishes a call through a receiver from a bare one", async () => {
    const f = await facts(
      "src/Service.cs",
      `class S {\n  void R(Other other) {\n    Helper();\n    other.Compute();\n  }\n}\n`,
    );

    expect(f.references.find((r) => r.name === "Helper")?.viaMember).toBe(false);
    expect(f.references.find((r) => r.name === "Compute")?.viaMember).toBe(true);
  });

  test("ignores variables local to a method", async () => {
    const f = await facts(
      "src/Service.cs",
      `class S {\n  int R() {\n    int inner = 2;\n    return inner;\n  }\n}\n`,
    );

    expect(f.symbols.map((s) => s.name).sort()).toEqual(["R", "S"]);
  });
});

describe("cpp", () => {
  test("reads functions, classes, structs and enums", async () => {
    const f = await facts(
      "src/service.cpp",
      `int helper() { return 1; }\n` +
        `class Service {\npublic:\n  int inline_run() { return helper(); }\n};\n` +
        `struct Point { int x; };\n` +
        `enum Mode { Fast };\n`,
    );

    const found = summary(f);
    expect(found["helper"]).toBe("function*");
    expect(found["Service"]).toBe("class*");
    expect(found["Point"]).toBe("class*");
    expect(found["Mode"]).toBe("enum*");
    expect(found["Service.inline_run"]).toBe("method*");
  });

  // `int Service::run() { … }` sits outside the class, so containment cannot
  // make it a method. Tagged as one directly, or `obj.run()` could never
  // reach it — a bare call and a receiver call are kept apart on kind.
  test("reads an out-of-line definition as a method, under its own name", async () => {
    const f = await facts(
      "src/service.cpp",
      `struct Service { int run(); };\nint Service::run() { return 1; }\n`,
    );

    const run = f.symbols.filter((s) => s.name === "run");
    expect(run).toHaveLength(1);
    expect(run[0]?.kind).toBe("method");
  });

  test("does not index a member declaration as a second symbol", async () => {
    const f = await facts(
      "src/service.cpp",
      `struct Service {\n  int run();\n  int other();\n};\n`,
    );

    expect(f.symbols.map((s) => s.name)).toEqual(["Service"]);
  });

  // C++ has no distinct constructor node: one is a function_definition whose
  // name happens to equal its class's. Left indexed it duplicates the class's
  // name, making `show S` ambiguous and costing every call site that names S.
  test("does not index a constructor as a second symbol", async () => {
    const f = await facts(
      "src/service.cpp",
      `struct S {\n  S();\n  int run();\n};\n` +
        `S::S() {}\nint S::run() { return 1; }\n`,
    );

    expect(f.symbols.map((s) => s.name).sort()).toEqual(["S", "run"]);
  });

  test("does not index an inline constructor either", async () => {
    const f = await facts(
      "src/service.cpp",
      `struct S {\n  S() {}\n  int run() { return 1; }\n};\n`,
    );

    expect(f.symbols.map((s) => s.name).sort()).toEqual(["S", "run"]);
  });

  test("treats a static function as file-local", async () => {
    const f = await facts(
      "src/service.cpp",
      `static int hidden() { return 1; }\nint shown() { return 2; }\n`,
    );

    expect(
      Object.fromEntries(f.symbols.map((s) => [s.name, s.exported])),
    ).toEqual({ hidden: false, shown: true });
  });

  test("ignores variables local to a function", async () => {
    const f = await facts(
      "src/service.cpp",
      `int run() {\n  int inner = 2;\n  return inner;\n}\n`,
    );

    expect(f.symbols.map((s) => s.name)).toEqual(["run"]);
  });
});

describe("c", () => {
  test("reads functions and structs through the C++ grammar", async () => {
    const f = await facts(
      "src/main.c",
      `#include <stdio.h>\n` +
        `static int helper(void) { return 1; }\n` +
        `int run(void) { return helper(); }\n` +
        `struct Point { int x; };\n`,
    );

    const found = summary(f);
    expect(found["helper"]).toBe("function");
    expect(found["run"]).toBe("function*");
    expect(found["Point"]).toBe("class*");
  });

  test("records a call and its caller", async () => {
    const f = await facts(
      "src/main.c",
      `int helper(void) { return 1; }\nint run(void) { return helper(); }\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "helper")?.fromSymbol).toBe(run);
  });
});

describe("rust", () => {
  test("reads functions, structs, enums and traits", async () => {
    const f = await facts(
      "src/lib.rs",
      `pub struct Config { url: String }\n\n` +
        `pub enum Mode { Fast, Slow }\n\n` +
        `pub trait Runner { fn run(&self); }\n\n` +
        `fn helper() {}\n\n` +
        `pub fn start() {\n    helper();\n}\n`,
    );

    const found = summary(f);
    expect(found["Config"]).toBe("class*");
    expect(found["Mode"]).toBe("enum*");
    expect(found["Runner"]).toBe("interface*");
    expect(found["helper"]).toBe("function");
    expect(found["start"]).toBe("function*");
  });

  test("treats pub as exported", async () => {
    const f = await facts("src/lib.rs", `fn private() {}\npub fn public() {}\n`);

    expect(
      Object.fromEntries(f.symbols.map((s) => [s.name, s.exported])),
    ).toEqual({ private: false, public: true });
  });

  test("records a call and its caller", async () => {
    const f = await facts(
      "src/lib.rs",
      `fn helper() {}\npub fn run() {\n    helper();\n}\n`,
    );

    const run = f.symbols.findIndex((s) => s.name === "run");
    expect(f.references.find((r) => r.name === "helper")?.fromSymbol).toBe(run);
  });

  test("ignores bindings local to a function", async () => {
    const f = await facts(
      "src/lib.rs",
      `pub const TOP: u32 = 1;\npub fn run() {\n    const INNER: u32 = 2;\n}\n`,
    );

    expect(f.symbols.map((s) => s.name).sort()).toEqual(["TOP", "run"]);
  });
});

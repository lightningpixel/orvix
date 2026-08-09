import { afterEach, describe, expect, test } from "vitest";
import { buildIndex } from "../src/core/indexer.js";
import { buildCallGraph, type CallGraph } from "../src/core/resolve.js";
import type { OrvixIndex } from "../src/types.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

interface Scenario {
  graph: CallGraph;
  index: OrvixIndex;
  /** Symbol id for a `file:name` pair, e.g. "src/a.ts:greet". */
  id: (ref: string) => string;
}

async function scenario(files: Record<string, string>): Promise<Scenario> {
  const made = await makeProject(files);
  cleanup = made.cleanup;

  const { index } = await buildIndex(made.root);
  const lookup = new Map<string, string>();
  for (const [file, entry] of Object.entries(index.files)) {
    for (const symbol of entry.symbols) lookup.set(`${file}:${symbol.name}`, symbol.id);
  }

  return {
    graph: buildCallGraph(index),
    index,
    id: (ref) => {
      const found = lookup.get(ref);
      if (!found) throw new Error(`no symbol ${ref} (have ${[...lookup.keys()]})`);
      return found;
    },
  };
}

function callersOf(graph: CallGraph, id: string): string[] {
  return [...(graph.callers.get(id) ?? [])];
}

describe("same-file resolution", () => {
  test("links a call to a function defined in the same file", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `function inner() {}\nfunction outer() {\n  inner();\n}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:inner"))).toEqual([
      id("src/a.ts:outer"),
    ]);
  });

  test("prefers the local definition over a same-named one elsewhere", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `function helper() {}\nexport function run() {\n  helper();\n}\n`,
      "src/b.ts": `export function helper() {}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:helper"))).toEqual([
      id("src/a.ts:run"),
    ]);
    expect(callersOf(graph, id("src/b.ts:helper"))).toEqual([]);
  });

  test("records the caller as null for a call at file scope", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `function boot() {}\nboot();\n`,
    });

    expect(graph.edges).toContainEqual({
      from: null,
      to: id("src/a.ts:boot"),
    });
  });
});

describe("import resolution", () => {
  test("follows a relative import", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `import { helper } from "./b";\nexport function run() {\n  helper();\n}\n`,
      "src/b.ts": `export function helper() {}\n`,
    });

    expect(callersOf(graph, id("src/b.ts:helper"))).toEqual([
      id("src/a.ts:run"),
    ]);
  });

  test("follows an import written with a .js extension onto a .ts file", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `import { helper } from "./b.js";\nexport function run() {\n  helper();\n}\n`,
      "src/b.ts": `export function helper() {}\n`,
    });

    expect(callersOf(graph, id("src/b.ts:helper"))).toEqual([
      id("src/a.ts:run"),
    ]);
  });

  test("follows an import onto a directory index file", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `import { helper } from "./util";\nexport function run() {\n  helper();\n}\n`,
      "src/util/index.ts": `export function helper() {}\n`,
    });

    expect(callersOf(graph, id("src/util/index.ts:helper"))).toEqual([
      id("src/a.ts:run"),
    ]);
  });

  test("follows a parent-directory import", async () => {
    const { graph, id } = await scenario({
      "src/deep/a.ts": `import { helper } from "../b";\nexport function run() {\n  helper();\n}\n`,
      "src/b.ts": `export function helper() {}\n`,
    });

    expect(callersOf(graph, id("src/b.ts:helper"))).toEqual([
      id("src/deep/a.ts:run"),
    ]);
  });

  test("ignores imports of packages outside the project", async () => {
    const { graph } = await scenario({
      "src/a.ts": `import { join } from "node:path";\nexport function run() {\n  join("a");\n}\n`,
    });

    expect(graph.edges).toEqual([]);
  });
});

describe("project-wide fallback", () => {
  test("links a call to the only exported symbol with that name", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `export function run() {\n  helper();\n}\n`,
      "src/b.ts": `export function helper() {}\n`,
    });

    expect(callersOf(graph, id("src/b.ts:helper"))).toEqual([
      id("src/a.ts:run"),
    ]);
  });

  test("does not guess when two exported symbols share the name", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `export function run() {\n  helper();\n}\n`,
      "src/b.ts": `export function helper() {}\n`,
      "src/c.ts": `export function helper() {}\n`,
    });

    expect(graph.edges).toEqual([]);
    expect(graph.ambiguous).toEqual([
      {
        from: id("src/a.ts:run"),
        name: "helper",
        file: "src/a.ts",
        line: 2,
        candidates: [id("src/b.ts:helper"), id("src/c.ts:helper")].sort(),
      },
    ]);
  });

  test("ignores calls to names the project does not define", async () => {
    const { graph } = await scenario({
      "src/a.ts": `export function run() {\n  console.log(new Map());\n}\n`,
    });

    expect(graph.edges).toEqual([]);
    expect(graph.unresolved).toBeGreaterThan(0);
  });
});

describe("graph shape", () => {
  test("exposes callees alongside callers", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `function inner() {}\nfunction outer() {\n  inner();\n}\n`,
    });

    expect([...(graph.callees.get(id("src/a.ts:outer")) ?? [])]).toEqual([
      id("src/a.ts:inner"),
    ]);
  });

  test("records one edge per call site, not per pair", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `function inner() {}\nfunction outer() {\n  inner();\n  inner();\n}\n`,
    });

    expect(
      graph.edges.filter((e) => e.to === id("src/a.ts:inner")),
    ).toHaveLength(2);
    expect(callersOf(graph, id("src/a.ts:inner"))).toEqual([
      id("src/a.ts:outer"),
    ]);
  });

  test("does not resolve a method call to a plain function of the same name", async () => {
    // `JSON.parse(x)` must not be read as a call to the project's own
    // `parse` function; a receiver means a method is being called.
    const { graph, id } = await scenario({
      "src/a.ts": `export function parse(s: string) {}\nexport function run(raw: string) {\n  return JSON.parse(raw);\n}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:parse"))).toEqual([]);
  });

  test("does not resolve a bare call to a method of the same name", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `export class A {\n  validate() {}\n}\nexport function run() {\n  validate();\n}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:validate"))).toEqual([]);
  });

  test("still resolves a constructor call to its class", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `export class Service {}\nexport function run() {\n  return new Service();\n}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:Service"))).toEqual([
      id("src/a.ts:run"),
    ]);
  });

  test("resolves method calls to the method definition", async () => {
    const { graph, id } = await scenario({
      "src/a.ts": `export class Service {\n  validate() {}\n}\nexport function run(s: Service) {\n  s.validate();\n}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:validate"))).toEqual([
      id("src/a.ts:run"),
    ]);
  });
});

describe("implicit receiver", () => {
  // In Java and C# every function is a method, and calling one of your own
  // without `this.` is ordinary. Applying the ECMAScript rule — a bare call
  // reaches only a non-method — drops every intra-class call in the language.
  test("links a bare call to a method of the same Java class", async () => {
    const { graph, id } = await scenario({
      "G.java":
        `public class G {\n  private int helper() { return 1; }\n` +
        `  public int run() { return helper(); }\n}\n`,
    });

    expect(callersOf(graph, id("G.java:helper"))).toEqual([id("G.java:run")]);
  });

  test("links a bare call to a method of the same C# class", async () => {
    const { graph, id } = await scenario({
      "H.cs":
        `public class H {\n  private int Helper() { return 1; }\n` +
        `  public int Run() { return Helper(); }\n}\n`,
    });

    expect(callersOf(graph, id("H.cs:Helper"))).toEqual([id("H.cs:Run")]);
  });

  test("links a bare call to a member function in C++", async () => {
    const { graph, id } = await scenario({
      "s.cpp":
        `struct S {\n  int helper() { return 1; }\n  int run() { return helper(); }\n};\n`,
    });

    expect(callersOf(graph, id("s.cpp:helper"))).toEqual([id("s.cpp:run")]);
  });

  // The rule still holds where a method genuinely needs a receiver.
  test("still refuses a bare call to a method in TypeScript", async () => {
    const { graph, id } = await scenario({
      "src/a.ts":
        `export class A {\n  validate() {}\n}\nexport function run() {\n  validate();\n}\n`,
    });

    expect(callersOf(graph, id("src/a.ts:validate"))).toEqual([]);
  });

  test("still refuses a bare call to a method in Python", async () => {
    const { graph, id } = await scenario({
      "a.py":
        `class A:\n    def validate(self):\n        pass\n\ndef run():\n    validate()\n`,
    });

    expect(callersOf(graph, id("a.py:validate"))).toEqual([]);
  });
});

describe("constructors", () => {
  // A constructor carries its class's name, so tagging it as a symbol makes
  // every `new S()` match two candidates and draw no edge at all. It is not
  // separately addressable either — `show S` must mean the class — and its
  // source sits inside the class's range regardless.
  test("does not make `new S()` ambiguous with the class in Java", async () => {
    const { graph, id } = await scenario({
      "S.java":
        `public class S {\n  public S() {}\n}\n` +
        `class Factory {\n  S build() { return new S(); }\n}\n`,
    });

    expect(graph.ambiguous.map((a) => a.name)).toEqual([]);
    expect(callersOf(graph, id("S.java:S"))).toEqual([id("S.java:build")]);
  });

  test("does not make `new S()` ambiguous with the class in C#", async () => {
    const { graph, id } = await scenario({
      "S.cs":
        `public class S {\n  public S() {}\n}\n` +
        `class Factory {\n  S Build() { return new S(); }\n}\n`,
    });

    expect(graph.ambiguous.map((a) => a.name)).toEqual([]);
    expect(callersOf(graph, id("S.cs:S"))).toEqual([id("S.cs:Build")]);
  });
});

describe("language boundaries", () => {
  // Found on a real polyglot project: the only symbol in the index named
  // `filter` was a Python logging filter, so every `xs.filter(…)` in the
  // TypeScript half resolved to it — 41 callers that cannot exist.
  test("does not link a TypeScript call to a Python definition", async () => {
    const { graph, id } = await scenario({
      "api/main.py": `class Handler:\n    def filter(self, record):\n        return True\n`,
      "src/a.ts": `export function run(items: number[]) {\n  return items.filter((n) => n > 0);\n}\n`,
    });

    expect(callersOf(graph, id("api/main.py:filter"))).toEqual([]);
  });

  test("does not link a Python call to a Go definition", async () => {
    const { graph, id } = await scenario({
      "main.go": `package main\n\nfunc Compute() int { return 1 }\n`,
      "run.py": `def start():\n    return Compute()\n`,
    });

    expect(callersOf(graph, id("main.go:Compute"))).toEqual([]);
  });

  // TypeScript, TSX and JavaScript are one ecosystem and must keep resolving
  // across the boundary, or the fix costs more than the bug.
  test("still links a TSX call to a TypeScript definition", async () => {
    const { graph, id } = await scenario({
      "src/util.ts": `export function format(n: number): string {\n  return String(n);\n}\n`,
      "src/App.tsx": `import { format } from "./util";\nexport function App() {\n  return <p>{format(1)}</p>;\n}\n`,
    });

    expect(callersOf(graph, id("src/util.ts:format"))).toEqual([
      id("src/App.tsx:App"),
    ]);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { buildIndex } from "../src/core/indexer.js";
import { buildCallGraph, type CallGraph } from "../src/core/resolve.js";
import { qualifiedName } from "../src/core/symbols.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * Two classes sharing a method name is exactly the case a syntactic resolver
 * cannot settle: `x.save()` has two candidates and no edge is drawn. Every
 * scenario below has that shape, and differs only in what the source declares
 * about the receiver.
 */
async function scenario(files: Record<string, string>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;

  const { index } = await buildIndex(made.root);
  const graph = buildCallGraph(index);
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  const fileById = new Map<string, string>();
  for (const entry of Object.values(index.files)) {
    for (const symbol of entry.symbols) {
      ids.set(qualifiedName(symbol), symbol.id);
      names.set(symbol.id, qualifiedName(symbol));
      fileById.set(symbol.id, symbol.file);
    }
  }

  const id = (name: string) => {
    const found = ids.get(name);
    if (!found) throw new Error(`no symbol ${name} (have ${[...ids.keys()]})`);
    return found;
  };
  const callersOf = (name: string) =>
    [...(graph.callers.get(id(name)) ?? [])].map((caller) => names.get(caller)).sort();

  const fileOf = (symbolId: string) => fileById.get(symbolId);

  return { graph, id, callersOf, fileOf };
}

const TS_CLASSES =
  `export class Repo {\n  save() {}\n}\n` + `export class Cache {\n  save() {}\n}\n`;

describe("receiver types — TypeScript", () => {
  test("an untyped receiver stays unresolved, as before", async () => {
    const { callersOf, graph } = await scenario({
      "src/types.ts": TS_CLASSES,
      "src/use.ts": `export function run(x) {\n  x.save();\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual([]);
    expect(callersOf("Cache.save")).toEqual([]);
    expect(graph.ambiguous.some((call) => call.name === "save")).toBe(true);
  });

  test("a parameter's declared type picks the method", async () => {
    const { callersOf } = await scenario({
      "src/types.ts": TS_CLASSES,
      "src/use.ts": `import { Repo } from "./types";\nexport function run(r: Repo) {\n  r.save();\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["run"]);
    expect(callersOf("Cache.save")).toEqual([]);
  });

  test("a variable initialised with new picks the method", async () => {
    const { callersOf } = await scenario({
      "src/types.ts": TS_CLASSES,
      "src/use.ts": `import { Cache } from "./types";\nexport function run() {\n  const c = new Cache();\n  c.save();\n}\n`,
    });

    expect(callersOf("Cache.save")).toEqual(["run"]);
    expect(callersOf("Repo.save")).toEqual([]);
  });

  test("this reaches the enclosing class", async () => {
    const { callersOf } = await scenario({
      "src/types.ts": `export class Repo {\n  save() {}\n  run() {\n    this.save();\n  }\n}\nexport class Cache {\n  save() {}\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["Repo.run"]);
    expect(callersOf("Cache.save")).toEqual([]);
  });

  test("this.field reaches the field's declared type", async () => {
    const { callersOf } = await scenario({
      "src/types.ts": TS_CLASSES,
      "src/service.ts":
        `import { Cache } from "./types";\n` +
        `export class Service {\n  private store: Cache;\n  run() {\n    this.store.save();\n  }\n}\n`,
    });

    expect(callersOf("Cache.save")).toEqual(["Service.run"]);
  });

  test("a declaration in one function does not type a name in another", async () => {
    const { callersOf } = await scenario({
      "src/types.ts": TS_CLASSES,
      "src/use.ts":
        `import { Repo } from "./types";\n` +
        `export function typed(r: Repo) {\n  return r;\n}\n` +
        `export function untyped(r) {\n  r.save();\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual([]);
  });

  test("a declared type with no such method falls back to the old rule", async () => {
    // Inherited methods are invisible to a syntactic resolver. With one save
    // in the whole project, the old project-unique rule still applies.
    const { callersOf } = await scenario({
      "src/types.ts": `export class Repo {\n  save() {}\n}\nexport class Child extends Repo {}\n`,
      "src/use.ts": `import { Child } from "./types";\nexport function run(c: Child) {\n  c.save();\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["run"]);
  });
});

describe("receiver types — Java", () => {
  const CLASSES = {
    "src/Repo.java": `public class Repo {\n  public void save() {}\n}\n`,
    "src/Cache.java": `public class Cache {\n  public void save() {}\n}\n`,
  };

  test("a field used without this", async () => {
    const { callersOf } = await scenario({
      ...CLASSES,
      "src/Service.java": `public class Service {\n  private Repo repo;\n  public void run() {\n    repo.save();\n  }\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["Service.run"]);
    expect(callersOf("Cache.save")).toEqual([]);
  });

  test("prefers the class of that name in the same file", async () => {
    // Nested classes reuse names — every builder is a Builder — so a declared
    // type names a class, but not always only one.
    const { graph, id, fileOf } = await scenario({
      "src/A.java": `public class A {
  static class Builder {
    void build() {}
  }
  void run(Builder b) {
    b.build();
  }
}
`,
      "src/B.java": `public class B {
  static class Builder {
    void build() {}
  }
}
`,
    });

    const builds = [...(graph.callees.get(id("A.run")) ?? [])];
    expect(builds.map(fileOf)).toEqual(["src/A.java"]);
  });

  test("a local, a parameter and var with new", async () => {
    const { callersOf } = await scenario({
      ...CLASSES,
      "src/Service.java":
        `public class Service {\n` +
        `  public void local() {\n    Repo r = make();\n    r.save();\n  }\n` +
        `  public void param(Cache c) {\n    c.save();\n  }\n` +
        `  public void inferred() {\n    var c = new Cache();\n    c.save();\n  }\n` +
        `  private Repo make() { return null; }\n}\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["Service.local"]);
    expect(callersOf("Cache.save")).toEqual(["Service.inferred", "Service.param"]);
  });

  test("this.field", async () => {
    const { callersOf } = await scenario({
      ...CLASSES,
      "src/Service.java": `public class Service {\n  private Cache cache;\n  public void run() {\n    this.cache.save();\n  }\n}\n`,
    });

    expect(callersOf("Cache.save")).toEqual(["Service.run"]);
  });
});

describe("receiver types — C#", () => {
  test("this, a parameter and var with new", async () => {
    const { callersOf } = await scenario({
      "src/Types.cs":
        `public class Repo {\n  public void Save() {}\n  public void Run() {\n    this.Save();\n  }\n}\n` +
        `public class Cache {\n  public void Save() {}\n}\n`,
      "src/Service.cs":
        `public class Service {\n` +
        `  public void Param(Cache c) {\n    c.Save();\n  }\n` +
        `  public void Inferred() {\n    var r = new Repo();\n    r.Save();\n  }\n}\n`,
    });

    expect(callersOf("Repo.Save")).toEqual(["Repo.Run", "Service.Inferred"]);
    expect(callersOf("Cache.Save")).toEqual(["Service.Param"]);
  });
});

describe("receiver types — Python", () => {
  test("self and an annotated parameter", async () => {
    const { callersOf } = await scenario({
      "src/types.py":
        `class Repo:\n    def save(self):\n        pass\n\n    def run(self):\n        self.save()\n\n\n` +
        `class Cache:\n    def save(self):\n        pass\n`,
      "src/use.py": `def flush(c: Cache):\n    c.save()\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["Repo.run"]);
    expect(callersOf("Cache.save")).toEqual(["flush"]);
  });
});

describe("receiver types — C++", () => {
  test("this-> and a typed parameter, inside class bodies", async () => {
    const { callersOf } = await scenario({
      "src/types.hpp":
        `class Repo {\n public:\n  void save() {}\n  void run() { this->save(); }\n};\n` +
        `class Cache {\n public:\n  void save() {}\n  void flush(Repo* r) { r->save(); }\n};\n`,
    });

    expect(callersOf("Repo.save")).toEqual(["Cache.flush", "Repo.run"]);
    expect(callersOf("Cache.save")).toEqual([]);
  });
});

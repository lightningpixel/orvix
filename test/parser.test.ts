import { describe, expect, test } from "vitest";
import { languageForPath } from "../src/core/languages.js";
import { parse } from "../src/core/parser.js";

function definitionOf(path: string, source: string) {
  const language = languageForPath(path);
  if (!language) throw new Error(`no language for ${path}`);
  return parse(source, language);
}

describe("parse", () => {
  test("parses TypeScript into a real syntax tree", async () => {
    const tree = await definitionOf("a.ts", "function greet(name: string) {}");

    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.namedChild(0)?.type).toBe("function_declaration");
  });

  test("parses Go and TypeScript in the same session", async () => {
    const ts = await definitionOf("a.ts", "const x = 1;");
    const go = await definitionOf("main.go", "package main\nfunc main() {}");

    expect(ts.rootNode.type).toBe("program");
    expect(go.rootNode.type).toBe("source_file");
  });

  test.each([
    ["a.tsx", "const A = () => <div />;", "program"],
    ["a.py", "def f():\n    pass\n", "module"],
    ["a.rs", "fn main() {}", "source_file"],
    ["a.js", "const x = 1;", "program"],
  ])("parses %s", async (path, source, rootType) => {
    const tree = await definitionOf(path, source);
    expect(tree.rootNode.type).toBe(rootType);
  });

  test("reports syntax errors rather than throwing", async () => {
    const tree = await definitionOf("a.ts", "function (");

    expect(tree.rootNode.hasError).toBe(true);
  });
});

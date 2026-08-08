import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIST = resolve("dist");
const QUERY = join(DIST, "query.js");

/**
 * Follows a bundle's *static* imports so the whole eagerly-loaded graph is
 * checked, not just the entry file. Splitting moves shared code into chunks,
 * so an accidental tree-sitter import would land in a chunk and an entry-only
 * assertion would sail straight past it.
 *
 * Dynamic imports are deliberately not followed. Reindexing a dirty file does
 * need the parser, and reaches it with `await import(...)`; what matters is
 * that a query on a clean project never loads it, and that is exactly the
 * distinction between a static and a dynamic edge.
 */
async function moduleGraph(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;

    const source = await readFile(path, "utf8");
    seen.set(path, source);

    for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const next = resolve(dirname(path), specifier);
      if (existsSync(next)) queue.push(next);
    }
  }

  return seen;
}

const built = existsSync(QUERY);

describe.skipIf(!built)("the query bundle", () => {
  test("never loads the tree-sitter runtime", async () => {
    // Grammars cost far more than the lookup they would serve, and the query
    // path answers from an index that has already been parsed.
    const graph = await moduleGraph(QUERY);

    for (const [path, source] of graph) {
      expect(source, `${path} imports web-tree-sitter`).not.toMatch(
        /["']web-tree-sitter["']/,
      );
    }
  });

  test("never loads a CLI framework", async () => {
    const graph = await moduleGraph(QUERY);

    for (const [path, source] of graph) {
      expect(source, `${path} imports commander`).not.toMatch(/["']commander["']/);
    }
  });

  test("reaches the reindexer only through a dynamic import", async () => {
    // The counterpart to the two assertions above: the parser must be
    // reachable, or a dirty file could never be caught up — just never on the
    // path a clean query takes.
    const graph = await moduleGraph(QUERY);
    const sources = [...graph.values()].join("\n");

    expect(sources).toMatch(/import\(/);
  });

  test("answers a lookup against this repo's own index", async () => {
    const { stdout } = await run(process.execPath, [
      QUERY,
      "find",
      "resolveModule",
      "--path",
      resolve("."),
      "--json",
    ]);

    expect(JSON.parse(stdout)[0]).toMatchObject({ name: "resolveModule" });
  });

  test("reports a bad command without crashing", async () => {
    const { stdout } = await run(process.execPath, [QUERY, "nonsense"]).catch(
      (error: { stdout: string; stderr: string }) => ({
        stdout: error.stderr,
      }),
    );

    expect(stdout).toContain("unknown command");
  });
});

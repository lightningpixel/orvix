import { afterEach, describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/core/indexer.js";
import { runFind } from "../src/commands/lookupCommands.js";
import { catchUp, reindex } from "../src/core/incremental.js";
import { markDirty, readDirty } from "../src/core/state.js";
import { loadGraph, loadSymbols } from "../src/core/store.js";
import { serialise } from "../src/core/project.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function project(files: Record<string, string>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  await buildIndex(made.root);
  return made.root;
}

async function edit(root: string, path: string, source: string) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, source, "utf8");
  // mtime resolution is coarse enough on some filesystems that a fast
  // rewrite can look unchanged; the size almost always differs, but nudging
  // the clock keeps the test honest rather than lucky.
  await new Promise((done) => setTimeout(done, 12));
}

/** What a query actually reads, as bytes, so two builds can be compared. */
async function hotFiles(root: string) {
  return {
    symbols: serialise(await loadSymbols(root)),
    graph: serialise(await loadGraph(root)),
  };
}

/** Rebuilds from nothing, for comparison against the incremental result. */
async function fromScratch(root: string) {
  await rm(join(root, ".orvix"), { recursive: true, force: true });
  await buildIndex(root);
  return hotFiles(root);
}

const BASE = {
  "src/auth.ts": `export function validate(email: string): boolean {\n  return email.includes("@");\n}\n`,
  "src/login.ts":
    `import { validate } from "./auth";\n` +
    `export function login(email: string) {\n  return validate(email);\n}\n`,
  "src/boot.ts":
    `import { login } from "./login";\nexport function boot() {\n  login("a@b.c");\n}\n`,
};

describe("incremental reindex — invalidation", () => {
  test("a body-only edit does not disturb the caller's edge", async () => {
    const root = await project(BASE);

    await edit(
      root,
      "src/auth.ts",
      `export function validate(email: string): boolean {\n  const at = email.indexOf("@");\n  return at > 0;\n}\n`,
    );
    await reindex(root, ["src/auth.ts"]);

    const graph = await loadGraph(root);
    const table = await loadSymbols(root);
    const validate = table.byName["validate"]![0]!;
    const login = table.byName["login"]![0]!;

    expect(graph.callers[validate]).toContain(login);
  });

  test("renaming an exported symbol removes the stale edge", async () => {
    const root = await project(BASE);
    const before = await loadSymbols(root);
    const oldId = before.byName["validate"]![0]!;

    await edit(
      root,
      "src/auth.ts",
      `export function validateEmail(email: string): boolean {\n  return email.includes("@");\n}\n`,
    );
    await reindex(root, ["src/auth.ts"]);

    const graph = await loadGraph(root);

    // The ghost edge this whole mechanism exists to prevent: login must not
    // still be recorded as calling a symbol that no longer exists.
    expect(graph.callers[oldId]).toBeUndefined();
    for (const callers of Object.values(graph.callers)) {
      expect(callers).not.toContain(oldId);
    }
  });

  test("changing a signature keeps the caller pointing at the new symbol", async () => {
    const root = await project(BASE);

    await edit(
      root,
      "src/auth.ts",
      `export function validate(email: string, strict: boolean): boolean {\n  return email.includes("@") && strict;\n}\n`,
    );
    await reindex(root, ["src/auth.ts"]);

    const table = await loadSymbols(root);
    const graph = await loadGraph(root);
    const validate = table.byName["validate"]![0]!;

    expect(table.symbols[validate]!.signature).toContain("strict");
    expect(graph.callers[validate]).toContain(table.byName["login"]![0]!);
  });

  test("a newly exported name resolves references that were dangling", async () => {
    const root = await project({
      "src/a.ts": `export function useHelper() {\n  return helper();\n}\n`,
      "src/b.ts": `function unrelated() {}\n`,
    });

    const before = await loadGraph(root);
    expect(Object.keys(before.callers)).toHaveLength(0);

    // b.ts now exports the name a.ts was already calling. a.ts is untouched on
    // disk, so only the inverted index can bring it back for re-resolution.
    await edit(root, "src/b.ts", `export function helper() {\n  return 1;\n}\n`);
    await reindex(root, ["src/b.ts"]);

    const table = await loadSymbols(root);
    const graph = await loadGraph(root);
    const helper = table.byName["helper"]![0]!;

    expect(graph.callers[helper]).toContain(table.byName["usehelper"]![0]!);
  });

  test("removing an export leaves no dangling edge behind", async () => {
    const root = await project(BASE);

    await edit(root, "src/auth.ts", `function validate() { return true; }\n`);
    await reindex(root, ["src/auth.ts"]);

    const table = await loadSymbols(root);
    const graph = await loadGraph(root);
    const login = table.byName["login"]![0]!;

    // validate is no longer exported, so login cannot reach it any more.
    for (const [callee, callers] of Object.entries(graph.callers)) {
      if (callers.includes(login)) {
        expect(table.symbols[callee]).toBeDefined();
      }
    }
  });

  test("deleting a file drops its symbols and every edge into them", async () => {
    const root = await project(BASE);
    const before = await loadSymbols(root);
    const validate = before.byName["validate"]![0]!;

    await rm(join(root, "src/auth.ts"));
    const result = await reindex(root, ["src/auth.ts"]);

    const table = await loadSymbols(root);
    const graph = await loadGraph(root);

    expect(result.removed).toEqual(["src/auth.ts"]);
    expect(table.symbols[validate]).toBeUndefined();
    expect(table.byFile["src/auth.ts"]).toBeUndefined();
    expect(graph.callers[validate]).toBeUndefined();
  });

  test("an added file is picked up with its edges", async () => {
    const root = await project(BASE);

    await edit(
      root,
      "src/extra.ts",
      `import { validate } from "./auth";\nexport function extra() {\n  return validate("x");\n}\n`,
    );
    await reindex(root, ["src/extra.ts"]);

    const table = await loadSymbols(root);
    const graph = await loadGraph(root);
    const validate = table.byName["validate"]![0]!;

    expect(table.byName["extra"]).toBeDefined();
    expect(graph.callers[validate]).toContain(table.byName["extra"]![0]!);
  });
});

describe("incremental reindex — agreement with a full rebuild", () => {
  /**
   * The strongest check available: whatever the edit, the two hot files after
   * an incremental catch-up must be byte-identical to what indexing the
   * project from nothing produces. Anything the invalidation rule misses shows
   * up here as a diff.
   *
   * Ranks are the one documented exception — they are not recomputed on the
   * incremental path — so the comparison asks for them to be recomputed.
   */
  async function agrees(
    initial: Record<string, string>,
    change: (root: string) => Promise<string[]>,
  ) {
    const root = await project(initial);
    const touched = await change(root);

    await reindex(root, touched, { rerank: true });
    const incremental = await hotFiles(root);
    const full = await fromScratch(root);

    return { incremental, full };
  }

  test("after a body edit", async () => {
    const { incremental, full } = await agrees(BASE, async (root) => {
      await edit(
        root,
        "src/auth.ts",
        `export function validate(email: string): boolean {\n  return email.length > 3;\n}\n`,
      );
      return ["src/auth.ts"];
    });

    expect(incremental.symbols).toBe(full.symbols);
    expect(incremental.graph).toBe(full.graph);
  });

  test("after a rename", async () => {
    const { incremental, full } = await agrees(BASE, async (root) => {
      await edit(
        root,
        "src/auth.ts",
        `export function check(email: string): boolean {\n  return email.includes("@");\n}\n`,
      );
      return ["src/auth.ts"];
    });

    expect(incremental.symbols).toBe(full.symbols);
    expect(incremental.graph).toBe(full.graph);
  });

  test("after adding a file", async () => {
    const { incremental, full } = await agrees(BASE, async (root) => {
      await edit(
        root,
        "src/extra.ts",
        `import { login } from "./login";\nexport function extra() {\n  return login("z");\n}\n`,
      );
      return ["src/extra.ts"];
    });

    expect(incremental.symbols).toBe(full.symbols);
    expect(incremental.graph).toBe(full.graph);
  });

  test("after deleting a file", async () => {
    const { incremental, full } = await agrees(BASE, async (root) => {
      await rm(join(root, "src/boot.ts"));
      return ["src/boot.ts"];
    });

    expect(incremental.symbols).toBe(full.symbols);
    expect(incremental.graph).toBe(full.graph);
  });

  test("after an export appears that resolves a dangling reference", async () => {
    const { incremental, full } = await agrees(
      {
        "src/a.ts": `export function useHelper() {\n  return helper();\n}\n`,
        "src/b.ts": `function unrelated() {}\n`,
      },
      async (root) => {
        await edit(root, "src/b.ts", `export function helper() {\n  return 1;\n}\n`);
        return ["src/b.ts"];
      },
    );

    expect(incremental.symbols).toBe(full.symbols);
    expect(incremental.graph).toBe(full.graph);
  });

  test("after a sequence of unrelated edits", async () => {
    const { incremental, full } = await agrees(BASE, async (root) => {
      await edit(root, "src/auth.ts", `export function validate() {\n  return true;\n}\n`);
      await edit(
        root,
        "src/login.ts",
        `import { validate } from "./auth";\nexport function login() {\n  return validate();\n}\nexport function extra() {}\n`,
      );
      return ["src/auth.ts", "src/login.ts"];
    });

    expect(incremental.symbols).toBe(full.symbols);
    expect(incremental.graph).toBe(full.graph);
  });
});

describe("incremental reindex — randomised edits", () => {
  /** Deterministic PRNG, so a failure can be replayed from its seed. */
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const NAMES = ["alpha", "beta", "gamma", "delta"];
  const FILES = ["src/one.ts", "src/two.ts", "src/three.ts"];

  /** A file that exports some names and calls some others, at random. */
  function sourceFor(pick: () => number): string {
    const exported = NAMES.filter(() => pick() > 0.5);
    const called = NAMES.filter(() => pick() > 0.6);
    const args = pick() > 0.5 ? "x: number" : "";

    const definitions = exported.map(
      (name) => `export function ${name}(${args}) {\n  return 1;\n}\n`,
    );
    const body = called.map((name) => `  ${name}();`).join("\n");

    return `${definitions.join("")}export function use_${exported.length}_${called.length}() {\n${body}\n  return 0;\n}\n`;
  }

  // Every seed drives a different sequence of renames, signature changes,
  // appearing and disappearing exports, and file deletions. Whatever it does,
  // the incremental result has to match a rebuild from nothing — which is the
  // only check strong enough to catch an edge the invalidation rule forgot.
  for (const seed of [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256]) {
    test(`agrees with a full rebuild for seed ${seed}`, async () => {
      const pick = random(seed);
      const initial: Record<string, string> = {};
      for (const file of FILES) initial[file] = sourceFor(pick);

      const root = await project(initial);

      for (let round = 0; round < 4; round += 1) {
        const target = FILES[Math.floor(pick() * FILES.length)]!;
        const deleting = pick() > 0.85;

        if (deleting) {
          await rm(join(root, target), { force: true });
        } else {
          await edit(root, target, sourceFor(pick));
        }

        await reindex(root, [target], { rerank: true });
      }

      const incremental = await hotFiles(root);
      const full = await fromScratch(root);

      expect(incremental.symbols).toBe(full.symbols);
      expect(incremental.graph).toBe(full.graph);
    });
  }
});

describe("the dirty log", () => {
  test("survives two writers without losing an entry", async () => {
    const root = await project(BASE);

    await Promise.all([
      markDirty(root, ["src/a.ts"]),
      markDirty(root, ["src/b.ts"]),
      markDirty(root, ["src/c.ts"]),
    ]);

    expect((await readDirty(root)).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("reports a path once however often it was marked", async () => {
    const root = await project(BASE);

    await markDirty(root, ["src/a.ts", "src/a.ts"]);
    await markDirty(root, ["src/a.ts"]);

    expect(await readDirty(root)).toEqual(["src/a.ts"]);
  });

  test("catchUp reindexes what the log names and then empties it", async () => {
    const root = await project(BASE);

    await edit(root, "src/auth.ts", `export function validate() {\n  return false;\n}\n`);
    await markDirty(root, ["src/auth.ts"]);

    const result = await catchUp(root);

    expect(result?.reindexed).toEqual(["src/auth.ts"]);
    expect(await readDirty(root)).toEqual([]);
  });

  test("catchUp does nothing when the log is empty", async () => {
    const root = await project(BASE);

    expect(await catchUp(root)).toBeUndefined();
  });

  test("a query catches up dirty files before answering", async () => {
    // The end-to-end contract of the incremental design: the hook only marks
    // the file, and the next query is what pays to bring it up to date.
    const root = await project(BASE);

    await edit(
      root,
      "src/auth.ts",
      `export function validateThoroughly(email: string): boolean {\n  return email.includes("@");\n}\n`,
    );
    await markDirty(root, ["src/auth.ts"]);

    const { output } = await runFind(root, "validateThoroughly");

    expect(output).toContain("validateThoroughly");
    expect(await readDirty(root)).toEqual([]);
  });

  test("a query on a clean project leaves the index untouched", async () => {
    const root = await project(BASE);
    const before = await hotFiles(root);

    await runFind(root, "validate");

    expect(await hotFiles(root)).toEqual(before);
  });
});

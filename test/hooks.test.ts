import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildIndex } from "../src/core/indexer.js";
import { supportedExtensions } from "../src/core/languages.js";
import { readDirty } from "../src/core/state.js";
import { loadSymbols } from "../src/core/store.js";
import { makeProject } from "./helpers/tmpProject.js";

const HOOKS = resolve("hooks");

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Runs a hook exactly as the agent does: JSON on stdin, JSON on stdout. */
function runHook(script: string, payload: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      process.execPath,
      [join(HOOKS, script)],
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

/** A file long enough to clear the compressor's size guard. */
function longSource(): string {
  const parts: string[] = [];
  for (let n = 0; n < 40; n += 1) {
    parts.push(
      `export function handler${n}(input: string): string {\n` +
        `  const trimmed = input.trim();\n  const upper = trimmed.toUpperCase();\n` +
        `  const padded = upper.padEnd(20, ".");\n  return padded;\n}\n`,
    );
  }
  return parts.join("");
}

async function project(files: Record<string, string>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  await buildIndex(made.root);
  return made.root;
}

describe("orvix-dirty", () => {
  test("marks an edited source file", async () => {
    const root = await project({ "src/a.ts": `export function a() {}\n` });

    await runHook("orvix-dirty.mjs", {
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src/a.ts") },
    });

    expect(await readDirty(root)).toEqual(["src/a.ts"]);
  });

  test("marks a file in every language orvix indexes", async () => {
    // The hook carries its own extension list, since it may import nothing
    // but node:*. It fell behind once: Java, C#, C++ and C edits went
    // unmarked and queries answered from the stale index.
    const root = await project({ "src/a.ts": `export function a() {}
` });
    const expected = supportedExtensions().map((ext) => `src/f${ext}`);

    for (const path of expected) {
      await runHook("orvix-dirty.mjs", {
        cwd: root,
        tool_name: "Write",
        tool_input: { file_path: join(root, path) },
      });
    }

    expect(await readDirty(root)).toEqual(expected);
  });

  test("ignores a file in a language orvix does not index", async () => {
    const root = await project({ "src/a.ts": `export function a() {}\n` });

    await runHook("orvix-dirty.mjs", {
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: join(root, "notes.md") },
    });

    expect(await readDirty(root)).toEqual([]);
  });

  test("ignores a file outside the project", async () => {
    const root = await project({ "src/a.ts": `export function a() {}\n` });

    await runHook("orvix-dirty.mjs", {
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: resolve(root, "..", "elsewhere.ts") },
    });

    expect(await readDirty(root)).toEqual([]);
  });

  test("says nothing on stdout, so it can never alter a tool result", async () => {
    const root = await project({ "src/a.ts": `export function a() {}\n` });

    const out = await runHook("orvix-dirty.mjs", {
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src/a.ts") },
    });

    expect(out).toBe("");
  });

  test("survives a malformed payload", async () => {
    const root = await project({ "src/a.ts": `export function a() {}\n` });

    await expect(runHook("orvix-dirty.mjs", { cwd: root })).resolves.toBe("");
  });
});

describe("orvix-compress — Read", () => {
  async function read(root: string, path: string, extra: Record<string, unknown> = {}) {
    const content = await readFile(join(root, path), "utf8");
    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: join(root, path), ...extra },
      tool_response: { file: { content } },
    });
    return out.trim() === "" ? undefined : JSON.parse(out);
  }

  // Claude Code validates updatedToolOutput against the tool's own output
  // shape and discards a mismatch, saying so in the transcript and keeping the
  // original. Returning a bare string meant every compression of a tool whose
  // result is an object — Read, Grep, Bash — was silently thrown away.
  test("returns the replacement in the shape the tool's result had", async () => {
    const root = await project({ "src/big.ts": longSource() });

    const output = (await read(root, "src/big.ts")).hookSpecificOutput
      .updatedToolOutput;

    expect(typeof output).toBe("object");
    expect(typeof output.file.content).toBe("string");
    expect(output.file.content).toContain("body elided by orvix");
  });

  test("replaces a long indexed file with its symbol map", async () => {
    const root = await project({ "src/big.ts": longSource() });

    const result = await read(root, "src/big.ts");
    const output = result.hookSpecificOutput.updatedToolOutput.file.content;

    expect(output).toContain("src/big.ts");
    expect(output).toContain("handler0");
    // The bodies are what it exists to remove.
    expect(output).not.toContain("padEnd(20");
  });

  test("always leaves a way back to the real source", async () => {
    const root = await project({ "src/big.ts": longSource() });

    const output = (await read(root, "src/big.ts")).hookSpecificOutput
      .updatedToolOutput.file.content;

    expect(output).toContain("orvix show");
    expect(output).toMatch(/read this file again|offset/);
  });

  test("leaves a ranged read alone", async () => {
    const root = await project({ "src/big.ts": longSource() });

    expect(await read(root, "src/big.ts", { offset: 10, limit: 20 })).toBeUndefined();
  });

  test("leaves a short file alone", async () => {
    const root = await project({ "src/small.ts": `export function a() {\n  return 1;\n}\n` });

    expect(await read(root, "src/small.ts")).toBeUndefined();
  });

  test("leaves a file it has not indexed alone", async () => {
    // The carve-out the instruction block already documents: configuration,
    // markdown and data are for reading, not for symbol lookup.
    const root = await project({ "src/a.ts": `export function a() {}\n` });
    await writeFile(join(root, "data.json"), `{"a":${"1,".repeat(4000)}0}`, "utf8");

    expect(await read(root, "data.json")).toBeUndefined();
  });

  test("returns the real file the second time it is asked", async () => {
    // Asking twice is the clearest signal that the map was not what was wanted.
    const root = await project({ "src/big.ts": longSource() });

    expect(await read(root, "src/big.ts")).toBeDefined();
    expect(await read(root, "src/big.ts")).toBeUndefined();
  });

  test("nudges towards orvix once per session and then stays quiet", async () => {
    const root = await project({
      "src/big.ts": longSource(),
      "src/other.ts": longSource(),
    });

    const first = await read(root, "src/big.ts");
    const second = await read(root, "src/other.ts");

    expect(first.hookSpecificOutput.additionalContext).toContain("orvix show");
    expect(second.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("does nothing when the project has never been indexed", async () => {
    const made = await makeProject({ "src/big.ts": longSource() });
    cleanup = made.cleanup;

    const content = await readFile(join(made.root, "src/big.ts"), "utf8");
    const out = await runHook("orvix-compress.mjs", {
      cwd: made.root,
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: join(made.root, "src/big.ts") },
      tool_response: { file: { content } },
    });

    expect(out.trim()).toBe("");
  });

  test("passes through a response shape it does not recognise", async () => {
    const root = await project({ "src/big.ts": longSource() });

    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: join(root, "src/big.ts") },
      tool_response: { something: { unexpected: true } },
    });

    expect(out.trim()).toBe("");
  });

  test("records what it saved", async () => {
    const root = await project({ "src/big.ts": longSource() });

    await read(root, "src/big.ts");
    const log = await readFile(join(root, ".orvix", "gain.jsonl"), "utf8");
    const entry = JSON.parse(log.trim().split("\n")[0]!);

    expect(entry.tool).toBe("Read");
    expect(entry.after).toBeLessThan(entry.before);
  });

  // A cache written by another version of orvix parses as JSON but need not
  // hold the shape this version expects. The hook runs on every tool call, so
  // whatever it cannot use it must leave alone — never fail the turn over it.
  test("leaves the result alone when the cache has an unexpected shape", async () => {
    const root = await project({ "src/big.ts": longSource() });

    await writeFile(
      join(root, ".orvix", "symbols.json"),
      JSON.stringify({ version: 1, symbols: {}, byFile: { "src/big.ts": "not-an-array" } }),
      "utf8",
    );

    const content = await readFile(join(root, "src/big.ts"), "utf8");
    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: join(root, "src/big.ts") },
      tool_response: { file: { content } },
    });

    expect(out.trim()).toBe("");
  });
});

describe("orvix-compress — Grep", () => {
  // The shape Grep actually returns, taken from a recorded session. The fixture
  // used to be a bare string, which is why nothing caught that a string handed
  // back was rejected by Claude Code and the compression discarded.
  async function grep(root: string, output: string) {
    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "s1",
      tool_name: "Grep",
      tool_input: { pattern: "handler" },
      tool_response: {
        mode: "content",
        numFiles: 0,
        filenames: [],
        content: output,
        numLines: output.split("\n").length,
        totalLines: output.split("\n").length,
      },
    });
    if (out.trim() === "") return undefined;
    const parsed = JSON.parse(out);
    const replaced = parsed.hookSpecificOutput.updatedToolOutput;
    if (typeof replaced !== "object" || typeof replaced.content !== "string") {
      throw new Error(`Grep replacement must keep Grep's shape, got ${typeof replaced}`);
    }
    // Flattened so the assertions below read the text, not the envelope.
    parsed.hookSpecificOutput.updatedToolOutput = replaced.content;
    return parsed;
  }

  test("collapses many hits into the few symbols containing them", async () => {
    // Where this earns its keep: a search that hits the same handful of
    // functions over and over. Eight hits in eight distinct symbols has
    // nothing to collapse, and the size guard correctly refuses that case.
    const root = await project({ "src/big.ts": longSource() });
    const table = await loadSymbols(root);
    const ids = table.byFile["src/big.ts"]!.slice(0, 3);

    const hits: string[] = [];
    for (const id of ids) {
      const symbol = table.symbols[id]!;
      for (let line = symbol.startLine; line <= symbol.endLine; line += 1) {
        hits.push(
          `${join(root, "src/big.ts")}:${line}:  const trimmed = input.trim(); // matched here`,
        );
      }
    }

    const output = (await grep(root, hits.join("\n"))).hookSpecificOutput
      .updatedToolOutput;

    expect(output).toContain("symbols contain the matches");
    expect(output).toContain("src/big.ts");
    // Three symbols stand in for every hit inside them.
    expect(output).toContain("3 symbols");
  });

  test("leaves a search alone when the hits are not symbols", async () => {
    // A string literal or a config key. grep is the right tool; stay out of it.
    const root = await project({ "src/big.ts": longSource() });

    const hits = Array.from(
      { length: 8 },
      (_, n) => `${join(root, "README.md")}:${n + 1}:some prose mentioning handler`,
    ).join("\n");

    expect(await grep(root, hits)).toBeUndefined();
  });

  test("leaves a handful of hits alone", async () => {
    const root = await project({ "src/big.ts": longSource() });

    expect(await grep(root, `${join(root, "src/big.ts")}:1:export function handler0`)).toBeUndefined();
  });
});

/** Hits spread across the first `count` symbols of a file, as a search prints them. */
async function hitsFor(root: string, count: number) {
  const table = await loadSymbols(root);
  const ids = table.byFile["src/big.ts"]!.slice(0, count);
  const lines: string[] = [];

  for (const id of ids) {
    const symbol = table.symbols[id]!;
    for (let line = symbol.startLine; line <= symbol.endLine; line += 1) {
      lines.push(
        `${join(root, "src/big.ts")}:${line}:  const trimmed = input.trim(); // matched here`,
      );
    }
  }

  return lines.join("\n");
}

describe("orvix-compress — searches run through Bash", () => {
  // Bash returns an object too, not the bare string this fixture used to send.
  async function bash(root: string, command: string, output: string) {
    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: {
        stdout: output,
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    });
    if (out.trim() === "") return undefined;
    const parsed = JSON.parse(out);
    const replaced = parsed.hookSpecificOutput.updatedToolOutput;
    if (typeof replaced !== "object" || typeof replaced.stdout !== "string") {
      throw new Error(`Bash replacement must keep Bash's shape, got ${typeof replaced}`);
    }
    parsed.hookSpecificOutput.updatedToolOutput = replaced.stdout;
    return parsed;
  }

  test("compresses ripgrep output", async () => {
    // The route half of real searches take. Leaving it out was the largest
    // hole in the coverage.
    const root = await project({ "src/big.ts": longSource() });

    const result = await bash(root, "rg 'trimmed' src/", await hitsFor(root, 3));

    expect(result.hookSpecificOutput.updatedToolOutput).toContain(
      "symbols contain the matches",
    );
  });

  test("compresses grep output", async () => {
    const root = await project({ "src/big.ts": longSource() });

    const result = await bash(root, "grep -rn trimmed src/", await hitsFor(root, 3));

    expect(result.hookSpecificOutput.updatedToolOutput).toContain("src/big.ts");
  });

  test("leaves a command that is not a search alone", async () => {
    // Cheap early exit: another tool's hook may be on this event too, and a
    // build log must pass through untouched.
    const root = await project({ "src/big.ts": longSource() });

    expect(await bash(root, "npm test", await hitsFor(root, 3))).toBeUndefined();
  });

  test("leaves search output that is not symbols alone", async () => {
    const root = await project({ "src/big.ts": longSource() });
    const prose = Array.from(
      { length: 8 },
      (_, n) => `${join(root, "README.md")}:${n + 1}:some prose`,
    ).join("\n");

    expect(await bash(root, "rg prose", prose)).toBeUndefined();
  });
});

describe("orvix-compress — configuration", () => {
  async function readWith(root: string, config?: Record<string, unknown>) {
    if (config) {
      await mkdir(join(root, ".orvix"), { recursive: true });
      await writeFile(
        join(root, ".orvix", "config.json"),
        JSON.stringify(config),
        "utf8",
      );
    }

    const content = await readFile(join(root, "src/big.ts"), "utf8");
    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "cfg",
      tool_name: "Read",
      tool_input: { file_path: join(root, "src/big.ts") },
      tool_response: { file: { content } },
    });
    return out.trim() === "" ? undefined : JSON.parse(out);
  }

  test("compresses reads by default", async () => {
    const root = await project({ "src/big.ts": longSource() });

    expect(await readWith(root)).toBeDefined();
  });

  test("compressRead: false turns read compression off", async () => {
    // The off switch a user needs when the trade does not suit them, without
    // having to understand the agent's hook configuration.
    const root = await project({ "src/big.ts": longSource() });

    expect(await readWith(root, { compressRead: false })).toBeUndefined();
  });

  test("compressSearch: false leaves searches alone", async () => {
    const root = await project({ "src/big.ts": longSource() });
    await mkdir(join(root, ".orvix"), { recursive: true });
    await writeFile(
      join(root, ".orvix", "config.json"),
      JSON.stringify({ compressSearch: false }),
      "utf8",
    );

    const out = await runHook("orvix-compress.mjs", {
      cwd: root,
      session_id: "cfg",
      tool_name: "Grep",
      tool_input: { pattern: "trimmed" },
      tool_response: await hitsFor(root, 3),
    });

    expect(out.trim()).toBe("");
  });

  test("ignores a malformed config rather than refusing to work", async () => {
    const root = await project({ "src/big.ts": longSource() });
    await mkdir(join(root, ".orvix"), { recursive: true });
    await writeFile(join(root, ".orvix", "config.json"), "{ broken", "utf8");

    expect(await readWith(root)).toBeDefined();
  });
});

describe("orvix-compress — session memory", () => {
  test("does not grow across sessions", async () => {
    // It is read in full on every tool call, so an append-only log kept across
    // sessions would slow the hot path down for ever, invisibly.
    const root = await project({
      "src/big.ts": longSource(),
      "src/other.ts": longSource(),
    });

    const read = async (session: string, path: string) => {
      const content = await readFile(join(root, path), "utf8");
      await runHook("orvix-compress.mjs", {
        cwd: root,
        session_id: session,
        tool_name: "Read",
        tool_input: { file_path: join(root, path) },
        tool_response: { file: { content } },
      });
    };

    await read("s1", "src/big.ts");
    await read("s1", "src/other.ts");
    const afterFirst = await readFile(join(root, ".orvix", "session.log"), "utf8");

    await read("s2", "src/big.ts");
    const afterSecond = await readFile(join(root, ".orvix", "session.log"), "utf8");

    expect(afterFirst).toContain("src/other.ts");
    expect(afterSecond).not.toContain("src/other.ts");
    expect(afterSecond.split("\n")[0]).toBe("s2");
  });

  test("a new session sees a file it may compress again", async () => {
    const root = await project({ "src/big.ts": longSource() });

    const read = async (session: string) => {
      const content = await readFile(join(root, "src/big.ts"), "utf8");
      const out = await runHook("orvix-compress.mjs", {
        cwd: root,
        session_id: session,
        tool_name: "Read",
        tool_input: { file_path: join(root, "src/big.ts") },
        tool_response: { file: { content } },
      });
      return out.trim() !== "";
    };

    expect(await read("s1")).toBe(true);
    expect(await read("s1")).toBe(false);
    expect(await read("s2")).toBe(true);
  });
});

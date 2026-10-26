import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { orvixHooks } from "../src/agents/claudeHooks.js";
import { buildIndex } from "../src/core/indexer.js";
import { makeProject } from "./helpers/tmpProject.js";

const HOOKS = resolve("hooks");

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function runHook(script: string, payload: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(process.execPath, [join(HOOKS, script)], (error, stdout) =>
      error ? fail(error) : done(stdout),
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

/** Too short for the symbol map, long enough that re-sending it costs something. */
function mediumSource(marker = "original"): string {
  const lines = [`export const marker = "${marker}";`];
  for (let n = 0; n < 60; n += 1) lines.push(`export const value${n} = ${n} * 2; // filler line ${n}`);
  return `${lines.join("\n")}\n`;
}

/** Long enough for the map, so the first read is compressed differently. */
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

async function project(files: Record<string, string>, config?: Record<string, unknown>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  await buildIndex(made.root);
  if (config) {
    await mkdir(join(made.root, ".orvix"), { recursive: true });
    await writeFile(join(made.root, ".orvix", "config.json"), JSON.stringify(config));
  }
  return made.root;
}

async function read(
  root: string,
  path: string,
  options: { session?: string; extra?: Record<string, unknown> } = {},
): Promise<string | undefined> {
  const content = await readFile(join(root, path), "utf8");
  const out = await runHook("orvix-compress.mjs", {
    cwd: root,
    session_id: options.session ?? "s1",
    tool_name: "Read",
    tool_input: { file_path: join(root, path), ...options.extra },
    tool_response: { type: "text", file: { filePath: join(root, path), content } },
  });
  if (out.trim() === "") return undefined;
  return JSON.parse(out).hookSpecificOutput.updatedToolOutput.file.content as string;
}

async function rewrite(root: string, path: string, source: string) {
  await writeFile(join(root, path), source, "utf8");
}

describe("orvix-compress — reading a file again", () => {
  test("delivers a file in full the first time", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    expect(await read(root, "src/a.ts")).toBeUndefined();
  });

  test("answers an unchanged re-read with a note instead of the text", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");
    const again = await read(root, "src/a.ts");

    expect(again).toMatch(/unchanged since you read it/i);
    expect(again).not.toContain("filler line 30");
  });

  test("sends the real text when asked a third time", async () => {
    // A note followed by another read means the text really is wanted.
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");
    await read(root, "src/a.ts");

    expect(await read(root, "src/a.ts")).toBeUndefined();
  });

  test("sends only the changed lines after a small edit", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");
    await rewrite(root, "src/a.ts", mediumSource().replace("filler line 30", "edited line 30"));
    const again = await read(root, "src/a.ts");

    expect(again).toContain("edited line 30");
    expect(again).toContain("32"); // the line number, as Read numbers lines
    expect(again).not.toContain("filler line 50");
  });

  test("sends the whole file again after a large edit", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");
    await rewrite(root, "src/a.ts", mediumSource().replace(/filler/g, "rewritten"));

    expect(await read(root, "src/a.ts")).toBeUndefined();
  });

  test("never answers a ranged read from memory", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");

    expect(await read(root, "src/a.ts", { extra: { offset: 1, limit: 10 } })).toBeUndefined();
  });

  test("does not count a ranged read as having seen the file", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts", { extra: { offset: 1, limit: 10 } });

    expect(await read(root, "src/a.ts")).toBeUndefined();
  });

  test("forgets everything in a new session", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts", { session: "s1" });

    expect(await read(root, "src/a.ts", { session: "s2" })).toBeUndefined();
  });

  test("forgets everything when the context is compacted", async () => {
    // After compaction the model no longer holds the text; saying it does
    // would leave it with nothing.
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");
    await runHook("orvix-compact.mjs", { cwd: root, session_id: "s1", hook_event_name: "PreCompact" });

    expect(await read(root, "src/a.ts")).toBeUndefined();
  });

  test("goes from the map, to the real text, to a note", async () => {
    const root = await project({ "src/big.ts": longSource() });

    expect(await read(root, "src/big.ts")).toContain("body elided by orvix");
    expect(await read(root, "src/big.ts")).toBeUndefined();
    expect(await read(root, "src/big.ts")).toMatch(/unchanged since you read it/i);
  });

  test("can be turned off from .orvix/config.json", async () => {
    const root = await project({ "src/a.ts": mediumSource() }, { rememberReads: false });

    await read(root, "src/a.ts");

    expect(await read(root, "src/a.ts")).toBeUndefined();
  });

  test("records the saving", async () => {
    const root = await project({ "src/a.ts": mediumSource() });

    await read(root, "src/a.ts");
    await read(root, "src/a.ts");
    const log = await readFile(join(root, ".orvix", "gain.jsonl"), "utf8");

    expect(log.trim().split("\n")).toHaveLength(1);
  });
});

describe("orvix-compact", () => {
  test("is registered before compaction", () => {
    const entry = orvixHooks()["PreCompact"]?.[0];

    expect(entry?.hooks[0]?.command).toContain("orvix-compact.mjs");
  });

  test("survives a malformed payload", async () => {
    await expect(runHook("orvix-compact.mjs", { nonsense: true })).resolves.toBe("");
  });
});

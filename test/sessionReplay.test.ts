import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIndex } from "../src/core/indexer.js";
import { replaySession } from "../scripts/session-replay.mjs";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function longSource(): string {
  const parts: string[] = [];
  // Bodies long enough that the symbol map is clearly smaller than the file,
  // or the hook rightly declines to swap one for the other.
  for (let n = 0; n < 30; n += 1) {
    const body = Array.from(
      { length: 10 },
      (_, line) => `  const step${line} = input.trim().padEnd(${line + 20}, ".").toUpperCase();\n`,
    ).join("");
    parts.push(`export function handler${n}(input: string): string {\n${body}  return input;\n}\n`);
  }
  return parts.join("");
}

async function indexed() {
  const made = await makeProject({ "src/big.ts": longSource() });
  cleanup = made.cleanup;
  await buildIndex(made.root);
  return made.root;
}

const usage = (input: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 10,
});

/** The entries Claude Code writes, cut down to what the replay reads. */
function transcript(root: string, content: string): string {
  const path = join(root, "src/big.ts");
  const entries = [
    { type: "user", message: { role: "user", content: "Look at big.ts" } },
    {
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        usage: usage(1000),
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path } }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
      toolUseResult: { type: "text", file: { filePath: path, content } },
    },
    // One API response written as two entries: counted once.
    { type: "assistant", message: { id: "m2", role: "assistant", usage: usage(2000), content: [{ type: "text", text: "a" }] } },
    { type: "assistant", message: { id: "m2", role: "assistant", usage: usage(2000), content: [{ type: "text", text: "b" }] } },
    { type: "assistant", message: { id: "m3", role: "assistant", usage: usage(2500), content: [{ type: "text", text: "c" }] } },
    { type: "system", subtype: "compact_boundary" },
    // After compaction the result is gone from the context, saved or not.
    { type: "assistant", message: { id: "m4", role: "assistant", usage: usage(500), content: [{ type: "text", text: "d" }] } },
    "not json at all",
  ];
  return entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n");
}

describe("replaySession", () => {
  test("counts each API call once, from its recorded usage", async () => {
    const root = await indexed();
    const content = await readFile(join(root, "src/big.ts"), "utf8");

    const report = replaySession(transcript(root, content), { root });

    expect(report.apiCalls).toBe(4);
    expect(report.sessionInput).toBe(1000 + 2000 + 2500 + 500);
  });

  test("compresses tool results through the real hook", async () => {
    const root = await indexed();
    const content = await readFile(join(root, "src/big.ts"), "utf8");

    const report = replaySession(transcript(root, content), { root });

    expect(report.toolResults).toBe(1);
    expect(report.compressed).toBe(1);
    expect(report.savedOnce).toBeGreaterThan(0);
  });

  test("charges a saving once per later call, until compaction", async () => {
    const root = await indexed();
    const content = await readFile(join(root, "src/big.ts"), "utf8");

    const report = replaySession(transcript(root, content), { root });

    // Seen by m2 and m3; m4 comes after the compaction boundary.
    expect(report.savedCumulative).toBe(report.savedOnce * 2);
  });

  test("leaves the project's own session memory alone", async () => {
    // A live session in the same project keeps its memory in .orvix/; a
    // replay writing there would make that session forget what it read.
    const root = await indexed();
    const content = await readFile(join(root, "src/big.ts"), "utf8");

    replaySession(transcript(root, content), { root });

    expect(existsSync(join(root, ".orvix", "session.log"))).toBe(false);
    expect(existsSync(join(root, ".orvix", "gain.jsonl"))).toBe(false);
  });

  test("reports nothing saved on a project with no index", async () => {
    const made = await makeProject({ "src/big.ts": longSource() });
    cleanup = made.cleanup;
    const content = await readFile(join(made.root, "src/big.ts"), "utf8");

    const report = replaySession(transcript(made.root, content), { root: made.root });

    expect(report.compressed).toBe(0);
    expect(report.savedCumulative).toBe(0);
  });
});

import { describe, expect, test } from "vitest";
import { AGENTS, agentById, targetFiles } from "../src/agents/registry.js";
import {
  BLOCK_END,
  BLOCK_START,
  instructionBlock,
  upsertBlock,
} from "../src/agents/block.js";

describe("registry", () => {
  test("knows the agents Orvix supports", () => {
    expect(AGENTS.map((a) => a.id).sort()).toEqual([
      "claude",
      "codex",
      "cursor",
      "gemini",
    ]);
  });

  test("maps each agent to the file it reads", () => {
    expect(agentById("claude")?.file).toBe("CLAUDE.md");
    expect(agentById("codex")?.file).toBe("AGENTS.md");
    expect(agentById("gemini")?.file).toBe("GEMINI.md");
  });

  test("returns undefined for an unknown agent", () => {
    expect(agentById("emacs")).toBeUndefined();
  });

  test("collapses agents that read the same file", () => {
    // Codex and Cursor both read AGENTS.md; it must be written once.
    expect(targetFiles(["codex", "cursor"])).toEqual(["AGENTS.md"]);
  });

  test("keeps distinct files for distinct agents, in a stable order", () => {
    expect(targetFiles(["gemini", "claude"])).toEqual(["CLAUDE.md", "GEMINI.md"]);
  });

  test("ignores unknown agent names", () => {
    expect(targetFiles(["claude", "emacs"])).toEqual(["CLAUDE.md"]);
  });
});

describe("instructionBlock", () => {
  const block = instructionBlock();

  test("is delimited by markers so it can be found again", () => {
    expect(block.startsWith(BLOCK_START)).toBe(true);
    expect(block.trimEnd().endsWith(BLOCK_END)).toBe(true);
  });

  test("names every command an agent needs", () => {
    for (const command of ["orvix map", "orvix show", "orvix find", "orvix who-calls", "orvix calls", "orvix impact"]) {
      expect(block).toContain(command);
    }
  });

  test("names every indexed language, so none is sent back to grep", () => {
    // The block once stopped at Rust while Java, C#, C++ and C were indexed,
    // telling agents to read those files directly.
    for (const language of ["TypeScript", "Python", "Go", "Rust", "Java", "C#", "C++"]) {
      expect(block).toContain(language);
    }
    // Plain C, as a word of its own rather than the start of C# or C++.
    expect(block).toMatch(/\bC(?![#+\w])/);
  });

  test("teaches the focused map", () => {
    expect(block).toContain("orvix map --focus");
  });

  test("says when not to use orvix", () => {
    // Without this an agent will run `orvix show` on a JSON file, get nothing,
    // and conclude the tool is broken.
    expect(block).toMatch(/grep/i);
    expect(block).toMatch(/read (those|them) directly/i);
  });
});

describe("upsertBlock", () => {
  const block = instructionBlock();

  test("writes the block into an empty document", () => {
    expect(upsertBlock("", block)).toContain(BLOCK_START);
  });

  test("appends without disturbing existing content", () => {
    const existing = "# My project\n\nSome notes.\n";

    const result = upsertBlock(existing, block);

    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain(BLOCK_START);
  });

  test("replaces the block instead of adding a second one", () => {
    const once = upsertBlock("# Doc\n", block);

    const twice = upsertBlock(once, block);

    expect(twice).toBe(once);
    expect(twice.split(BLOCK_START)).toHaveLength(2);
  });

  test("updates a stale block in place", () => {
    const stale = `# Doc\n\n${BLOCK_START}\nold instructions\n${BLOCK_END}\n\n## After\n`;

    const result = upsertBlock(stale, block);

    expect(result).not.toContain("old instructions");
    expect(result).toContain("orvix map");
  });

  test("preserves content that follows the block", () => {
    const stale = `# Doc\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\n## Keep me\n\nText.\n`;

    const result = upsertBlock(stale, block);

    expect(result).toContain("## Keep me");
    expect(result.trimEnd().endsWith("Text.")).toBe(true);
  });

  test("separates the block from a document with no trailing newline", () => {
    const result = upsertBlock("# Doc", block);

    expect(result).toContain(`# Doc\n\n${BLOCK_START}`);
  });

  test("always ends with a single newline", () => {
    for (const input of ["", "# Doc", "# Doc\n", "# Doc\n\n\n"]) {
      const result = upsertBlock(input, block);
      expect(result.endsWith("\n"), JSON.stringify(input)).toBe(true);
      expect(result.endsWith("\n\n"), JSON.stringify(input)).toBe(false);
    }
  });
});

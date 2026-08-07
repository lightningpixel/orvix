import { describe, expect, test } from "vitest";
import { AGENTS } from "../src/agents/registry.js";
import { parseAgentSelection } from "../src/commands/prompt.js";

const parse = (answer: string) => parseAgentSelection(answer, AGENTS);

describe("parseAgentSelection", () => {
  test("reads a single number from the menu", () => {
    expect(parse("1")).toEqual([AGENTS[0]!.id]);
  });

  test("reads several numbers", () => {
    expect(parse("1,2")).toEqual([AGENTS[0]!.id, AGENTS[1]!.id]);
  });

  test("tolerates spaces and stray separators", () => {
    expect(parse("  1 , 2 ,")).toEqual([AGENTS[0]!.id, AGENTS[1]!.id]);
  });

  test("accepts space-separated numbers", () => {
    expect(parse("1 2")).toEqual([AGENTS[0]!.id, AGENTS[1]!.id]);
  });

  test("accepts agent names as well as numbers", () => {
    expect(parse("claude, gemini")).toEqual(["claude", "gemini"]);
  });

  test("is case-insensitive on names", () => {
    expect(parse("Claude")).toEqual(["claude"]);
  });

  test("drops numbers outside the menu", () => {
    expect(parse("1,99")).toEqual([AGENTS[0]!.id]);
  });

  test("drops names it does not know", () => {
    expect(parse("claude, emacs")).toEqual(["claude"]);
  });

  test("does not repeat an agent named twice", () => {
    expect(parse("1, claude")).toEqual(["claude"]);
  });

  test("returns nothing for empty input, so the caller can default", () => {
    expect(parse("")).toEqual([]);
    expect(parse("   ")).toEqual([]);
  });
});

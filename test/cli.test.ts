import { describe, expect, test } from "vitest";
import { buildCli } from "../src/cli.js";
import pkg from "../package.json" with { type: "json" };

describe("cli", () => {
  test("exposes the package version", () => {
    expect(buildCli().version()).toBe(pkg.version);
  });

  test("registers the v1 commands", () => {
    const names = buildCli()
      .commands.map((c) => c.name())
      .sort();

    expect(names).toEqual([
      "calls",
      "find",
      "index",
      "init",
      "map",
      "show",
      "who-calls",
    ]);
  });
});

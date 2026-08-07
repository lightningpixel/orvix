import { describe, expect, test } from "vitest";
import {
  displayLength,
  hashIdentity,
  resolveId,
  symbolIdentity,
} from "../src/core/ids.js";
import type { RawSymbol } from "../src/types.js";

function symbol(overrides: Partial<RawSymbol> = {}): RawSymbol {
  return {
    name: "validate",
    kind: "function",
    signature: "function validate(email: string): boolean",
    startLine: 10,
    endLine: 20,
    startByte: 100,
    endByte: 400,
    exported: true,
    ...overrides,
  };
}

const idOf = (file: string, overrides: Partial<RawSymbol> = {}) =>
  hashIdentity(symbolIdentity(file, symbol(overrides)));

describe("symbol identity", () => {
  test("survives an edit to the symbol's body", () => {
    const before = idOf("src/auth.ts");
    const after = idOf("src/auth.ts", {
      startLine: 40,
      endLine: 90,
      startByte: 900,
      endByte: 2000,
      signature: "function validate(email: string, strict: boolean): boolean",
    });

    expect(after).toBe(before);
  });

  test("changes when the symbol is renamed", () => {
    expect(idOf("src/auth.ts", { name: "check" })).not.toBe(
      idOf("src/auth.ts"),
    );
  });

  test("changes when the file moves", () => {
    expect(idOf("src/login.ts")).not.toBe(idOf("src/auth.ts"));
  });

  test("changes when the kind changes", () => {
    expect(idOf("src/auth.ts", { kind: "method" })).not.toBe(
      idOf("src/auth.ts"),
    );
  });

  test("distinguishes same-named methods of different classes", () => {
    const a = idOf("src/a.ts", { kind: "method", container: "Login" });
    const b = idOf("src/a.ts", { kind: "method", container: "Signup" });

    expect(a).not.toBe(b);
  });

  test("is deterministic", () => {
    expect(idOf("src/auth.ts")).toBe(idOf("src/auth.ts"));
  });

  test("produces a fixed-width lowercase base36 id", () => {
    expect(idOf("src/auth.ts")).toMatch(/^[0-9a-z]{12}$/);
  });

  test("hashes a known identity to a fixed value", () => {
    // Pinned on purpose. Ids are handed to agents and quoted back on later
    // turns, so changing the hash silently would invalidate every cached id
    // across an Orvix upgrade. Breaking this test means a breaking release.
    expect(hashIdentity("src/auth.ts::LoginService.validate::method")).toBe(
      "18dryk9kmf6v",
    );
  });
});

describe("displayLength", () => {
  test("uses four characters when that is unambiguous", () => {
    expect(displayLength(["abcdef", "ghijkl", "mnopqr"])).toBe(4);
  });

  test("grows just enough to separate colliding prefixes", () => {
    expect(displayLength(["abcd11", "abcd22"])).toBe(5);
    expect(displayLength(["abcde1", "abcde2"])).toBe(6);
  });

  test("never goes below four even for a tiny project", () => {
    expect(displayLength(["a1b2c3"])).toBe(4);
  });

  test("handles an empty project", () => {
    expect(displayLength([])).toBe(4);
  });

  test("does not widen to the maximum when an id appears twice", () => {
    // Two symbols can legitimately share an identity — a getter/setter pair,
    // an overload set. That must not push every id in the project to full
    // width, which would make the map far more expensive to read.
    expect(displayLength(["abcdefgh", "abcdefgh", "zzzzzzzz"])).toBe(4);
  });
});

describe("resolveId", () => {
  const ids = ["abcd11", "abcd22", "ffff99"];

  test("resolves an unambiguous prefix", () => {
    expect(resolveId(ids, "ff")).toEqual({ status: "found", id: "ffff99" });
  });

  test("resolves a full id", () => {
    expect(resolveId(ids, "abcd11")).toEqual({ status: "found", id: "abcd11" });
  });

  test("reports every candidate when a prefix is ambiguous", () => {
    expect(resolveId(ids, "abcd")).toEqual({
      status: "ambiguous",
      matches: ["abcd11", "abcd22"],
    });
  });

  test("reports an unknown prefix", () => {
    expect(resolveId(ids, "zz")).toEqual({ status: "unknown" });
  });

  test("is case-insensitive", () => {
    expect(resolveId(ids, "FF")).toEqual({ status: "found", id: "ffff99" });
  });

  test("a prefix stays valid after the display length grows", () => {
    // An id quoted as "ffff" in an earlier turn must still resolve once the
    // project grows and ids are shown with more characters.
    expect(resolveId([...ids, "aaaa11", "aaaa12"], "ffff")).toEqual({
      status: "found",
      id: "ffff99",
    });
  });
});

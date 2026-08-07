import { describe, expect, test } from "vitest";
import {
  LANGUAGES,
  languageForPath,
  supportedExtensions,
} from "../src/core/languages.js";

describe("languageForPath", () => {
  test.each([
    ["src/a.ts", "typescript"],
    ["src/a.mts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["src/a.js", "javascript"],
    ["src/a.jsx", "javascript"],
    ["src/a.mjs", "javascript"],
    ["src/a.py", "python"],
    ["main.go", "go"],
    ["src/lib.rs", "rust"],
  ])("maps %s to %s", (path, expected) => {
    expect(languageForPath(path)?.id).toBe(expected);
  });

  test("returns undefined for an unsupported extension", () => {
    expect(languageForPath("README.md")).toBeUndefined();
  });

  test("matches extensions case-insensitively", () => {
    expect(languageForPath("SRC/A.TS")?.id).toBe("typescript");
  });
});

describe("registry", () => {
  test("supportedExtensions covers every registered language", () => {
    const extensions = supportedExtensions();

    for (const language of LANGUAGES) {
      for (const ext of language.extensions) {
        expect(extensions).toContain(ext);
      }
    }
  });

  test("no extension is claimed by two languages", () => {
    const seen = new Set<string>();

    for (const language of LANGUAGES) {
      for (const ext of language.extensions) {
        expect(seen.has(ext), `${ext} is registered twice`).toBe(false);
        seen.add(ext);
      }
    }
  });
});

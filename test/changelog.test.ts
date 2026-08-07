import { describe, expect, test } from "vitest";
import { changelogSection } from "../scripts/changelog-section.mjs";

const CHANGELOG = `# Changelog

All notable changes are recorded here.

## [Unreleased]

- work in progress

## [0.2.0] - 2026-09-01

### Added

- Second release thing

## [0.1.0] - 2026-08-08

### Added

- First release thing
- Another one
`;

describe("changelogSection", () => {
  test("returns the notes for a version", () => {
    expect(changelogSection(CHANGELOG, "0.2.0")).toBe(
      "### Added\n\n- Second release thing",
    );
  });

  test("stops at the next version heading", () => {
    expect(changelogSection(CHANGELOG, "0.2.0")).not.toContain("First release");
  });

  test("reads the last section, which has no heading after it", () => {
    expect(changelogSection(CHANGELOG, "0.1.0")).toBe(
      "### Added\n\n- First release thing\n- Another one",
    );
  });

  test("accepts a tag-style v prefix", () => {
    expect(changelogSection(CHANGELOG, "v0.1.0")).toContain("First release thing");
  });

  test("reads a heading written without brackets", () => {
    const plain = `# Changelog\n\n## 1.0.0 - 2026-10-01\n\n- Plain heading\n`;

    expect(changelogSection(plain, "1.0.0")).toBe("- Plain heading");
  });

  test("reads a heading with no date", () => {
    const undated = `# Changelog\n\n## [1.0.0]\n\n- No date\n`;

    expect(changelogSection(undated, "1.0.0")).toBe("- No date");
  });

  test("returns undefined for a version that is not there", () => {
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeUndefined();
  });

  test("does not match a version that is only a prefix of another", () => {
    // Asking for 0.1 must not return the 0.1.0 section.
    expect(changelogSection(CHANGELOG, "0.1")).toBeUndefined();
  });

  test("does not confuse a prerelease with its final version", () => {
    const pre = `# Changelog\n\n## [1.0.0-beta.1]\n\n- Beta\n`;

    expect(changelogSection(pre, "1.0.0")).toBeUndefined();
    expect(changelogSection(pre, "1.0.0-beta.1")).toBe("- Beta");
  });

  test("never returns the Unreleased section", () => {
    expect(changelogSection(CHANGELOG, "Unreleased")).toBeUndefined();
  });

  test("returns undefined when a section is empty", () => {
    const empty = `# Changelog\n\n## [1.0.0]\n\n## [0.9.0]\n\n- Older\n`;

    expect(changelogSection(empty, "1.0.0")).toBeUndefined();
  });
});

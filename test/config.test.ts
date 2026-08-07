import { afterEach, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  configPath,
  loadConfig,
  saveConfig,
} from "../src/core/config.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** A throwaway directory standing in for the user's home. */
async function home() {
  const made = await makeProject({ ".keep": "" });
  cleanup = made.cleanup;
  return made.root;
}

async function writeRaw(root: string, contents: string) {
  const path = configPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

describe("configPath", () => {
  test("lives under the home directory", async () => {
    const root = await home();

    expect(configPath(root)).toBe(join(root, ".orvix", "config.json"));
  });
});

describe("loadConfig", () => {
  test("returns undefined when nothing has been saved", async () => {
    expect(await loadConfig(await home())).toBeUndefined();
  });

  test("returns undefined when the file is corrupt", async () => {
    const root = await home();
    await writeRaw(root, "{ not json");

    expect(await loadConfig(root)).toBeUndefined();
  });

  test("returns undefined when agents is not a list of names", async () => {
    const root = await home();
    await writeRaw(root, JSON.stringify({ agents: "claude" }));

    expect(await loadConfig(root)).toBeUndefined();
  });

  test("ignores entries that are not strings", async () => {
    const root = await home();
    await writeRaw(root, JSON.stringify({ agents: ["claude", 7, null] }));

    expect(await loadConfig(root)).toEqual({ agents: ["claude"] });
  });
});

describe("saveConfig", () => {
  test("round-trips through disk", async () => {
    const root = await home();

    await saveConfig({ agents: ["claude", "codex"] }, root);

    expect(await loadConfig(root)).toEqual({ agents: ["claude", "codex"] });
  });

  test("creates the .orvix directory", async () => {
    const root = await home();

    await saveConfig({ agents: ["claude"] }, root);

    expect(existsSync(join(root, ".orvix"))).toBe(true);
  });

  test("overwrites a previous choice", async () => {
    const root = await home();
    await saveConfig({ agents: ["claude"] }, root);

    await saveConfig({ agents: ["gemini"] }, root);

    expect(await loadConfig(root)).toEqual({ agents: ["gemini"] });
  });
});

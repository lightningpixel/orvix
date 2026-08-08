import { afterEach, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gainPath, runGain } from "../src/commands/gain.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function withLog(lines: string) {
  const made = await makeProject({ "src/a.ts": "export function a() {}\n" });
  cleanup = made.cleanup;

  await mkdir(dirname(gainPath(made.root)), { recursive: true });
  await writeFile(gainPath(made.root), lines, "utf8");
  return made.root;
}

const entry = (session: string, before: number, after: number) =>
  `${JSON.stringify({ session, at: "2026-08-08T10:00:00Z", tool: "Read", before, after })}\n`;

describe("orvix gain", () => {
  test("says plainly when nothing has been recorded", async () => {
    const made = await makeProject({ "src/a.ts": "export function a() {}\n" });
    cleanup = made.cleanup;

    const { output, ok } = await runGain(made.root);

    expect(ok).toBe(true);
    expect(output).toContain("no compressions recorded");
  });

  test("totals what was saved", async () => {
    const root = await withLog(entry("s1", 1000, 200) + entry("s1", 500, 100));

    const { output } = await runGain(root);

    expect(output).toContain("total compressions=2 before=1500 after=300 saved=1200");
  });

  test("reports the proportion saved", async () => {
    const root = await withLog(entry("s1", 1000, 250));

    expect(await runGain(root)).toMatchObject({
      output: expect.stringContaining("ratio=0.750"),
    });
  });

  test("breaks the total down by session", async () => {
    const root = await withLog(entry("s1", 100, 10) + entry("s2", 200, 20));

    const { output } = await runGain(root);

    expect(output).toContain("session=s1");
    expect(output).toContain("session=s2");
  });

  test("can report a single session", async () => {
    const root = await withLog(entry("s1", 100, 10) + entry("s2", 200, 20));

    const { output } = await runGain(root, { session: "s2" });

    expect(output).toContain("session=s2");
    expect(output).not.toContain("session=s1");
  });

  test("emits machine-readable output with no decoration", async () => {
    // An agent is going to parse this; box drawing and colour would be noise.
    const root = await withLog(entry("s1", 100, 10));

    const { output } = await runGain(root);

    expect(output).not.toMatch(/[│├└─┌╭]/);
    expect(output).not.toMatch(/\[/);
    for (const line of output.split("\n")) {
      expect(line).toMatch(/^\w+[= ]/);
    }
  });

  test("emits parseable json", async () => {
    const root = await withLog(entry("s1", 100, 10));

    const { output } = await runGain(root, { json: true });

    expect(JSON.parse(output)).toMatchObject({
      total: { compressions: 1, saved: 90 },
    });
  });

  test("survives a truncated final line", async () => {
    // The hook appends and can be killed mid-write, so a partial last record
    // is normal rather than a sign of corruption.
    const root = await withLog(entry("s1", 100, 10) + '{"session":"s2","bef');

    const { output, ok } = await runGain(root);

    expect(ok).toBe(true);
    expect(output).toContain("total compressions=1");
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runImpact } from "../src/commands/impact.js";
import { runIndex } from "../src/commands/indexCommand.js";
import { runWhoCalls } from "../src/commands/lookupCommands.js";
import { buildIndex } from "../src/core/indexer.js";
import { reindex } from "../src/core/incremental.js";
import { serialise } from "../src/core/project.js";
import { loadGraph, loadSymbols } from "../src/core/store.js";
import { makeProject } from "./helpers/tmpProject.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const IPC = {
  "src/main.ts":
    `import { ipcMain } from "electron";\n` +
    `export function getConfig() {\n  return {};\n}\n` +
    `ipcMain.handle("config:get", getConfig);\n`,
  "src/renderer.ts":
    `import { ipcRenderer } from "electron";\n` +
    `export function load() {\n  return ipcRenderer.invoke("config:get");\n}\n`,
};

async function indexed(files: Record<string, string>) {
  const made = await makeProject(files);
  cleanup = made.cleanup;
  await runIndex(made.root);
  return made.root;
}

describe("calls dispatched through a channel name", () => {
  test("link the dispatcher to the registered handler", async () => {
    const { output } = await runWhoCalls(await indexed(IPC), "getConfig");

    expect(output).toContain("load");
    expect(output).toContain("config:get");
  });

  test("are kept apart from call edges", async () => {
    // A channel match is weaker evidence than a call; it is never mixed in.
    const root = await indexed(IPC);
    const graph = await loadGraph(root);
    const symbols = await loadSymbols(root);
    const getConfig = symbols.byName["getconfig"]![0]!;

    expect(graph.callers[getConfig]).toBeUndefined();
    expect(graph.dispatch[getConfig]).toEqual([
      { from: symbols.byName["load"]![0]!, channel: "config:get" },
    ]);
  });

  test("reach every handler registered on the channel", async () => {
    const root = await indexed({
      ...IPC,
      "src/audit.ts": `import { ipcMain } from "electron";\nexport function audit() {}\nipcMain.on("config:get", audit);\n`,
    });

    expect((await runWhoCalls(root, "audit")).output).toContain("load");
  });

  test("stay within one package", async () => {
    // Monorepos repeat channel names across unrelated apps: socket.io's own
    // examples all use "todo:create". A client and its server share a package.
    const root = await indexed({
      "examples/a/package.json": "{}",
      "examples/a/server.ts": `export function createTodo() {}
io.on("todo:create", createTodo);
`,
      "examples/a/client.ts": `export function add() {
  socket.emit("todo:create");
}
`,
      "examples/b/package.json": "{}",
      "examples/b/client.ts": `export function addToo() {
  socket.emit("todo:create");
}
`,
    });

    const { output } = await runWhoCalls(root, "createTodo");

    expect(output).toContain("add");
    expect(output).not.toContain("addToo");
  });

  test("ignore channel names too common to mean one thing", async () => {
    const root = await indexed({
      "src/a.ts": `export function onData() {}\nstream.on("data", onData);\n`,
      "src/b.ts": `export function pump() {\n  other.emit("data");\n}\n`,
    });

    expect((await runWhoCalls(root, "onData")).output).toBe("none");
  });

  test("draw nothing for a channel nobody listens on", async () => {
    const root = await indexed({ "src/b.ts": `export function pump() {\n  bus.emit("job:done");\n}\n` });

    expect(Object.keys((await loadGraph(root)).dispatch)).toEqual([]);
  });

  test("are followed by impact, marked with their channel", async () => {
    const { output } = await runImpact(await indexed(IPC), "getConfig");

    expect(output).toContain("load");
    expect(output).toContain("config:get");
  });

  test("agree with a full rebuild after a handler is added incrementally", async () => {
    const made = await makeProject(IPC);
    cleanup = made.cleanup;
    await buildIndex(made.root);

    await writeFile(
      join(made.root, "src/audit.ts"),
      `import { ipcMain } from "electron";\nexport function audit() {}\nipcMain.on("config:get", audit);\n`,
    );
    await reindex(made.root, ["src/audit.ts"], { rerank: true });
    const incremental = serialise(await loadGraph(made.root));

    await rm(join(made.root, ".orvix"), { recursive: true, force: true });
    await buildIndex(made.root);

    expect(incremental).toContain("audit");
    expect(incremental).toBe(serialise(await loadGraph(made.root)));
  });
});

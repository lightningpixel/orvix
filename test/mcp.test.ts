import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { runIndex } from "../src/commands/indexCommand.js";
import { createMcpHandler, PROTOCOL_VERSION } from "../src/mcp/server.js";
import { makeProject } from "./helpers/tmpProject.js";

const MAIN = resolve("dist", "main.js");
const built = existsSync(MAIN);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const PROJECT = {
  "src/auth.ts": `export function validate(email: string): boolean {\n  return email.includes("@");\n}\n`,
  "src/login.ts":
    `import { validate } from "./auth";\n` +
    `export function login(email: string) {\n  return validate(email);\n}\n`,
};

async function indexed() {
  const made = await makeProject(PROJECT);
  cleanup = made.cleanup;
  await runIndex(made.root);
  return made.root;
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("the MCP handler", () => {
  test("answers initialize with its capabilities", async () => {
    const handle = createMcpHandler(await indexed());

    const reply = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });

    expect(reply).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "orvix" } },
    });
  });

  test("does not answer a notification", async () => {
    const handle = createMcpHandler(await indexed());

    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  test("lists one tool per query command, each with an input schema", async () => {
    const handle = createMcpHandler(await indexed());

    const reply = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (reply as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result.tools;

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["calls", "find", "impact", "map", "show", "who_calls"],
    );
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  test("runs a tool and returns its text", async () => {
    const handle = createMcpHandler(await indexed());

    const reply = (await handle(call(3, "who_calls", { symbol: "validate" }))) as {
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };

    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0]!.text).toContain("login");
  });

  test("passes options through", async () => {
    const handle = createMcpHandler(await indexed());

    const reply = (await handle(call(4, "map", { focus: ["login"], budget: 200 }))) as {
      result: { content: Array<{ text: string }> };
    };

    expect(reply.result.content[0]!.text).toContain("validate");
  });

  test("reports a failed lookup as a tool error, not a protocol error", async () => {
    // The model should see the explanation and try `find`; a JSON-RPC error
    // would reach the client instead.
    const handle = createMcpHandler(await indexed());

    const reply = (await handle(call(5, "show", { symbol: "nope" }))) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]!.text).toContain("orvix find");
  });

  test("rejects a call missing a required argument", async () => {
    const handle = createMcpHandler(await indexed());

    const reply = (await handle(call(6, "show", {}))) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]!.text).toContain("symbol");
  });

  test("answers an unknown tool and an unknown method with errors", async () => {
    const handle = createMcpHandler(await indexed());

    expect(await handle(call(7, "nonsense", {}))).toMatchObject({ id: 7, error: { code: -32602 } });
    expect(await handle({ jsonrpc: "2.0", id: 8, method: "resources/list" })).toMatchObject({
      id: 8,
      error: { code: -32601 },
    });
  });

  test("answers ping", async () => {
    const handle = createMcpHandler(await indexed());

    expect(await handle({ jsonrpc: "2.0", id: 9, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });
});

describe.skipIf(!built)("orvix mcp over stdio", () => {
  test("serves newline-delimited JSON-RPC until stdin closes", async () => {
    const root = await indexed();
    const child = spawn(process.execPath, [MAIN, "mcp", root], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout! });
    const replies: unknown[] = [];
    const done = new Promise<void>((resolveDone) => {
      lines.on("line", (line) => {
        replies.push(JSON.parse(line));
        if (replies.length === 2) resolveDone();
      });
    });

    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin!.write(`${JSON.stringify(call(2, "find", { query: "valid" }))}\n`);
    await done;
    child.stdin!.end();
    await new Promise((resolveExit) => child.on("exit", resolveExit));

    expect(replies[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "orvix" } } });
    expect(replies[1]).toMatchObject({ id: 2, result: { isError: false } });
    expect(JSON.stringify(replies[1])).toContain("validate");
  });
});

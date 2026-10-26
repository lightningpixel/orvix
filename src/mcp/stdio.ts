import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createMcpHandler, type JsonRpcMessage } from "./server.js";

/**
 * Serves MCP over stdio until stdin closes: one JSON-RPC message per line in,
 * one per line out.
 *
 * Requests are answered in the order they arrive. Each is cheap, and keeping
 * them ordered means a reply can never overtake the one before it.
 */
export async function serveStdio(path: string): Promise<void> {
  const handle = createMcpHandler(resolve(path));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim().length === 0) continue;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }

    const reply = await handle(message);
    if (reply) write(reply);
  }
}

function write(reply: unknown): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

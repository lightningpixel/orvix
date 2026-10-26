import pkg from "../../package.json" with { type: "json" };
import { runImpact } from "../commands/impact.js";
import { runCalls, runFind, runShow, runWhoCalls } from "../commands/lookupCommands.js";
import { runMap } from "../commands/map.js";
import type { CommandResult } from "../query/session.js";

/**
 * Orvix as a Model Context Protocol server.
 *
 * Hooks are Claude Code's; MCP is what every other agent speaks. The tools are
 * the query commands unchanged, so an answer over MCP is byte for byte the
 * answer on the command line.
 *
 * Written against the protocol directly rather than through an SDK: four
 * methods are needed, and a dependency for them would outweigh the server.
 */
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Reply = Record<string, unknown>;

interface Tool {
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  run: (root: string, args: Record<string, unknown>) => Promise<CommandResult>;
}

const SYMBOL = {
  type: "string",
  description: "A symbol id (short hash prefix), a name, or Container.name",
};

const TOOLS: Record<string, Tool> = {
  map: {
    description:
      "The project's symbols, most important first, fitted to a token budget. " +
      "Give `focus` to centre it on the ids, names or files a task touches.",
    properties: {
      budget: { type: "number", description: "Approximate token budget (default 2000)" },
      focus: { type: "array", items: { type: "string" }, description: "Ids, names or files" },
    },
    required: [],
    run: (root, args) =>
      runMap(root, {
        budget: typeof args.budget === "number" ? args.budget : undefined,
        focus: Array.isArray(args.focus) ? args.focus.map(String) : undefined,
      }),
  },
  show: {
    description: "The exact source of one symbol. Prefer this to reading a whole file.",
    properties: { symbol: SYMBOL },
    required: ["symbol"],
    run: (root, args) => runShow(root, String(args.symbol)),
  },
  find: {
    description: "Search symbols by name or signature.",
    properties: { query: { type: "string", description: "Part of a name or signature" } },
    required: ["query"],
    run: (root, args) => runFind(root, String(args.query)),
  },
  who_calls: {
    description: "Every symbol that calls this one. Run it before changing a signature.",
    properties: { symbol: SYMBOL },
    required: ["symbol"],
    run: (root, args) => runWhoCalls(root, String(args.symbol)),
  },
  calls: {
    description: "Every symbol this one calls.",
    properties: { symbol: SYMBOL },
    required: ["symbol"],
    run: (root, args) => runCalls(root, String(args.symbol)),
  },
  impact: {
    description:
      "Everything that reaches this symbol, nearest first, and the test files among it — " +
      "the tests to run after changing it.",
    properties: {
      symbol: SYMBOL,
      depth: { type: "number", description: "Levels of callers to follow (default: all)" },
    },
    required: ["symbol"],
    run: (root, args) =>
      runImpact(root, String(args.symbol), {
        depth: typeof args.depth === "number" ? args.depth : undefined,
      }),
  },
};

/**
 * Builds the request handler for one project.
 *
 * Returns undefined for a notification, which takes no reply. A tool that
 * fails — an unknown symbol above all — answers with `isError` rather than a
 * protocol error, so the explanation reaches the model and not just the client.
 */
export function createMcpHandler(root: string) {
  return async (message: JsonRpcMessage): Promise<Reply | undefined> => {
    const { id, method, params = {} } = message;
    if (id === undefined || id === null) return undefined;

    const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): Reply => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });

    switch (method) {
      case "initialize":
        return ok({
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "orvix", version: pkg.version },
          instructions:
            "A prebuilt index of this codebase. Use `map` for its shape, `show` to read one " +
            "symbol instead of a whole file, and `impact` or `who_calls` before changing a signature.",
        });

      case "ping":
        return ok({});

      case "tools/list":
        return ok({
          tools: Object.entries(TOOLS).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: { type: "object", properties: tool.properties, required: tool.required },
          })),
        });

      case "tools/call": {
        const name = String(params.name ?? "");
        const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
        if (!tool) return fail(-32602, `unknown tool: ${name}`);

        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const missing = tool.required.filter((key) => args[key] === undefined || args[key] === "");
        if (missing.length > 0) {
          return ok(text(`missing argument: ${missing.join(", ")}`, true));
        }

        try {
          const result = await tool.run(root, args);
          return ok(text(result.output, !result.ok));
        } catch (error) {
          return ok(text(error instanceof Error ? error.message : String(error), true));
        }
      }

      default:
        return fail(-32601, `method not found: ${method}`);
    }
  };
}

function text(output: string, isError: boolean) {
  return { content: [{ type: "text", text: output }], isError };
}

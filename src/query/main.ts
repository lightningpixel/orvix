import { runMap } from "../commands/map.js";
import {
  runCalls,
  runFind,
  runShow,
  runWhoCalls,
} from "../commands/lookupCommands.js";
import type { CommandResult } from "./session.js";

/**
 * The query entry point, used by hooks and by anything else that wants an
 * answer without paying for a CLI framework.
 *
 * Argument parsing is done by hand on purpose. Commander costs about 12 ms to
 * import, which is a quarter of the budget for a hook that runs on every tool
 * call, and this needs six flags rather than a framework.
 */
const USAGE = `usage: orvix-query <command> [argument] [options]

commands:
  map                     ranked symbol map, fitted to a budget
  show <id|name>          one symbol's exact source
  find <query>            search symbols by name or signature
  who-calls <id|name>     symbols that call this one
  calls <id|name>         symbols this one calls

options:
  -p, --path <path>       project root (default: .)
  -b, --budget <tokens>   token budget for map (default: 2000)
  --json                  machine-readable output`;

interface Parsed {
  command: string;
  argument: string;
  path: string;
  budget?: string;
  json: boolean;
}

export function parseArgs(argv: string[]): Parsed | { error: string } {
  const positional: string[] = [];
  let path = ".";
  let budget: string | undefined;
  let json = false;

  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at]!;

    if (token === "--json") json = true;
    else if (token === "-p" || token === "--path") path = argv[++at] ?? ".";
    else if (token === "-b" || token === "--budget") budget = argv[++at];
    else if (token.startsWith("-")) return { error: `unknown option: ${token}` };
    else positional.push(token);
  }

  const command = positional[0];
  if (!command) return { error: USAGE };

  return { command, argument: positional[1] ?? "", path, budget, json };
}

export async function run(argv: string[]): Promise<CommandResult> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return { output: parsed.error, ok: false };

  const { command, argument, path, budget, json } = parsed;

  if (command === "map") return runMap(path, { budget, json });

  // The command is checked before its argument on purpose: `orvix-query
  // nonsense` should say the command is unknown, not ask for a symbol id it
  // was never going to use.
  const takesSymbol = { show: runShow, find: runFind, "who-calls": runWhoCalls, calls: runCalls };
  const handler = takesSymbol[command as keyof typeof takesSymbol];

  if (!handler) {
    return { output: `unknown command: ${command}\n\n${USAGE}`, ok: false };
  }
  if (!argument) {
    return { output: `${command} needs a symbol id or name`, ok: false };
  }

  return handler(path, argument, { json });
}

async function main(): Promise<void> {
  try {
    const { output, ok } = await run(process.argv.slice(2));
    if (ok) console.log(output);
    else {
      console.error(output);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();

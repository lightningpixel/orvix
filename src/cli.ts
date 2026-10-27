import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runDiff } from "./commands/diff.js";
import { runIndex } from "./commands/indexCommand.js";
import { runGain } from "./commands/gain.js";
import { runImpact } from "./commands/impact.js";
import { runInit } from "./commands/init.js";
import { askForAgents, isInteractive } from "./commands/prompt.js";
import { runMap } from "./commands/map.js";
import { readReplacement, runReplace } from "./commands/replace.js";
import { serveStdio } from "./mcp/stdio.js";
import {
  runCalls,
  runFind,
  runShow,
  runWhoCalls,
} from "./commands/lookupCommands.js";
import type { CommandResult } from "./query/session.js";

/**
 * Builds the CLI without running it, so tests can inspect the command tree.
 * Behaviour lives in src/commands/ — this file is wiring only.
 */
export function buildCli(): Command {
  const program = new Command();

  program
    .name("orvix")
    .description(
      "Semantic code map for AI agents. Index once, then read only the symbols you need.",
    )
    .version(pkg.version);

  program
    .command("init")
    .description(
      "set this project up for agents: write their instruction files and build the index",
    )
    .argument("[path]", "project root", ".")
    .option(
      "-a, --agent <names...>",
      "agents to configure (claude, codex, cursor, gemini); skips the prompt",
    )
    .action(
      report((path, options) =>
        runInit(path, {
          agent: options.agent,
          // Only offer to ask when there is a terminal to ask on. Without
          // this a scripted run would block forever on a hidden question.
          prompt: isInteractive() ? askForAgents : undefined,
        }),
      ),
    );

  program
    .command("index")
    .description("build or refresh the semantic index for a project")
    .argument("[path]", "project root", ".")
    .option("--json", "machine-readable output")
    .action(report((path, options) => runIndex(path, options)));

  program
    .command("map")
    .description("print the symbol tree, ranked and fitted to a token budget")
    .argument("[path]", "project root", ".")
    .option("-b, --budget <tokens>", "approximate token budget", "2000")
    .option(
      "-f, --focus <targets...>",
      "centre the map on these ids, names or files instead of global importance",
    )
    .option("--json", "machine-readable output")
    .option("--no-refresh", "answer from the cache without restatting files")
    .action(report((path, options) => runMap(path, options)));

  program
    .command("gain")
    .description("report the tokens the hooks have saved, per session and in total")
    .argument("[path]", "project root", ".")
    .option("--json", "machine-readable output")
    .option("-s, --session <id>", "report only this session")
    .action(report((path, options) => runGain(path, options)));

  program
    .command("show")
    .description("print the exact source of one symbol")
    .argument("<id>", "symbol id (short hash prefix) or name")
    .option("-p, --path <path>", "project root", ".")
    .option("--json", "machine-readable output")
    .option("--no-refresh", "answer from the cache without restatting files")
    .action(report((id, options) => runShow(options.path, id, options)));

  program
    .command("find")
    .description("search symbols by name or signature")
    .argument("<query>", "search query")
    .option("-p, --path <path>", "project root", ".")
    .option("--json", "machine-readable output")
    .option("--no-refresh", "answer from the cache without restatting files")
    .action(report((query, options) => runFind(options.path, query, options)));

  program
    .command("who-calls")
    .description("list the symbols that call this one")
    .argument("<id>", "symbol id or name")
    .option("-p, --path <path>", "project root", ".")
    .option("--json", "machine-readable output")
    .option("--no-refresh", "answer from the cache without restatting files")
    .action(report((id, options) => runWhoCalls(options.path, id, options)));

  program
    .command("calls")
    .description("list the symbols this one calls")
    .argument("<id>", "symbol id or name")
    .option("-p, --path <path>", "project root", ".")
    .option("--json", "machine-readable output")
    .option("--no-refresh", "answer from the cache without restatting files")
    .action(report((id, options) => runCalls(options.path, id, options)));

  program
    .command("impact")
    .description("list everything that reaches this symbol, nearest first, and the tests among it")
    .argument("<id>", "symbol id or name")
    .option("-p, --path <path>", "project root", ".")
    .option("-d, --depth <n>", "how many levels of callers to follow")
    .option("--json", "machine-readable output")
    .option("--no-refresh", "answer from the cache without restatting files")
    .action(report((id, options) => runImpact(options.path, id, options)));

  program
    .command("diff")
    .description("list the symbols changed since a git ref, and who depends on the old shape")
    .argument("[ref]", "git ref to compare the working tree against", "HEAD")
    .option("-p, --path <path>", "project root", ".")
    .option("--json", "machine-readable output")
    .action(report((ref, options) => runDiff(options.path, { ...options, ref })));

  program
    .command("replace")
    .description("replace one symbol's source with new text, read from --file or stdin (experimental)")
    .argument("<id>", "symbol id or name")
    .option("-p, --path <path>", "project root", ".")
    .option("-f, --file <file>", "read the replacement from this file instead of stdin")
    .option("--write", "apply the change; without it, only describe it")
    .action(
      report(async (id, options) =>
        runReplace(options.path, id, {
          source: await readReplacement(options.file),
          write: options.write === true,
        }),
      ),
    );

  program
    .command("mcp")
    .description("serve the index over the Model Context Protocol, on stdio")
    .argument("[path]", "project root", ".")
    // Not wrapped in report(): this runs until stdin closes, and stdout
    // belongs to the protocol.
    .action((path: string) => serveStdio(path));

  return program;
}

/**
 * Prints a command's result and sets the exit code.
 *
 * Failures go to stderr so an agent piping stdout never mistakes an error
 * message for an answer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function report(run: (argument: string, options: any) => Promise<CommandResult>) {
  return async (argument: string, options: unknown): Promise<void> => {
    try {
      const { output, ok } = await run(argument, options);
      if (ok) console.log(output);
      else {
        console.error(output);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

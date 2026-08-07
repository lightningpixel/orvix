import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { instructionBlock, upsertBlock } from "../agents/block.js";
import { AGENTS, agentById, targetFiles, type AgentDef } from "../agents/registry.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { buildIndex, allSymbols } from "../core/indexer.js";
import { CACHE_DIR } from "../core/store.js";
import type { CommandResult } from "./session.js";

/** Asks which agents the user works with. Injected so tests never read stdin. */
export type AgentPrompt = (agents: readonly AgentDef[]) => Promise<string[]>;

export interface InitOptions {
  /** From `--agent`; overrides and replaces any saved choice. */
  agent?: string[];
  /** Overridden in tests so the real home directory is never touched. */
  home?: string;
  prompt?: AgentPrompt;
}

/**
 * Used when there is no saved choice and no way to ask — a non-interactive
 * shell, a script, CI. AGENTS.md is the broadest convention, so an
 * unattended run still leaves the project usable.
 */
const FALLBACK_AGENT = "codex";

const IGNORE_ENTRY = `${CACHE_DIR}/`;

/**
 * `orvix init` — makes a project ready for agents to navigate.
 *
 * Writes the instruction block into whichever context files the user's agents
 * read, keeps the cache out of version control, and builds the index so the
 * first real query costs nothing.
 *
 * Everything it does is idempotent: running it again after an Orvix upgrade
 * refreshes stale instructions in place.
 */
export async function runInit(
  path: string,
  options: InitOptions = {},
): Promise<CommandResult> {
  const root = resolve(path);

  const chosen = await chooseAgents(options);
  if ("failure" in chosen) return chosen.failure;

  const files = targetFiles(chosen.agents);
  const block = instructionBlock();
  const done: string[] = [];

  for (const file of files) {
    const existing = await readIfPresent(join(root, file));
    await writeFile(join(root, file), upsertBlock(existing ?? "", block), "utf8");
    done.push(`${existing === undefined ? "created" : "updated"} ${file}`);
  }

  if (await ensureIgnored(root)) done.push(`added ${IGNORE_ENTRY} to .gitignore`);

  const { index, stats } = await buildIndex(root);
  done.push(
    `indexed ${Object.keys(index.files).length} files, ${allSymbols(index).length} symbols` +
      (stats.skipped > 0 ? ` (${stats.skipped} skipped)` : ""),
  );

  return {
    output: [...done, "", "Agents in this project will now use orvix."].join("\n"),
    ok: true,
  };
}

type Chosen = { agents: string[] } | { failure: CommandResult };

/**
 * Resolution order: an explicit flag, then the saved global choice, then the
 * user, then a safe default. Asking is last-but-one on purpose — the point of
 * a global install is not being asked again in every repository.
 */
async function chooseAgents(options: InitOptions): Promise<Chosen> {
  if (options.agent && options.agent.length > 0) {
    const unknown = options.agent.filter((id) => !agentById(id));
    if (unknown.length > 0) {
      return {
        failure: {
          output:
            `unknown agent: ${unknown.join(", ")}. ` +
            `Known agents: ${AGENTS.map((a) => a.id).join(", ")}.`,
          ok: false,
        },
      };
    }

    await saveConfig({ agents: options.agent }, options.home);
    return { agents: options.agent };
  }

  const saved = await loadConfig(options.home);
  if (saved && saved.agents.length > 0) return { agents: saved.agents };

  if (options.prompt) {
    const answered = (await options.prompt(AGENTS)).filter((id) => agentById(id));
    const agents = answered.length > 0 ? answered : [FALLBACK_AGENT];
    await saveConfig({ agents }, options.home);
    return { agents };
  }

  return { agents: [FALLBACK_AGENT] };
}

/** Adds the cache directory to .gitignore. Returns whether anything changed. */
async function ensureIgnored(root: string): Promise<boolean> {
  const path = join(root, ".gitignore");
  const existing = await readIfPresent(path);

  if (existing?.split("\n").some((line) => line.trim() === IGNORE_ENTRY)) {
    return false;
  }

  const prefix = existing?.trimEnd() ?? "";
  const next = prefix.length === 0 ? `${IGNORE_ENTRY}\n` : `${prefix}\n${IGNORE_ENTRY}\n`;
  await writeFile(path, next, "utf8");
  return true;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

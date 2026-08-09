import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { instructionBlock, upsertBlock } from "../agents/block.js";
import { upsertHooks, type ClaudeSettings } from "../agents/claudeHooks.js";
import {
  AGENTS,
  agentById,
  targetFiles,
  wantsHooks,
  type AgentDef,
} from "../agents/registry.js";
import { hooksDir, packageRoot } from "../core/paths.js";
import { configPath, loadConfig, saveConfig } from "../core/config.js";
import { buildIndex, allSymbols } from "../core/indexer.js";
import { CACHE_DIR } from "../core/store.js";
import type { CommandResult } from "../query/session.js";

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
  const done: string[] = chosen.note ? [chosen.note] : [];

  for (const file of files) {
    const existing = await readIfPresent(join(root, file));
    await writeFile(join(root, file), upsertBlock(existing ?? "", block), "utf8");
    done.push(`${existing === undefined ? "created" : "updated"} ${file}`);
  }

  if (wantsHooks(chosen.agents)) done.push(...(await installHooks(root)));

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

type Chosen =
  | { agents: string[]; note?: string }
  | { failure: CommandResult };

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
  if (saved && saved.agents.length > 0) {
    // Not asking is the point of a global install, but acting on a choice made
    // in another repository months ago reads as guesswork unless it says so.
    return {
      agents: saved.agents,
      note:
        `using saved choice: ${saved.agents.join(", ")} ` +
        `(${configPath(options.home)} — override with --agent)`,
    };
  }

  if (options.prompt) {
    const answered = (await options.prompt(AGENTS)).filter((id) => agentById(id));
    const agents = answered.length > 0 ? answered : [FALLBACK_AGENT];
    await saveConfig({ agents }, options.home);
    return { agents };
  }

  return { agents: [FALLBACK_AGENT] };
}

/**
 * Installs the hook scripts and registers them.
 *
 * The scripts are copied into the project rather than referenced inside the
 * package, and the settings entry points at the copy. That is what makes the
 * integration portable: another agent can run the same standalone scripts
 * without knowing anything about how Orvix was installed.
 *
 * The `orvix-probe.mjs` diagnostic is copied too but never registered — it is
 * there for when a tool's response shape needs establishing, not for normal
 * use.
 */
async function installHooks(root: string): Promise<string[]> {
  const done: string[] = [];
  const target = join(root, ".claude", "hooks");
  await mkdir(target, { recursive: true });

  const scripts = (await readdir(hooksDir())).filter((name) => name.endsWith(".mjs"));
  for (const script of scripts) {
    await copyFile(join(hooksDir(), script), join(target, script));
  }
  done.push(`installed ${scripts.length} hook scripts in .claude/hooks/`);

  const settingsPath = join(root, ".claude", "settings.json");
  const existing = await readIfPresent(settingsPath);

  let parsed: ClaudeSettings = {};
  if (existing !== undefined) {
    try {
      parsed = JSON.parse(existing) as ClaudeSettings;
    } catch {
      // Refuse to touch a settings file that is not valid JSON: rewriting it
      // would destroy whatever the user was in the middle of.
      done.push("left .claude/settings.json alone — it is not valid JSON");
      return done;
    }
  }

  const merged = `${JSON.stringify(upsertHooks(parsed), null, 2)}\n`;
  if (merged !== existing) {
    await writeFile(settingsPath, merged, "utf8");
    done.push(
      `${existing === undefined ? "created" : "updated"} .claude/settings.json`,
    );
  }

  // Hook scripts live in the project, not in node_modules, so they cannot
  // resolve the package that installed them. Recording it here is what lets
  // the Stop hook find orvix again.
  await mkdir(join(root, CACHE_DIR), { recursive: true });
  await writeFile(
    join(root, CACHE_DIR, "runtime.json"),
    `${JSON.stringify(
      {
        main: join(packageRoot(), "dist", "main.js"),
        query: join(packageRoot(), "dist", "query.js"),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return done;
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

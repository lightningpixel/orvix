import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * User-level preferences, kept outside any project.
 *
 * Only one thing lives here: which agents this person uses. It is asked once,
 * by `orvix init`, and reused in every project afterwards — the point of a
 * global install is not being asked the same question in each repository.
 */
export interface OrvixConfig {
  /** Agent ids, as registered in src/agents/registry.ts. */
  agents: string[];
}

/** `home` is injectable so tests never touch the real home directory. */
export function configPath(home: string = homedir()): string {
  return join(home, ".orvix", "config.json");
}

/**
 * Reads the saved preferences.
 *
 * Anything unreadable, corrupt or malformed reads as "not configured yet":
 * a bad config file must lead to being asked again, never to a crash.
 */
export async function loadConfig(
  home: string = homedir(),
): Promise<OrvixConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(configPath(home), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;

  const { agents } = parsed as { agents?: unknown };
  if (!Array.isArray(agents)) return undefined;

  return { agents: agents.filter((name): name is string => typeof name === "string") };
}

export async function saveConfig(
  config: OrvixConfig,
  home: string = homedir(),
): Promise<void> {
  const path = configPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

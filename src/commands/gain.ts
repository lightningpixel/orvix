import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CACHE_DIR } from "../core/store.js";
import type { CommandResult } from "../query/session.js";

export interface GainOptions {
  json?: boolean;
  /** Report only this session rather than every one on record. */
  session?: string;
}

/** One compression, as the hook recorded it. */
interface GainEntry {
  session: string;
  at: string;
  tool: string;
  before: number;
  after: number;
}

export interface GainTotals {
  compressions: number;
  before: number;
  after: number;
  saved: number;
  /** Proportion of the original spend avoided, 0 to 1. */
  ratio: number;
}

export function gainPath(root: string): string {
  return join(root, CACHE_DIR, "gain.jsonl");
}

/**
 * `orvix gain` — what the hooks actually saved.
 *
 * These are measured deltas, not estimates of what an agent might have done:
 * every line was written when a real tool result was replaced, recording the
 * size of both. Token counts are approximated from character length, but the
 * same approximation is applied to both sides, so the ratio holds even where
 * the absolute numbers drift.
 */
export async function runGain(
  path: string,
  options: GainOptions = {},
): Promise<CommandResult> {
  const root = resolve(path);
  const entries = await readEntries(root);

  if (entries.length === 0) {
    return {
      output: options.json
        ? JSON.stringify({ sessions: [], total: empty() }, null, 2)
        : "no compressions recorded yet",
      ok: true,
    };
  }

  const filtered = options.session
    ? entries.filter((entry) => entry.session === options.session)
    : entries;

  const bySession = new Map<string, GainEntry[]>();
  for (const entry of filtered) {
    const bucket = bySession.get(entry.session);
    if (bucket) bucket.push(entry);
    else bySession.set(entry.session, [entry]);
  }

  const sessions = [...bySession].map(([session, group]) => ({
    session,
    from: group[0]!.at,
    to: group[group.length - 1]!.at,
    ...totals(group),
  }));

  const total = totals(filtered);

  if (options.json) {
    return { output: JSON.stringify({ sessions, total }, null, 2), ok: true };
  }

  // Machine-readable by default: key=value, one record per line, no colours
  // and no box drawing. Something is going to parse this.
  const lines = sessions.map(
    (s) =>
      `session=${s.session} compressions=${s.compressions} before=${s.before} ` +
      `after=${s.after} saved=${s.saved} ratio=${s.ratio.toFixed(3)}`,
  );

  lines.push(
    `total compressions=${total.compressions} before=${total.before} ` +
      `after=${total.after} saved=${total.saved} ratio=${total.ratio.toFixed(3)}`,
  );

  return { output: lines.join("\n"), ok: true };
}

function totals(entries: GainEntry[]): GainTotals {
  const before = entries.reduce((sum, entry) => sum + entry.before, 0);
  const after = entries.reduce((sum, entry) => sum + entry.after, 0);

  return {
    compressions: entries.length,
    before,
    after,
    saved: before - after,
    ratio: before > 0 ? (before - after) / before : 0,
  };
}

function empty(): GainTotals {
  return { compressions: 0, before: 0, after: 0, saved: 0, ratio: 0 };
}

/**
 * Reads the log, skipping anything malformed.
 *
 * It is appended to by a hook that may be killed mid-write, so a truncated
 * final line is normal rather than exceptional.
 */
async function readEntries(root: string): Promise<GainEntry[]> {
  let raw: string;
  try {
    raw = await readFile(gainPath(root), "utf8");
  } catch {
    return [];
  }

  const entries: GainEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as GainEntry;
      if (typeof parsed.before === "number" && typeof parsed.after === "number") {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return entries;
}

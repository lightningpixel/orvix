import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lookupSymbol, qualifiedName } from "../core/lookup.js";
import { allSymbols } from "../core/indexer.js";
import { renderList, renderSource } from "../render/symbol.js";
import type { IndexedSymbol } from "../types.js";
import { openProject, type CommandResult, type Session } from "./session.js";

export interface QueryOptions {
  json?: boolean;
  refresh?: boolean;
}

/** `orvix show` — the exact source of one symbol. */
export async function runShow(
  path: string,
  query: string,
  options: QueryOptions = {},
): Promise<CommandResult> {
  const session = await openProject(path, { refresh: options.refresh });
  const found = resolveOrExplain(session, query);
  if ("failure" in found) return found.failure;

  const source = await readFile(join(session.root, found.symbol.file), "utf8");

  if (options.json) {
    return {
      output: JSON.stringify(
        { ...found.symbol, source: source.slice(found.symbol.startByte, found.symbol.endByte) },
        null,
        2,
      ),
      ok: true,
    };
  }

  return { output: renderSource(found.symbol, source), ok: true };
}

/** `orvix who-calls` — the symbols that call this one. */
export async function runWhoCalls(
  path: string,
  query: string,
  options: QueryOptions = {},
): Promise<CommandResult> {
  return relatives(path, query, options, (session, symbol) =>
    session.graph.callers.get(symbol.id),
  );
}

/** `orvix calls` — the symbols this one calls. */
export async function runCalls(
  path: string,
  query: string,
  options: QueryOptions = {},
): Promise<CommandResult> {
  return relatives(path, query, options, (session, symbol) =>
    session.graph.callees.get(symbol.id),
  );
}

async function relatives(
  path: string,
  query: string,
  options: QueryOptions,
  pick: (session: Session, symbol: IndexedSymbol) => Set<string> | undefined,
): Promise<CommandResult> {
  const session = await openProject(path, { refresh: options.refresh });
  const found = resolveOrExplain(session, query);
  if ("failure" in found) return found.failure;

  const ids = pick(session, found.symbol) ?? new Set<string>();
  const related = allSymbols(session.index)
    .filter((symbol) => ids.has(symbol.id))
    .sort(
      (a, b) => (session.ranks.get(b.id) ?? 0) - (session.ranks.get(a.id) ?? 0),
    );

  if (options.json) return { output: JSON.stringify(related, null, 2), ok: true };
  return { output: renderList(related, session.index, session.graph), ok: true };
}

/** `orvix find` — search symbols by name or signature. */
export async function runFind(
  path: string,
  query: string,
  options: QueryOptions = {},
): Promise<CommandResult> {
  const session = await openProject(path, { refresh: options.refresh });
  const needle = query.toLowerCase();

  const scored = allSymbols(session.index)
    .map((symbol) => ({ symbol, score: matchScore(symbol, needle) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (session.ranks.get(b.symbol.id) ?? 0) -
          (session.ranks.get(a.symbol.id) ?? 0),
    )
    .map((entry) => entry.symbol);

  if (options.json) return { output: JSON.stringify(scored, null, 2), ok: true };
  return { output: renderList(scored, session.index, session.graph), ok: true };
}

/** Exact name beats a prefix, which beats a substring, which beats the signature. */
function matchScore(symbol: IndexedSymbol, needle: string): number {
  const name = symbol.name.toLowerCase();

  if (name === needle) return 4;
  if (qualifiedName(symbol).toLowerCase() === needle) return 4;
  if (name.startsWith(needle)) return 3;
  if (name.includes(needle)) return 2;
  if (symbol.signature.toLowerCase().includes(needle)) return 1;
  return 0;
}

type Resolved = { symbol: IndexedSymbol } | { failure: CommandResult };

/** Turns a failed lookup into an answer the agent can act on. */
function resolveOrExplain(session: Session, query: string): Resolved {
  const result = lookupSymbol(session.index, query);

  if (result.status === "found") return { symbol: result.symbol };

  if (result.status === "ambiguous") {
    return {
      failure: {
        output: `"${query}" matches ${result.matches.length} symbols:\n${renderList(result.matches, session.index, session.graph)}`,
        ok: false,
      },
    };
  }

  return {
    failure: {
      output: `no symbol matches "${query}". Try \`orvix find ${query}\`.`,
      ok: false,
    },
  };
}

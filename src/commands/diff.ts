import { changedFiles, diffFile, type FileDiff } from "../core/semanticDiff.js";
import { qualifiedName } from "../core/symbols.js";
import { openQuery, type CommandResult, type QuerySession } from "../query/session.js";
import type { IndexedSymbol } from "../types.js";

export interface DiffOptions {
  ref?: string;
  json?: boolean;
}

/** Callers shown under one changed symbol before the rest is left to `who-calls`. */
const MAX_CALLERS = 5;

/**
 * `orvix diff [ref]` — what changed since a git ref, symbol by symbol.
 *
 * A line diff says which lines moved; this says which functions did, and for
 * the two changes that can break something elsewhere — a new signature and a
 * symbol that is gone — who is left depending on the old shape. That is what
 * reviewing a change needs, at a fraction of the size of the patch.
 */
export async function runDiff(path: string, options: DiffOptions = {}): Promise<CommandResult> {
  const ref = options.ref ?? "HEAD";
  const session = await openQuery(path);

  const changed = await changedFiles(session.root, ref);
  if ("error" in changed) return { output: changed.error, ok: false };

  const diffs = (
    await Promise.all(changed.files.map((file) => diffFile(session.root, ref, file)))
  ).filter((diff) => diff.added.length + diff.removed.length + diff.signature.length + diff.body.length > 0);

  if (options.json) {
    const files = diffs.map((diff) => ({
      ...diff,
      signature: diff.signature.map((change) => ({
        ...change,
        callers: callersOf(session, change.after.id),
      })),
      removed: diff.removed.map((symbol) => ({ ...symbol, stillNamedIn: namedIn(session, symbol) })),
    }));
    return { output: JSON.stringify({ ref, files }, null, 2), ok: true };
  }

  if (diffs.length === 0) return { output: `no symbol changed since ${ref}`, ok: true };

  const total = (pick: (diff: FileDiff) => unknown[]) =>
    diffs.reduce((sum, diff) => sum + pick(diff).length, 0);
  const lines = [
    `${diffs.length} ${diffs.length === 1 ? "file" : "files"} changed since ${ref}: ` +
      `${total((d) => d.added)} added, ${total((d) => d.removed)} removed, ` +
      `${total((d) => d.signature)} signature changed, ${total((d) => d.body)} body changed`,
  ];

  for (const diff of diffs) {
    lines.push(diff.file);

    for (const { before, after } of diff.signature) {
      lines.push(`  ~ ${label(after)}  ${after.signature}`, `      was ${before.signature}`);
      const callers = callersOf(session, after.id);
      if (callers.length > 0) lines.push(`      ${callerLine(callers, after)}`);
    }
    for (const symbol of diff.removed) {
      lines.push(`  - ${label(symbol)}  ${symbol.signature}`);
      const files = namedIn(session, symbol);
      if (files.length > 0) lines.push(`      still named in ${files.join(", ")}`);
    }
    for (const symbol of diff.added) lines.push(`  + ${label(symbol)}  ${symbol.signature}`);
    for (const symbol of diff.body) lines.push(`  · ${label(symbol)}  body changed`);
  }

  return { output: lines.join("\n"), ok: true };
}

function label(symbol: IndexedSymbol): string {
  return `${symbol.id.slice(0, 4)} ${qualifiedName(symbol)}`;
}

function callersOf(session: QuerySession, id: string): IndexedSymbol[] {
  return (session.graph.callers[id] ?? [])
    .map((caller) => session.symbols.symbols[caller])
    .filter((symbol): symbol is IndexedSymbol => symbol !== undefined)
    .sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

function callerLine(callers: IndexedSymbol[], symbol: IndexedSymbol): string {
  const shown = callers
    .slice(0, MAX_CALLERS)
    .map((caller) => `${qualifiedName(caller)} (${caller.file}:${caller.startLine})`)
    .join(", ");
  const rest = callers.length - MAX_CALLERS;
  return `called by ${shown}${rest > 0 ? `, and ${rest} more: orvix who-calls ${symbol.id.slice(0, 4)}` : ""}`;
}

/**
 * Files whose call sites still name a removed symbol. There is no edge to a
 * symbol that no longer exists, so the reference by name is what is left — a
 * likely breakage, though a same-named symbol elsewhere could be the target.
 */
function namedIn(session: QuerySession, symbol: IndexedSymbol): string[] {
  const files = session.graph.refsByName[symbol.name] ?? [];
  return files.filter((file) => file !== "*" && file !== symbol.file);
}

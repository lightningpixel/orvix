import { isAbsolute, relative, resolve, sep } from "node:path";
import { markDirty } from "../core/state.js";
import { loadGraph, loadSymbols } from "../core/store.js";
import { qualifiedName } from "../core/symbols.js";
import { renderList } from "../render/symbol.js";
import type { IndexedSymbol, PersistedGraph, SymbolTable } from "../types.js";
import { openQuery, type CommandResult } from "../query/session.js";

/** Callers listed per symbol before the rest is left to `who-calls`. */
const MAX_LISTED = 8;

/**
 * `orvix-query edited <file>` — what an edit just broke, or nothing.
 *
 * Run by the edit hook straight after the agent writes a file. The symbols the
 * index held for that file are read first; the file is then reindexed and its
 * new symbols compared by id, which is exactly what ids are stable for: a body
 * edit keeps every id and every signature, so it says nothing.
 *
 * Two changes are reported, and only when something calls the symbol: a
 * signature that differs, and a symbol that no longer exists. Everything else
 * an edit does is the agent's own business and costs no context.
 */
export async function runEdited(path: string, file: string): Promise<CommandResult> {
  const root = resolve(path);
  const target = toProjectPath(root, file);
  if (!target) return { output: "", ok: true };

  const [before, beforeGraph] = await Promise.all([loadSymbols(root), loadGraph(root)]);
  const previous = symbolsOf(before, target);

  await markDirty(root, [target]);
  const session = await openQuery(root);
  const current = new Map(symbolsOf(session.symbols, target).map((s) => [s.id, s]));

  const sections: string[] = [];

  for (const old of previous) {
    const now = current.get(old.id);

    if (!now) {
      // Its edges went with it, so the callers are the ones it had before.
      const callers = callersIn(before, beforeGraph, old.id);
      if (callers.length === 0) continue;
      sections.push(
        `${qualifiedName(old)} no longer exists in ${target}, but ${callers.length} ${plural(callers.length, "symbol")} still called it:\n` +
          listed(callers, before, beforeGraph, old.id),
      );
      continue;
    }

    if (now.signature === old.signature) continue;

    const callers = callersIn(session.symbols, session.graph, now.id);
    const fileScope = session.graph.fileCallers[now.id] ?? [];
    if (callers.length === 0 && fileScope.length === 0) continue;

    const lines = [
      `${qualifiedName(now)} [${now.id.slice(0, 4)}] changed signature in ${target}`,
      `  before: ${old.signature}`,
      `  after:  ${now.signature}`,
    ];
    if (callers.length > 0) {
      lines.push(
        `${callers.length} ${plural(callers.length, "caller")} may need updating:`,
        listed(callers, session.symbols, session.graph, now.id),
      );
    }
    if (fileScope.length > 0) {
      lines.push(`also called at file scope from ${fileScope.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  return { output: sections.length > 0 ? `orvix: ${sections.join("\n\n")}` : "", ok: true };
}

function symbolsOf(table: SymbolTable, file: string): IndexedSymbol[] {
  return (table.byFile[file] ?? [])
    .map((id) => table.symbols[id])
    .filter((symbol): symbol is IndexedSymbol => symbol !== undefined);
}

function callersIn(table: SymbolTable, graph: PersistedGraph, id: string): IndexedSymbol[] {
  return (graph.callers[id] ?? [])
    .map((caller) => table.symbols[caller])
    .filter((symbol): symbol is IndexedSymbol => symbol !== undefined)
    .sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

function listed(
  callers: IndexedSymbol[],
  table: SymbolTable,
  graph: PersistedGraph,
  id: string,
): string {
  const shown = renderList(callers.slice(0, MAX_LISTED), table, graph);
  const rest = callers.length - MAX_LISTED;
  return rest > 0 ? `${shown}\n… ${rest} more: orvix who-calls ${id.slice(0, 4)}` : shown;
}

function toProjectPath(root: string, file: string): string | undefined {
  const rel = isAbsolute(file) ? relative(root, file) : file;
  if (rel.length === 0 || rel.startsWith("..")) return undefined;
  return rel.split(sep).join("/").replace(/\\/g, "/");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

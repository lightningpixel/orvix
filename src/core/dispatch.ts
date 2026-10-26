import type { DispatchRecord, IndexedSymbol, OrvixIndex } from "../types.js";
import { familyForPath } from "./languages.js";
import { groupByName, groupExportedByName, importedSymbols } from "./resolve.js";

/**
 * Links each dispatch on a channel to every handler registered on it.
 *
 * A handler's name is resolved exactly as a bare call would be — this file,
 * then its imports, then a project-unique exported name in the same family —
 * and one that does not resolve to a single function is dropped, not guessed.
 * All handlers on a channel receive its dispatches, so several handlers mean
 * several links, not an ambiguity.
 *
 * Recomputed from the facts in full on every index, incremental or not. It is
 * a pass over channel sites alone, which are few, and deriving it whole is
 * what keeps an incremental index identical to a rebuilt one without a
 * separate invalidation rule.
 */
export function buildDispatch(
  index: OrvixIndex,
  packageOf: (file: string) => string = () => "",
): Record<string, DispatchRecord[]> {
  // Keyed by package as well as channel: see packages.ts.
  const handlers = new Map<string, Set<string>>();
  const dispatchers = new Map<string, Set<string>>();
  const exportedByName = groupExportedByName(index);

  for (const [file, entry] of Object.entries(index.files)) {
    if (!entry.channels) continue;
    const local = groupByName(entry.symbols);
    const imported = importedSymbols(index, file, entry);
    const family = familyForPath(file);

    const pkg = packageOf(file);
    for (const site of entry.channels) {
      const key = `${pkg}\u0000${site.channel}`;
      if (site.role === "dispatch") {
        const from = site.fromSymbol === null ? undefined : entry.symbols[site.fromSymbol]?.id;
        if (from) add(dispatchers, key, from);
        continue;
      }

      const name = site.handler!;
      const functions = (bucket: IndexedSymbol[] | undefined) => {
        const found = bucket?.filter((symbol) => symbol.kind !== "method");
        return found && found.length > 0 ? found : undefined;
      };
      const candidates =
        functions(local.get(name)) ??
        functions(imported.get(name)) ??
        functions(exportedByName.get(name)?.filter((s) => familyForPath(s.file) === family));
      if (candidates?.length === 1) add(handlers, key, candidates[0]!.id);
    }
  }

  const dispatch: Record<string, DispatchRecord[]> = Object.create(null);
  for (const [key, ids] of handlers) {
    const channel = key.slice(key.indexOf("\u0000") + 1);
    for (const handler of ids) {
      const from = [...(dispatchers.get(key) ?? [])].filter((id) => id !== handler);
      if (from.length === 0) continue;
      dispatch[handler] = [
        ...(dispatch[handler] ?? []),
        ...from.map((caller) => ({ from: caller, channel })),
      ].sort((a, b) => a.from.localeCompare(b.from) || a.channel.localeCompare(b.channel));
    }
  }
  return dispatch;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(value);
  else map.set(key, new Set([value]));
}

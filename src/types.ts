export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "constant";

/** A definition as found in one file, before cross-file resolution. */
export interface RawSymbol {
  name: string;
  kind: SymbolKind;
  /** One-line rendering of the declaration, body excluded. */
  signature: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  /** Visible outside its file, by whatever rule the language uses. */
  exported: boolean;
  /** Name of the enclosing class, interface or enum, if any. */
  container?: string;
}

/** A call site, before it is matched to a definition. */
export interface RawReference {
  /** The callee as written: the bare name, without any receiver. */
  name: string;
  line: number;
  byte: number;
  /** Index into the file's symbols, or null for a call at file scope. */
  fromSymbol: number | null;
  /** Called through a receiver (`obj.name()`), so only a method can match. */
  viaMember: boolean;
  /**
   * The class the receiver is declared as, when the source says: `r: Repo`,
   * `new Repo()`, `this` inside Repo. Absent when it does not.
   */
  receiver?: string;
}

export interface RawImport {
  /** The module specifier, exactly as written. */
  source: string;
  /** Local names this import binds. */
  names: string[];
  line: number;
}

/** A call made through a channel name; see src/core/channels.ts. */
export interface RawChannel {
  role: "listen" | "dispatch";
  channel: string;
  /** The handler's name, for a registration. */
  handler?: string;
  line: number;
  byte: number;
  /** Index into the file's symbols, or null at file scope. */
  fromSymbol: number | null;
}

/** Everything Orvix reads out of a single file. */
export interface FileFacts {
  symbols: RawSymbol[];
  references: RawReference[];
  imports: RawImport[];
  /** Absent for languages that have none, which keeps their facts as they were. */
  channels?: RawChannel[];
}

/** A symbol once it belongs to a project-wide index. */
export interface IndexedSymbol extends RawSymbol {
  id: string;
  /** Posix-style path relative to the project root. */
  file: string;
}

/** One file's cached facts, plus what is needed to tell whether they are stale. */
export interface FileEntry {
  language: string;
  mtimeMs: number;
  size: number;
  symbols: IndexedSymbol[];
  references: RawReference[];
  imports: RawImport[];
  channels?: RawChannel[];
}

export interface OrvixIndex {
  version: number;
  /** Keyed by posix-style path relative to the project root. */
  files: Record<string, FileEntry>;
}

export interface IndexStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Files discovered but not indexable — see BuildResult.skippedFiles. */
  skipped: number;
}

/**
 * The lookup-shaped view of an index, written at index time and read by every
 * query.
 *
 * Split out from the raw facts because a query needs symbols and never needs
 * call sites, and call sites are the bulk: 226 symbols against 2 263
 * references in this repo's own index. Keeping them apart is what stops query
 * cost from tracking total project size.
 */
export interface SymbolTable {
  version: number;
  /** Every symbol, keyed by id. */
  symbols: Record<string, IndexedSymbol>;
  /** Lowercased bare and qualified names -> ids. */
  byName: Record<string, string[]>;
  /** File -> its symbol ids, in source order. */
  byFile: Record<string, string[]>;
  /** Id -> PageRank score, computed at index time rather than per query. */
  ranks: Record<string, number>;
}

/**
 * The resolved call graph, persisted rather than rebuilt on every query.
 *
 * `refsByName` and `exportSig` exist for incremental reindexing: together they
 * answer "which files might resolve differently now that this file changed?"
 * without reparsing anything.
 */
export interface PersistedGraph {
  version: number;
  /** Callee id -> caller ids. */
  callers: Record<string, string[]>;
  /** Caller id -> callee ids. */
  callees: Record<string, string[]>;
  /** Callee id -> files calling it from file scope, outside any symbol. */
  fileCallers: Record<string, string[]>;
  /**
   * Referenced name -> files containing a reference to it, resolved or not.
   * Unresolved names are kept because a name that resolves to nothing today
   * starts resolving the moment something exports it.
   */
  refsByName: Record<string, string[]>;
  /** File -> hash of its exported surface, insensitive to body-only edits. */
  exportSig: Record<string, string>;
  ambiguous: AmbiguousCallRecord[];
  /**
   * Handler id -> the symbols that dispatch to it by channel name. Kept apart
   * from `callers`: a matching string is weaker evidence than a call.
   */
  dispatch: Record<string, DispatchRecord[]>;
  /** Unresolved call sites per file, so a partial rebuild can replace its own. */
  unresolvedByFile: Record<string, number>;
  unresolved: number;
}

export interface DispatchRecord {
  from: string;
  channel: string;
}

/** A call site that matched several definitions, kept rather than guessed at. */
export interface AmbiguousCallRecord {
  from: string | null;
  name: string;
  file: string;
  line: number;
  candidates: string[];
}

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
}

export interface RawImport {
  /** The module specifier, exactly as written. */
  source: string;
  /** Local names this import binds. */
  names: string[];
  line: number;
}

/** Everything Orvix reads out of a single file. */
export interface FileFacts {
  symbols: RawSymbol[];
  references: RawReference[];
  imports: RawImport[];
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

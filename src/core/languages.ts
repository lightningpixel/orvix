import { extname } from "node:path";

export interface LanguageDef {
  /** Stable identifier. */
  id: string;
  /** Grammar filename inside grammars/. */
  grammar: string;
  /** Extensions this language claims. Lowercase, dot-prefixed, unique across the registry. */
  extensions: string[];
  /** Basename of the query file in queries/. Defaults to `id`. */
  queryId?: string;
  /**
   * Languages that can call into each other. Defaults to `id`, so a language
   * is its own family and resolution never crosses it.
   */
  family?: string;
  /**
   * Whether a call written without a receiver may still reach a method.
   *
   * True where every function is a member and `helper()` inside a class means
   * `this.helper()` — Java, C#, C++. False where a method always needs its
   * receiver spelled out, so a bare `helper()` can only be a free function:
   * ECMAScript, Python (`self.`), Go, Rust (`self.`).
   */
  implicitReceiver?: boolean;
}

/** See `LanguageDef.implicitReceiver`. */
export function allowsImplicitReceiver(path: string): boolean {
  return languageForPath(path)?.implicitReceiver === true;
}

/** The family a language resolves within. */
export function familyOf(language: LanguageDef): string {
  return language.family ?? language.id;
}

/**
 * The family a file's calls may reach, or undefined for an unindexed path.
 *
 * Resolution by project-unique name has no type information to fall back on,
 * so without this a TypeScript `xs.filter(…)` matches a Python method named
 * `filter` purely because the name is unique — an edge that cannot exist.
 */
export function familyForPath(path: string): string | undefined {
  const language = languageForPath(path);
  return language ? familyOf(language) : undefined;
}

/** Which queries/<name>.scm file drives this language's extraction. */
export function queryIdOf(language: LanguageDef): string {
  return language.queryId ?? language.id;
}

/**
 * The languages Orvix can index. Adding one means: an entry here, a matching
 * grammar in scripts/copy-grammars.mjs, and a queries/<id>.scm tag query.
 */
export const LANGUAGES: readonly LanguageDef[] = [
  {
    id: "typescript",
    grammar: "tree-sitter-typescript.wasm",
    extensions: [".ts", ".mts", ".cts"],
    // TypeScript, TSX and JavaScript are one module system: a .tsx importing
    // from a .ts is an ordinary call, not a crossing.
    family: "ecmascript",
  },
  {
    id: "tsx",
    grammar: "tree-sitter-tsx.wasm",
    extensions: [".tsx"],
    // The tsx grammar is the typescript grammar plus JSX; the node types the
    // tag query relies on are identical, so the query is shared.
    queryId: "typescript",
    family: "ecmascript",
  },
  {
    id: "javascript",
    grammar: "tree-sitter-javascript.wasm",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    family: "ecmascript",
  },
  {
    id: "python",
    grammar: "tree-sitter-python.wasm",
    extensions: [".py", ".pyi"],
  },
  { id: "go", grammar: "tree-sitter-go.wasm", extensions: [".go"] },
  {
    id: "java",
    grammar: "tree-sitter-java.wasm",
    extensions: [".java"],
    implicitReceiver: true,
  },
  {
    id: "csharp",
    grammar: "tree-sitter-c-sharp.wasm",
    extensions: [".cs"],
    implicitReceiver: true,
  },
  {
    id: "cpp",
    grammar: "tree-sitter-cpp.wasm",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    // C++ calls into C without ceremony, so the two resolve into each other.
    family: "c",
    implicitReceiver: true,
  },
  {
    id: "c",
    // @vscode/tree-sitter-wasm ships no C grammar. The C++ one parses C
    // without error, and the tags a C file can produce are a subset, so the
    // query is shared too.
    grammar: "tree-sitter-cpp.wasm",
    extensions: [".c", ".h"],
    queryId: "cpp",
    family: "c",
    // C itself has no methods, so this changes nothing for a C file. It is
    // set because `.h` is claimed here and a C++ header does have them.
    implicitReceiver: true,
  },
  { id: "rust", grammar: "tree-sitter-rust.wasm", extensions: [".rs"] },
];

const BY_EXTENSION = new Map<string, LanguageDef>(
  LANGUAGES.flatMap((language) =>
    language.extensions.map((ext) => [ext, language] as const),
  ),
);

export function languageForPath(path: string): LanguageDef | undefined {
  return BY_EXTENSION.get(extname(path).toLowerCase());
}

export function supportedExtensions(): string[] {
  return [...BY_EXTENSION.keys()];
}

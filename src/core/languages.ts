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

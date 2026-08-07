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
  },
  {
    id: "tsx",
    grammar: "tree-sitter-tsx.wasm",
    extensions: [".tsx"],
    // The tsx grammar is the typescript grammar plus JSX; the node types the
    // tag query relies on are identical, so the query is shared.
    queryId: "typescript",
  },
  {
    id: "javascript",
    grammar: "tree-sitter-javascript.wasm",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
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

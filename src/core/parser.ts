import { join } from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";
import type { LanguageDef } from "./languages.js";
import { grammarsDir } from "./paths.js";

let runtime: Promise<void> | undefined;
const grammars = new Map<string, Promise<Language>>();

/** Emscripten runtime init is global and must happen exactly once per process. */
function initRuntime(): Promise<void> {
  runtime ??= Parser.init();
  return runtime;
}

/**
 * Loads a grammar, memoised per language: compiling a .wasm grammar costs tens
 * of milliseconds and an index run parses thousands of files.
 */
export async function loadLanguage(def: LanguageDef): Promise<Language> {
  await initRuntime();

  let loading = grammars.get(def.id);
  if (!loading) {
    loading = Language.load(join(grammarsDir(), def.grammar));
    grammars.set(def.id, loading);
  }

  return loading;
}

/**
 * Parses source into a syntax tree. Syntax errors are not thrown: tree-sitter
 * recovers and marks the tree, so a broken file still yields the symbols
 * around the breakage.
 */
export async function parse(source: string, def: LanguageDef): Promise<Tree> {
  // Must resolve before `new Parser()`: the Emscripten runtime is not ready
  // until init() settles, and loadLanguage() awaits it.
  const language = await loadLanguage(def);

  const parser = new Parser();
  parser.setLanguage(language);

  const tree = parser.parse(source);
  parser.delete();

  if (!tree) throw new Error(`failed to parse ${def.id} source`);
  return tree;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Query, type Node, type Tree } from "web-tree-sitter";
import type {
  FileFacts,
  RawImport,
  RawReference,
  RawSymbol,
  SymbolKind,
} from "../types.js";
import { queryIdOf, type LanguageDef } from "./languages.js";
import { loadLanguage, parse } from "./parser.js";
import { queriesDir } from "./paths.js";

/** Kinds that other definitions can be nested inside. */
const CONTAINER_KINDS = new Set<SymbolKind>(["class", "interface", "enum"]);

/**
 * Node types that open a local scope.
 *
 * Anything declared inside one is a local — a helper closure, a temporary
 * variable — and indexing it buries the file's real surface under noise.
 *
 * This is judged from the syntax tree rather than from the symbols already
 * found, because the enclosing function is often anonymous and therefore not
 * a symbol at all: `test("…", () => { const root = … })` would otherwise
 * index `root`.
 */
const ECMASCRIPT_SCOPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

const CPP_SCOPES = new Set(["function_definition", "lambda_expression"]);

const LOCAL_SCOPES: Record<string, Set<string>> = {
  typescript: ECMASCRIPT_SCOPES,
  tsx: ECMASCRIPT_SCOPES,
  javascript: ECMASCRIPT_SCOPES,
  python: new Set(["function_definition", "lambda"]),
  go: new Set(["function_declaration", "method_declaration", "func_literal"]),
  rust: new Set(["function_item", "closure_expression"]),
  java: new Set([
    "method_declaration",
    "constructor_declaration",
    "lambda_expression",
  ]),
  csharp: new Set([
    "method_declaration",
    "constructor_declaration",
    "accessor_declaration",
    "local_function_statement",
    "lambda_expression",
  ]),
  cpp: CPP_SCOPES,
  c: CPP_SCOPES,
};

/**
 * When two patterns claim the same declaration, the higher number wins.
 * The case that matters is `const f = () => {}`, which is both a function
 * and a lexical constant — it should read as a function.
 */
const KIND_PRIORITY: Record<SymbolKind, number> = {
  function: 6,
  method: 5,
  class: 4,
  interface: 3,
  enum: 2,
  type: 1,
  constant: 0,
};

const MAX_SIGNATURE_LENGTH = 140;

/** How far below a declaration to look for the body that ends its signature. */
const BODY_SEARCH_DEPTH = 3;

const queries = new Map<string, Promise<Query>>();

/** Compiling a query is expensive relative to parsing, so it is done once. */
async function loadQuery(def: LanguageDef): Promise<Query> {
  let loading = queries.get(def.id);

  if (!loading) {
    loading = (async () => {
      const [language, source] = await Promise.all([
        loadLanguage(def),
        readFile(join(queriesDir(), `${queryIdOf(def)}.scm`), "utf8"),
      ]);
      return new Query(language, source);
    })();

    // Drop a rejected promise from the cache, so a transient failure is not
    // remembered for the rest of the process.
    loading.catch(() => queries.delete(def.id));
    queries.set(def.id, loading);
  }

  return loading;
}

/**
 * Reads the definitions, call sites and imports out of one file's source.
 *
 * Everything here is local to the file: names are recorded as written, and
 * matching a call to the definition it reaches is resolve.ts's job.
 */
export async function extractFile(
  source: string,
  def: LanguageDef,
): Promise<FileFacts> {
  const [query, tree] = await Promise.all([loadQuery(def), parse(source, def)]);

  try {
    return collect(query, tree, source, def);
  } finally {
    tree.delete();
  }
}

function collect(
  query: Query,
  tree: Tree,
  source: string,
  def: LanguageDef,
): FileFacts {
  const symbols: RawSymbol[] = [];
  const pendingRefs: Array<Omit<RawReference, "fromSymbol">> = [];
  const imports: RawImport[] = [];

  for (const match of query.matches(tree.rootNode)) {
    const named = match.captures.find((c) => c.name === "name")?.node;
    const tagged = match.captures.find((c) => c.name !== "name");
    if (!tagged) continue;

    if (tagged.name === "import") {
      imports.push(readImport(tagged.node));
      continue;
    }

    if (!named) continue;

    if (tagged.name === "reference.call" || tagged.name === "reference.method") {
      pendingRefs.push({
        name: named.text,
        line: named.startPosition.row + 1,
        byte: named.startIndex,
        viaMember: tagged.name === "reference.method",
      });
      continue;
    }

    const kind = tagged.name.startsWith("definition.")
      ? (tagged.name.slice("definition.".length) as SymbolKind)
      : undefined;
    if (!kind) continue;
    if (isLocal(tagged.node, def.id)) continue;

    symbols.push({
      name: named.text,
      kind,
      signature: signatureOf(tagged.node, source),
      startLine: tagged.node.startPosition.row + 1,
      endLine: tagged.node.endPosition.row + 1,
      startByte: tagged.node.startIndex,
      endByte: tagged.node.endIndex,
      exported: isExported(tagged.node, named.text, def.id),
    });
  }

  const kept = dropConstructors(
    dedupe(symbols).sort((a, b) => a.startByte - b.startByte),
    def.id,
  );
  assignContainers(kept);
  promoteToMethods(kept);
  if (!STATES_MEMBER_VISIBILITY.has(def.id)) {
    inheritExportedFromContainer(kept);
  }

  const references: RawReference[] = pendingRefs
    .sort((a, b) => a.byte - b.byte)
    .map((ref) => ({ ...ref, fromSymbol: enclosingIndex(kept, ref.byte) }));

  return { symbols: kept, references, imports };
}

/** True when the declaration sits inside a function body rather than at file or class scope. */
function isLocal(node: Node, languageId: string): boolean {
  const scopes = LOCAL_SCOPES[languageId];
  if (!scopes) return false;

  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (scopes.has(ancestor.type)) return true;
    if (isLocalBlock(ancestor, languageId)) return true;
  }

  return false;
}

const ECMASCRIPT = new Set(["typescript", "tsx", "javascript"]);

/**
 * A block at file scope — the body of a top-level `try`, `if` or bare `{ }` —
 * holds block-scoped names that nothing outside it can reach. A namespace's
 * body is a block in the grammar too, but its members are the namespace's
 * surface, so that one is kept.
 */
function isLocalBlock(node: Node, languageId: string): boolean {
  if (!ECMASCRIPT.has(languageId) || node.type !== "statement_block") return false;
  const parent = node.parent?.type;
  return parent !== "internal_module" && parent !== "module";
}

/**
 * A function declared inside a class is a method, whatever the grammar calls
 * it. Python and Go have no distinct node type for one, so the distinction is
 * made from containment instead of from a per-language query pattern.
 */
function promoteToMethods(symbols: RawSymbol[]): void {
  for (const symbol of symbols) {
    if (symbol.kind === "function" && symbol.container) symbol.kind = "method";
  }
}

/**
 * Languages with no constructor node, where a constructor is an ordinary
 * function definition that happens to carry its class's name. Java and C# name
 * theirs in the grammar, so their queries simply do not tag them.
 */
const CONSTRUCTORS_LOOK_LIKE_FUNCTIONS = new Set(["cpp", "c"]);

/**
 * Drops constructors, which duplicate the name of the type they build.
 *
 * Left indexed, `S` names both the class and its constructor: `show S` becomes
 * ambiguous, and every call site naming S matches two candidates so no edge is
 * drawn at all. Nothing is lost — a constructor is not separately addressable,
 * and its source sits inside the class's range.
 */
function dropConstructors(symbols: RawSymbol[], languageId: string): RawSymbol[] {
  if (!CONSTRUCTORS_LOOK_LIKE_FUNCTIONS.has(languageId)) return symbols;

  const types = new Set(
    symbols.filter((s) => CONTAINER_KINDS.has(s.kind)).map((s) => s.name),
  );
  if (types.size === 0) return symbols;

  return symbols.filter(
    (symbol) => !types.has(symbol.name) || CONTAINER_KINDS.has(symbol.kind),
  );
}

/**
 * Languages where a member carries its own visibility, so the enclosing type
 * must not speak for it. `private int shut()` inside a public class is
 * private, and saying otherwise contradicts the source.
 */
const STATES_MEMBER_VISIBILITY = new Set(["java", "csharp"]);

/**
 * A public method of an exported class is part of the file's public surface
 * even though nothing exports it directly.
 *
 * Only for languages where a member cannot say otherwise — see
 * STATES_MEMBER_VISIBILITY.
 */
function inheritExportedFromContainer(symbols: RawSymbol[]): void {
  const exportedContainers = new Set(
    symbols
      .filter((symbol) => symbol.exported && CONTAINER_KINDS.has(symbol.kind))
      .map((symbol) => symbol.name),
  );

  for (const symbol of symbols) {
    if (symbol.container && exportedContainers.has(symbol.container)) {
      symbol.exported = true;
    }
  }
}

/** Collapses declarations matched by more than one pattern into the best kind. */
function dedupe(symbols: RawSymbol[]): RawSymbol[] {
  const best = new Map<string, RawSymbol>();

  for (const symbol of symbols) {
    const key = `${symbol.startByte}:${symbol.name}`;
    const existing = best.get(key);
    if (!existing || KIND_PRIORITY[symbol.kind] > KIND_PRIORITY[existing.kind]) {
      best.set(key, symbol);
    }
  }

  return [...best.values()];
}

/**
 * Nesting is derived from byte ranges rather than from the syntax tree, so the
 * rule holds for any language without a per-grammar list of container nodes.
 */
function assignContainers(symbols: RawSymbol[]): void {
  symbols.forEach((symbol, index) => {
    const parent = enclosingIndex(
      symbols,
      symbol.startByte,
      (candidate, i) => i !== index && CONTAINER_KINDS.has(candidate.kind),
    );
    if (parent !== null) symbol.container = symbols[parent]!.name;
  });
}

/** Index of the tightest symbol whose range covers `byte`, or null. */
function enclosingIndex(
  symbols: RawSymbol[],
  byte: number,
  accept: (symbol: RawSymbol, index: number) => boolean = () => true,
): number | null {
  let found: number | null = null;
  let smallest = Infinity;

  symbols.forEach((symbol, index) => {
    if (byte < symbol.startByte || byte >= symbol.endByte) return;
    if (!accept(symbol, index)) return;

    const span = symbol.endByte - symbol.startByte;
    if (span < smallest) {
      smallest = span;
      found = index;
    }
  });

  return found;
}

/** The declaration text with its body removed, collapsed onto one line. */
function signatureOf(node: Node, source: string): string {
  const bodyStart = findBodyStart(node, BODY_SEARCH_DEPTH);
  const end =
    bodyStart !== undefined && bodyStart > node.startIndex
      ? bodyStart
      : node.endIndex;

  const text = source
    .slice(node.startIndex, end)
    .replace(/\s+/g, " ")
    // Python and Go end a header with punctuation that carries no meaning
    // once the body is gone.
    .replace(/[;,:]\s*$/, "")
    .trim();

  return text.length > MAX_SIGNATURE_LENGTH
    ? `${text.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`
    : text;
}

/**
 * Finds where the body starts, looking a few levels down so that
 * `const f = () => { … }` cuts at the arrow function's body rather than
 * swallowing the whole declaration.
 */
function findBodyStart(node: Node, depth: number): number | undefined {
  if (depth < 0) return undefined;

  const body = node.childForFieldName("body");
  if (body) return body.startIndex;

  for (const child of node.namedChildren) {
    if (!child) continue;
    const found = findBodyStart(child, depth - 1);
    if (found !== undefined) return found;
  }

  return undefined;
}

/**
 * Whether a definition is part of the file's public surface.
 *
 * Every language spells this differently, and none of them can be read off
 * the tag query alone.
 */
function isExported(node: Node, name: string, languageId: string): boolean {
  switch (languageId) {
    case "typescript":
    case "tsx":
    case "javascript": {
      // `export function f() {}` wraps the declaration; `export const x = 1`
      // wraps the lexical_declaration. Neither is more than one level up.
      let ancestor = node.parent;
      for (let step = 0; step < 2 && ancestor; step += 1) {
        if (ancestor.type === "export_statement") return true;
        ancestor = ancestor.parent;
      }
      return false;
    }

    // Go exports by capitalisation.
    case "go":
      return /^\p{Lu}/u.test(name);

    // Python has no export list; the leading-underscore convention is what
    // the ecosystem actually treats as private.
    case "python":
      return !name.startsWith("_");

    // Rust is explicit.
    case "rust":
      return hasChildOfType(node, "visibility_modifier");

    // Java is explicit too, and says private out loud. A package-private
    // member is not part of the surface either, so only `public` counts.
    case "java":
      return /\bpublic\b/.test(modifiersOf(node));

    // C# writes each modifier as its own node rather than grouping them.
    case "csharp":
      return hasChildWithText(node, "modifier", "public");

    // C and C++ have no export list. `static` at file scope is the one thing
    // that genuinely narrows a name's reach, so it is what marks a symbol
    // private; access specifiers inside a class are siblings of the member
    // rather than children, and are not read.
    case "cpp":
    case "c":
      return !hasChildWithText(node, "storage_class_specifier", "static");

    default:
      return false;
  }
}

/**
 * The `modifiers` child of a Java declaration, or "" when it has none.
 *
 * Read as text rather than by walking children because annotations,
 * `@Override` among them, sit in the same node as the access keywords.
 */
function modifiersOf(node: Node): string {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child?.type === "modifiers") return child.text;
  }
  return "";
}

/** Whether a direct child of this type carries exactly this text. */
function hasChildWithText(node: Node, type: string, text: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child?.type === type && child.text === text) return true;
  }
  return false;
}

function hasChildOfType(node: Node, type: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index)?.type === type) return true;
  }
  return false;
}

function readImport(node: Node): RawImport {
  const sourceNode = node.childForFieldName("source");
  const raw = sourceNode?.text ?? "";

  return {
    source: raw.replace(/^['"`]|['"`]$/g, ""),
    names: importedNames(node),
    line: node.startPosition.row + 1,
  };
}

/** Local names an import binds, following aliases. */
function importedNames(statement: Node): string[] {
  const clause = statement.namedChildren.find(
    (child) => child?.type === "import_clause",
  );
  if (!clause) return [];

  const names: string[] = [];

  const visit = (node: Node): void => {
    if (node.type === "import_specifier") {
      const bound =
        node.childForFieldName("alias") ?? node.childForFieldName("name");
      if (bound) names.push(bound.text);
      return;
    }

    if (node.type === "identifier") {
      names.push(node.text);
      return;
    }

    for (const child of node.namedChildren) if (child) visit(child);
  };

  for (const child of clause.namedChildren) if (child) visit(child);

  return names;
}

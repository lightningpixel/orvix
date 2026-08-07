# orvix

**A semantic code map for AI agents.** Index a codebase once, address every symbol by a short
code, and read only the function you actually need.

Coding agents spend most of their context rediscovering structure: `ls`, then `grep`, then
reading an eight-hundred-line file to use twenty lines of it. Orvix replaces that with an index
you query directly.

```bash
$ orvix map --budget 800
src/core/resolve.ts
  om2v *interface CallGraph  :20
  mgp4 *function buildCallGraph(index: OrvixIndex): CallGraph  :62 ←5
  … 12 more
src/core/parser.ts
  fv6o *async function loadLanguage(def: LanguageDef): Promise<Language>  :19 ←2
  l00y *async function parse(source: string, def: LanguageDef): Promise<Tree>  :36 ←2

$ orvix show l00y       # the exact source of that one function, nothing else
$ orvix who-calls l00y  # every symbol that calls parse
```

`*` marks an exported symbol, `:62` is the line, `←5` is the number of callers.

## Measured savings

Both figures are from running Orvix on its own source:

| Task | Reading files | With orvix | Saved |
|---|---|---|---|
| Target one function to edit it | 1 671 tokens | 170 tokens | **90 %** |
| Take in the whole project's shape | 17 857 tokens | 1 975 tokens | **89 %** |

## Install

```bash
npm install -g orvix     # or: npx orvix map
```

Node 20 or later. Pure JavaScript and WebAssembly — no native build step, nothing to compile.

## Commands

| Command | What it does |
|---|---|
| `orvix index [path]` | Build or refresh the cache; prints what changed |
| `orvix map [path]` | The symbol tree, ranked, fitted to `--budget <tokens>` (default 2000) |
| `orvix show <id\|name>` | The exact source of one symbol |
| `orvix find <query>` | Search symbols by name or signature |
| `orvix who-calls <id\|name>` | Everything that calls this symbol |
| `orvix calls <id\|name>` | Everything this symbol calls |

Every command takes `--json` for machine-readable output and `--no-refresh` to answer straight
from the cache. `show`, `find`, `who-calls` and `calls` take `-p <path>` to point at another
project.

You never have to hold onto an id. `orvix show validate`, `orvix show Service.validate` and
`orvix show a4f2` all work.

### Ids

An id is derived from `file :: qualified name :: kind`, and deliberately not from the symbol's
contents. **Editing a function's body does not change its id** — an id an agent was given three
turns ago still points at the right symbol. Renaming or moving the symbol does change it.

Ids are shown four characters wide and resolved by prefix, like git hashes. If a project grows
enough to need five, ids quoted earlier keep resolving.

## For agents

Paste this into your `CLAUDE.md`, `AGENTS.md`, or equivalent:

```markdown
## Codebase navigation

This project is indexed by orvix. Prefer it over grep and over reading whole files.

- `orvix map --budget 2000` — the project's symbols, most important first
- `orvix show <id>` — one symbol's exact source (do not read the whole file)
- `orvix find <name>` — locate a symbol when you don't have its id
- `orvix who-calls <id>` — find every caller before changing a signature
- `orvix calls <id>` — see what a function depends on

Ids are stable across edits; reuse one you were given earlier rather than re-running `map`.
```

## Languages

TypeScript · TSX · JavaScript · Python · Go · Rust

Adding one means three things: an entry in `src/core/languages.ts`, its grammar in
`scripts/copy-grammars.mjs`, and a tag query in `queries/<id>.scm`.

## What the call graph does and does not know

Resolution is **syntactic**. Tree-sitter reports names and imports, not types, so Orvix matches a
call to a definition in this order: same file, then through an import, then a project-wide unique
exported name.

It is deliberately conservative:

- A call through a receiver (`obj.run()`) can only reach a **method**; a bare call (`run()`) can
  only reach a non-method. Without this, every `JSON.parse(…)` in a project looks like a call to
  your own `parse` function.
- When several definitions remain plausible, **no edge is drawn**. `orvix index` reports the
  count of such call sites. Guessing would be worse than admitting the gap.
- Calls into third-party libraries resolve to nothing, by design.

Known limits: type references are not call edges, so an interface shows no callers — ranking
compensates by biasing toward exported symbols. Import following is implemented for ECMAScript
module paths; Python, Go and Rust rely on same-file scope and project-unique names. Functions
inside a Rust `impl` block are reported without a container.

## What gets indexed

Orvix honours `.gitignore` (including nested ones, with `!` negations) and `.orvixignore`, which
takes precedence. `node_modules`, `.git` and `.orvix` are never walked.

Because plenty of real projects have no `.gitignore` at all, a default set is applied at the
root: `site-packages/`, `bower_components/`, virtualenvs, `__pycache__/`, `dist/`, `build/`,
`target/`, `vendor/`, `coverage/`, framework caches, and minified bundles. Any of them can be put
back with a negation in `.orvixignore`:

```
!dist/
```

Indexing refuses to start above 25 000 files or 64 MB of source, and tells you to add a
`.orvixignore` — an unbounded walk over a virtualenv exhausts memory before producing a single
useful symbol.

## How it works

```
discovery → parse (tree-sitter) → extract → resolve → rank
                                                        ↓
                          .orvix/index.json  →  map / show / find / who-calls / calls
```

The cache stores symbols, call sites and imports per file, keyed by mtime and size, so a repeat
run over an unchanged project costs one `stat()` per file rather than a parse. The call graph and
importance ranking are derived on each run rather than stored — they can never disagree with the
symbols they came from.

Ranking is PageRank over caller→callee edges, personalised toward exported symbols. `--budget` is
honoured by construction: candidate renderings are measured and the largest one that fits is
returned, so output is never cut off mid-line.

## Development

```bash
npm install
npm run build     # copies grammars, bundles the CLI
npm test
```

## License

MIT

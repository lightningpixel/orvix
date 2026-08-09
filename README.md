<div align="center">

# orvix

**A semantic code map for AI agents.**

Index a codebase once, address every symbol by a short code,
and read only the function you actually need.

[Install](#install) · [Commands](#commands) · [Claude Code](#claude-code) · [Numbers](#numbers) · [Limits](#what-the-call-graph-does-not-know)

</div>

---

Coding agents spend most of their context rediscovering structure: `ls`, then `grep`, then
reading an eight-hundred-line file to use twenty lines of it. Orvix replaces that with an index
you query directly.

```console
$ orvix map
src/core/parser.ts
  c6sx  function initRuntime(): Promise<void>  :10 ←1
  fv6o *async function loadLanguage(def: LanguageDef): Promise<Language>  :19 ←2
  l00y *async function parse(source: string, def: LanguageDef): Promise<Tree>  :36 ←2

$ orvix show l00y       # the exact source of that one function, nothing else
$ orvix who-calls l00y  # every symbol that reaches it
rko9 *src/core/extract.ts:113 async function extractFile( source: string, def: LanguageDef, ): Promise<FileFacts> ←4
hau4  test/parser.test.ts:5 function definitionOf(path: string, source: string)
```

`*` marks an exported symbol, `:36` is the line, `←2` is the number of callers.

## Install

```bash
npm install -g orvix-cli
cd your-project
orvix init
```

`orvix init` asks once which agents you use, writes their instruction file, adds `.orvix/` to
`.gitignore`, and builds the index. The answer is remembered, so later projects need no answer.

Node 20 or later. Pure JavaScript and WebAssembly — nothing to compile.

Indexes TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C#, C++ and C.

## Commands

| Command | What it does |
|---|---|
| `orvix init [path]` | Set a project up for agents |
| `orvix index [path]` | Build or refresh the cache |
| `orvix map [path]` | The symbol tree, ranked, fitted to `--budget` |
| `orvix show <id\|name>` | The exact source of one symbol |
| `orvix find <query>` | Search symbols by name or signature |
| `orvix who-calls <id\|name>` | Everything that calls this symbol |
| `orvix calls <id\|name>` | Everything this symbol calls |
| `orvix gain [path]` | Tokens the hooks have saved |

Every command takes `--json`. Queries answer from the prebuilt index and never parse on their
own — that is what keeps them cheap enough to sit behind a hook.

You never have to hold onto an id: `orvix show loadLanguage`, `orvix show Service.validate` and
`orvix show fv6o` all work. When a bare name matches several symbols, they are listed with their
ids so you can pick one.

### Ids are stable

An id derives from `file :: qualified name :: kind`, never from the file's contents. **Editing a
function's body does not change its id** — one an agent was given three turns ago still points at
the right symbol. Renaming or moving it does.

Ids show four characters wide and resolve by prefix, like git hashes.

## Claude Code

Writing instructions into `CLAUDE.md` and hoping they are honoured only goes so far. `orvix init`
also installs three hooks and registers them, merging with whatever is already in
`.claude/settings.json`.

| Hook | When | What it does |
|---|---|---|
| `orvix-dirty` | after `Edit`, `Write` | Marks the file dirty. Async, so it costs the turn nothing. |
| `orvix-compress` | after `Read`, `Grep`, `Bash` | Replaces the result with its symbol map before the model sees it. |
| `orvix-reconcile` | when the turn ends | Full reindex in the background, as a safety net. |

Nothing here asks the model to cooperate — the compression hook reads `.orvix/symbols.json`
directly and never runs an `orvix` command. The scripts are plain `.mjs` with no imports beyond
`node:*`, so they port to any agent that can run a script and speak JSON on stdin.

Both compressions are on by default. To turn one off without touching your agent's config:

```jsonc
// .orvix/config.json
{ "compressRead": false, "compressSearch": true }
```

**What hooks cannot do is create initiative.** A hook only reacts to a tool call the model already
decided to make, so `orvix who-calls` before a signature change still depends on the instruction
block. Compression is mechanical; navigation is a recommendation.

## Numbers

Every figure comes from a command in this repository, measured on Orvix's own source — 75 files,
405 symbols, 1 201 call edges, 0 call sites too ambiguous to link — on Windows with Node 24.
Re-run them; they will differ on your machine.

**Reading one symbol instead of one file** — `npm run measure`

| Task | Reading files | With orvix | Saved |
|---|---|---|---|
| Target one function to edit it | ~2,032 | ~235 | **88%** |
| Take in the whole project's shape | ~35,199 | ~1,994 | **94%** |

**What the hooks actually replace** — `npm run benchmark`

Recorded tool results replayed through the real hook scripts: **69.9% saved, nothing lost.**
`preserved` is the number that matters — each fixture names what the task needed from that
output, and the run fails if a compression drops it. Tokens saved alone is meaningless; returning
an empty string would score perfectly. This runs in CI on every commit.

**Query latency** — `npm run bench`

```
node floor      55.6 ms      ← nothing here can go below this
orvix overhead  27.2 ms
query total     82.9 ms
```

Node's own startup is two thirds of it. That ceiling is why the query path carries no CLI
framework and never loads a grammar — a hook runs on every tool call, and the overhead is the
only part Orvix controls. A test asserts the query bundle imports neither `commander` nor
`web-tree-sitter`, following the whole static module graph rather than just the entry file.

**Growing projects** — `npm run scale`

| files | `orvix index` | `orvix show` |
|---|---|---|
| 100 | 558 ms | 87 ms |
| 500 | 1 297 ms | 94 ms |
| 2 000 | 4 522 ms | 147 ms |

Indexing grows with the project, as it must. A query grows far more slowly — 20× the files costs
under 2× the query — because a lookup reads only the symbol table and never the call sites.

**Correctness** — `npm test`

395 tests. The load-bearing one asserts that after a run of randomised edits, the incrementally
updated index is **byte-identical** to indexing the project from scratch.

### Read these fairly

They are **per-operation, not per-session**. They compare one file read against one lookup. A
session's context is also its system prompt, its history and the model's own output, none of which
Orvix touches. If searches and reads are a third of a session, cutting 70% of those saves around
20% overall — a real number, but not this one.

Counts are **estimated at 3.5 characters per token**, not produced by a tokeniser. The same
estimate is applied to both sides, so the ratios hold even though the absolute figures are rough.

The honest case for Orvix is not the percentage. It is that `who-calls` answers a question `grep`
structurally cannot: which symbols actually reach this one, resolved through imports, with methods
distinguished from functions and no edge drawn when the answer is ambiguous.

## What the call graph does not know

Resolution is **syntactic**. Tree-sitter reports names and imports, not types, so a call is
matched to a definition in this order: same file, then through an import, then a project-wide
unique exported name — never across a language family.

- **Calls dispatched through a string are invisible.** An IPC channel, an event name, a route
  table, a DI container: the caller names a string and the framework finds the target, so there is
  no call to see. `who-calls` on a function behind such a boundary returns only the callers on its
  own side of it.
- **Type references are not call edges**, so an interface reports no callers. Ranking compensates
  by biasing toward exported symbols.
- **A call through a receiver on a typed object cannot be attributed** — `x.Get(…)` needs the type
  of `x`. This makes the graph thinner in Java, C# and C++, where most calls take that form, than
  in C, Go or TypeScript. `map`, `show` and `find` are unaffected.
- Import following is implemented for ECMAScript module paths; the other languages rely on
  same-file scope and project-unique names.

## What gets indexed

`.gitignore` is honoured, including nested ones and `!` negations, and `.orvixignore` takes
precedence. `node_modules`, `.git` and `.orvix` are never walked. Because plenty of real projects
have no `.gitignore`, a default set is applied at the root — virtualenvs, `dist/`, `build/`,
`target/`, `vendor/`, `coverage/`, minified bundles — any of which can be put back with a negation
in `.orvixignore`.

## Contributing

`AGENTS.md` is the guide: how to verify a change, the invariants that must not break silently, and
the six steps for adding a language.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the bundled tree-sitter grammars.

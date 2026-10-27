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
| `orvix map [path]` | The symbol tree, ranked, fitted to `--budget`; `--focus` centres it on a task |
| `orvix show <id\|name>` | The exact source of one symbol |
| `orvix find <query>` | Search symbols by name or signature |
| `orvix who-calls <id\|name>` | Everything that calls this symbol |
| `orvix calls <id\|name>` | Everything this symbol calls |
| `orvix impact <id\|name>` | Everything that reaches it, nearest first, and the test files to run |
| `orvix diff [ref]` | What changed since a git ref, symbol by symbol, and who depends on it |
| `orvix replace <id\|name>` | Swap one symbol's source for new text — experimental, needs `--write` |
| `orvix mcp [path]` | Serve all of the above over the Model Context Protocol |
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

### A map for the task, not the project

```console
$ orvix map --focus parse --budget 400
```

`--focus` takes ids, names or files and restarts the ranking at them, walking call edges both
ways: a parser's private caller now outranks a busy exported surface that has nothing to do with
it. The budget is honoured exactly as before.

### Before and after a change

`orvix impact <id>` walks up the callers and groups them by distance, then lists the test files
among them — including tests whose calls sit in an anonymous `test(() => …)` callback, which
belong to no symbol and are tracked per file. It only follows edges the graph drew, so it is a
floor on the blast radius, never an inflated one.

`orvix diff [ref]` compares the working tree with a git ref symbol by symbol: `+` added, `-`
removed, `~` new signature with the callers still using the old one, `·` body only. On this
repository, a branch that `git diff` prints as 131 kB comes to 12 kB.

## Claude Code

Writing instructions into `CLAUDE.md` and hoping they are honoured only goes so far. `orvix init`
also installs six hooks and registers them, merging with whatever is already in
`.claude/settings.json`.

| Hook | When | What it does |
|---|---|---|
| `orvix-focus` | a prompt is submitted | Attaches a map centred on the code the prompt names. |
| `orvix-compress` | after `Read`, `Grep`, `Bash` | Replaces the result with its symbol map, or a re-read with what changed. |
| `orvix-impact` | after `Edit`, `Write` | Names the callers a changed signature or a removed symbol leaves behind. |
| `orvix-dirty` | after `Edit`, `Write` | Marks the file dirty. Async, so it costs the turn nothing. |
| `orvix-compact` | before compaction | Clears the session's memory of what it has read. |
| `orvix-reconcile` | when the turn ends | Full reindex in the background, as a safety net. |

Nothing here asks the model to cooperate. The scripts are plain `.mjs` with no imports beyond
`node:*`, so they port to any agent that can run a script and speak JSON on stdin.

**The hooks act before the model asks.** A hook can only react to an event, but the right events
are enough. When a prompt names `parseSource` or `src/parser.ts`, the model starts with that
neighbourhood in front of it instead of running `ls` and `grep`. Only words that look like code
count — camelCase, snake_case, `Service.validate`, a path, anything in backticks — so "run the map
again" focuses on nothing. When an edit changes a signature, the callers it breaks arrive with the
edit's result, before the model moves on; a body-only edit keeps every id and prints nothing.

**Re-reads cost a line.** The compression hook remembers which files this session has been sent
in full. Reading one again unchanged returns a note that its text is already in context; after a
small edit, only the changed lines. Asking again after either gets the whole file, and compaction
clears the memory, because after it the model no longer holds what it read.

Everything is on by default, and each part has its switch:

```jsonc
// .orvix/config.json
{
  "compressRead": true,     // a long file read becomes its symbol map
  "compressSearch": true,   // search hits become the symbols containing them
  "rememberReads": true,    // re-reads answered from the session's memory
  "focusPrompt": true,      // a focused map with each prompt that names code
  "focusBudget": 800,       // its size, in tokens
  "editImpact": true        // broken callers reported after an edit
}
```

## Other agents: MCP

`orvix mcp [path]` serves the index over the Model Context Protocol on stdio, for agents without
hooks. Its tools are the query commands unchanged — `map`, `show`, `find`, `who_calls`, `calls`,
`impact` — so an answer over MCP is the answer on the command line.

```jsonc
// e.g. .cursor/mcp.json, or any client's equivalent
{ "mcpServers": { "orvix": { "command": "orvix", "args": ["mcp", "."] } } }
```

## Numbers

Every figure comes from a command in this repository, measured on Orvix's own source — 104 files,
569 symbols, 1 747 call edges, 0 call sites too ambiguous to link — on Windows with Node 24.
Re-run them; they will differ on your machine.

**Reading one symbol instead of one file** — `npm run measure`

| Task | Reading files | With orvix | Saved |
|---|---|---|---|
| Target one function to edit it | ~2,550 | ~235 | **91%** |
| Take in the whole project's shape | ~53,312 | ~2,000 | **96%** |

**What the hooks actually replace** — `npm run benchmark`

Recorded tool results replayed through the real hook scripts: **69.9% saved, nothing lost.**
`preserved` is the number that matters — each fixture names what the task needed from that
output, and the run fails if a compression drops it. Tokens saved alone is meaningless; returning
an empty string would score perfectly. This runs in CI on every commit.

**Query latency** — `npm run bench`

```
node floor      34.3 ms      ← nothing here can go below this
orvix overhead  17.9 ms
query total     52.2 ms
```

Node's own startup is two thirds of it. That ceiling is why the query path carries no CLI
framework and never loads a grammar — a hook runs on every tool call, and the overhead is the
only part Orvix controls. A test asserts the query bundle imports neither `commander` nor
`web-tree-sitter`, following the whole static module graph rather than just the entry file.

**Growing projects** — `npm run scale`

| files | `orvix index` | `orvix show` |
|---|---|---|
| 100 | 596 ms | 57 ms |
| 500 | 988 ms | 61 ms |
| 2 000 | 2 834 ms | 88 ms |

Indexing grows with the project, as it must. A query grows far more slowly — 20× the files costs
under 2× the query — because a lookup reads only the symbol table and never the call sites.

**Correctness** — `npm test`

529 tests. The load-bearing one asserts that after a run of randomised edits, the incrementally
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
matched to a definition in this order: the receiver's declared type, then the same file, then
through an import, then a project-wide unique exported name — never across a language family.

- **A receiver's type is used only where the source declares it.** `r: Repo`, `Repo r`,
  `new Repo()`, `var r = new Repo()`, `this`, `self` and `this.field` are read; return
  types, generics and flow are not, so `make().save()` stays unresolved. Measured on the
  projects 0.2.0 was measured on:

  | Project | Resolved | Refused as ambiguous |
  |---|---|---|
  | gson (Java) | 35.6% (was 24.3%) | 22.0% (was 33.3%) |
  | Newtonsoft.Json (C#) | 32.1% (was 27.5%) | 54.2% (was 58.5%) |
  | fmt (C++) | 27.0% (was 26.5%) | 30.0% (was 30.5%) |

  fmt barely moves because its methods are defined out of line (`void S::f()`), where there is
  no class to name. Go and Rust are not covered yet: their methods carry no container, and giving
  them one would change their ids.
- **Calls dispatched through a string are matched only on literal channel names**, in TypeScript
  and JavaScript: `emit`/`send`/`invoke` on one side, `on`/`handle`/`subscribe` with a named
  handler on the other, within one package. These links are kept apart and shown as
  `⇢ via "channel"`. Inline handlers, computed channel names, route tables and DI containers
  remain invisible, and on real projects inline handlers are the common case.
- **Type references are not call edges**, so an interface reports no callers. Ranking compensates
  by biasing toward exported symbols.
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

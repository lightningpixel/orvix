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

## Results

Every number below comes from a command in this repository. Measured on Orvix's own source —
75 files, 389 symbols, 1 127 call edges, 0 call sites too ambiguous to link — on Windows with
Node 24. Re-run them; they will differ on your machine and your code.

### Reading one symbol instead of one file — `npm run measure`

| Task | Reading files | With orvix | Saved |
|---|---|---|---|
| Target one function (`resolveModule`) to edit it | ~1,912 | ~235 | **88%** |
| Take in the whole project's shape | ~33,254 | ~1,990 | **94%** |

### What the hooks actually replace — `npm run benchmark`

Recorded tool results replayed through the real hook scripts:

```
fixture=read-config-untouched.json  compressed=false  before=44    after=44   preserved=true
fixture=read-large-module.json      compressed=true   before=2437  after=702  preserved=true

delta tokens_saved=1735 ratio=0.699 success_delta=0
```

**69.9% saved, nothing lost.** `preserved` is the number that matters: each fixture names what the
task needed from that output, and the run fails if a compression drops it. Tokens saved on its own
is meaningless — returning an empty string would score perfectly. The config fixture is there to
fail if Orvix ever touches a file it has no business compressing.

This runs in CI on every commit.

### Query latency — `npm run bench`

```
node floor      37.4 ms      ← nothing here can go below this
orvix overhead  17.2 ms
query total     54.6 ms
```

Median of five runs; it moves by a few ms with machine load, and by rather more on a busy one.

**Node's own startup is two thirds of it.** That ceiling is why the query path carries no CLI
framework and never loads a tree-sitter grammar — a hook runs on every tool call, and 17 ms is the
only part Orvix controls. A test asserts the query bundle imports neither `commander` nor
`web-tree-sitter`, following the whole static module graph rather than just the entry file. The
reindexer is reachable, but only through a dynamic import, so a query on an unchanged project
never loads a grammar.

### Growing projects — `npm run scale`

Generated projects with cross-file imports and calls, indexed and queried end to end:

| files | `orvix index` | `orvix show` | hot files | cold file |
|---|---|---|---|---|
| 100 | 274 ms | 53 ms | 241 KB | 265 KB |
| 500 | 790 ms | 62 ms | 1 220 KB | 1 336 KB |
| 2 000 | 2 825 ms | 97 ms | 4 937 KB | 5 380 KB |

Indexing grows with the project, as it must. A query grows far more slowly: 20× the files costs
under 2× the query, because a lookup reads only the symbol table and never the call sites, and the
call graph and PageRank were computed once at index time rather than rebuilt per query. On this
repository the files a query reads are **31%** of the cache.

### Correctness — `npm test`

362 tests. The load-bearing one asserts that after a run of randomised edits, the incrementally
updated index is **byte-identical** to indexing the project from scratch. It has caught four real
bugs that unit tests missed.

---

Four things to read fairly.

**These are per-operation, not per-session.** They compare one file read against one lookup. A
session's context is also its system prompt, its history, the model's own output and its diffs,
none of which Orvix touches. If searches and reads are a third of a session's tokens, cutting 70%
of those saves around 20% overall — a real number, but not this one. `orvix gain` reports measured
deltas for the calls it actually compressed, which has the same narrow denominator.

Counts are **estimated at 3.5 characters per token**, not produced by a tokeniser — the same
estimate is applied to both sides, so the ratio holds even though the absolute numbers are rough.

They are a snapshot of this repository's source and drift as it grows; `npm run measure`
regenerates the table.

And the first row assumes the agent already knows which symbol it wants — if it has to find its
bearings first, it pays for the second row once, then the first row for every symbol after that.

The honest case for Orvix is not the percentage. It is that `who-calls` answers a question `grep`
structurally cannot: which symbols actually reach this one, resolved through imports, with
methods distinguished from functions and no edge drawn when the answer is ambiguous.

## Install

```bash
npm install -g orvix
cd your-project
orvix init
```

`orvix init` asks once which coding agents you use, writes the instructions they read into
`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, adds `.orvix/` to your `.gitignore`, and builds the
index. Your answer is remembered in `~/.orvix/config.json`, so later projects only need
`orvix init` with no questions.

Node 20 or later. Pure JavaScript and WebAssembly — no native build step, nothing to compile.

## Commands

| Command | What it does |
|---|---|
| `orvix init [path]` | Set a project up for agents; `--agent claude codex cursor gemini` skips the prompt |
| `orvix index [path]` | Build or refresh the cache; prints what changed |
| `orvix map [path]` | The symbol tree, ranked, fitted to `--budget <tokens>` (default 2000) |
| `orvix show <id\|name>` | The exact source of one symbol |
| `orvix find <query>` | Search symbols by name or signature |
| `orvix who-calls <id\|name>` | Everything that calls this symbol |
| `orvix calls <id\|name>` | Everything this symbol calls |
| `orvix gain [path]` | Tokens the hooks have saved, per session and in total |

Every command takes `--json` for machine-readable output. `show`, `find`, `who-calls` and `calls`
take `-p <path>` to point at another project.

Queries answer from the prebuilt index and never parse on their own — that is what keeps them
cheap enough to sit behind a hook. Run `orvix index` after changing files. Under Claude Code this
is automatic; see below.

You never have to hold onto an id. `orvix show validate`, `orvix show Service.validate` and
`orvix show a4f2` all work.

### Ids

An id is derived from `file :: qualified name :: kind`, and deliberately not from the symbol's
contents. **Editing a function's body does not change its id** — an id an agent was given three
turns ago still points at the right symbol. Renaming or moving the symbol does change it.

Ids are shown four characters wide and resolved by prefix, like git hashes. If a project grows
enough to need five, ids quoted earlier keep resolving.

## Claude Code hooks

Writing instructions into `CLAUDE.md` and hoping they are honoured only goes so far. For Claude
Code, `orvix init` also installs three hook scripts into `.claude/hooks/` and registers them in
`.claude/settings.json`, merging with whatever is already there rather than overwriting it.

| Hook | When | What it does |
|---|---|---|
| `orvix-dirty.mjs` | after `Edit`, `Write`, `MultiEdit` | Marks the file dirty. Runs async, so it costs the turn nothing. |
| `orvix-compress.mjs` | after `Read`, `Grep`, `Bash` | Replaces the result with its symbol map before the model sees it. |
| `orvix-reconcile.mjs` | when the turn ends | Full reindex in the background, as a safety net. |

Nothing here asks the model to cooperate. It never runs an `orvix` command — the compression hook
reads `.orvix/symbols.json` directly. The scripts are plain `.mjs` with no imports beyond
`node:*`, so they port to any agent that can run a script and speak JSON on stdin.

**What hooks cannot do is create initiative.** A hook only ever reacts to a tool call the model
already decided to make, so `orvix who-calls` before a signature change still depends on the
instruction block below. Compression is mechanical; navigation is a recommendation.

### Turning it off

Both compressions are on by default. To change that without touching the agent's configuration:

```json
// .orvix/config.json
{ "compressRead": false, "compressSearch": true }
```

`compressRead` is the one to reach for first. Replacing a whole-file read with a symbol map is
where the savings are largest and where a task is most likely to lose something it needed — a
second read of the same file in a session always returns the real text, but if the trade does not
suit your work, turn it off here.

## For agents

`orvix init` writes this for you, between `<!-- orvix:start -->` and `<!-- orvix:end -->`
markers so re-running it updates the block in place instead of stacking copies. Anything else in
the file is left untouched. Reproduced here so you know what lands in your repository:

```markdown
## Codebase navigation (orvix)

This project is indexed by orvix. Prefer it over `grep` and over reading whole files.

- `orvix map --budget 2000` — the project's symbols, most important first
- `orvix show <id>` — one symbol's exact source. Do not read the whole file.
- `orvix find <name>` — locate a symbol when you don't have its id
- `orvix who-calls <id>` — every caller. Run this before changing a signature.
- `orvix calls <id>` — what a symbol depends on

Ids are short and stable across edits: reuse an id you were given earlier rather than
re-running `map`. Names work too — `orvix show validate`, `orvix show Service.validate`.

Queries answer from a prebuilt index and never reparse on their own, so run
`orvix index` after you change files. (Under Claude Code this is automatic: a hook marks
edited files and the next query picks them up.)

Do not use orvix for files outside TypeScript, TSX, JavaScript, Python, Go and Rust —
read those directly. Do not use it for anything that is not a symbol: string literals,
configuration keys, comments, TODOs. Use `grep` for those.
```

The last paragraph matters as much as the rest: without it an agent runs `orvix show` on a JSON
file, gets nothing, and concludes the tool is broken instead of just reading the file.

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
cold path   discovery → parse (tree-sitter) → extract → resolve → rank
(indexing)                                                          ↓
                                            .orvix/symbols.json + graph.json
                                                                    ↓
hot path                          map / show / find / who-calls / calls / hooks
(queries)
```

The cache is split by who reads it. `facts.json` holds every call site and is opened only when
reindexing. `symbols.json` and `graph.json` are what a query reads, and between them they are
about 30% of the whole — call sites outnumber symbols roughly ten to one. The call graph and
PageRank are computed once at index time and stored, not rebuilt per query.

That split is the difference between a lookup costing what the answer costs and costing what the
project costs. On a 8 000-file project, parsing the unsplit cache alone took 192 ms and the graph
rebuild walked 341 657 call sites — on every single query.

**Incremental updates.** The edit hook appends the file to `.orvix/dirty` and stops. The next
query reparses only those files, then re-resolves the files that could now resolve differently:
an inverted index maps each referenced name to the files mentioning it, so changing a symbol's
signature invalidates its callers, and *adding* an export fixes references that previously
resolved to nothing. Without that second direction the graph keeps edges to symbols that no
longer exist.

PageRank is deliberately not recomputed incrementally — it costs 2.1 s on a 8 000-file project
and only decides the order `map` prints in. `orvix index` and the background reconciliation
refresh it.

A property test asserts that after a run of randomised edits the incremental result is
**byte-identical** to indexing the project from scratch. It has caught four real bugs.

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

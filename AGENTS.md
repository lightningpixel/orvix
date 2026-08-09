# Working on Orvix

Instructions for coding agents contributing to this repository. (For using Orvix *in* a project,
run `orvix init` there instead — it writes a different, much shorter file.)

## Verify before you claim

```bash
npm run build      # copies grammars into grammars/, then bundles the CLI
npx tsc --noEmit
npm test           # vitest, currently 394 tests
```

All three must pass. Never report work as done without running them.

## Test-driven, without exception

Write the failing test first and **watch it fail for the right reason**. A test that passes the
moment you write it has proved nothing.

Two habits this repository relies on:

- **Run against real code, not fixtures alone.** Every serious defect here was found by pointing
  Orvix at a real project, never by the unit tests: locals polluting the index, ids colliding,
  `JSON.parse` resolving to the project's own `parse`, and an out-of-memory abort on a repository
  containing a Python virtualenv. Fixtures agree with your assumptions; real code does not.
- **Mutate a test to prove it constrains something.** If you must write a test after the code,
  break the code deliberately and confirm the test catches it.

## Layout

```
src/core/      discovery → parser → extract → resolve → rank, plus ids, store, indexer, lookup
src/render/    map (budget-aware), symbol, tokens
src/commands/  one file per command; they return strings, they do not print
src/agents/    which file each agent reads, and the block written into it
queries/       one <language>.scm tag query per language
```

`src/cli.ts` is wiring only — no logic. Commands return `{ output, ok }` so they can be tested
without capturing stdout. One responsibility per file; past ~200 lines, split it.

## Invariants that must not break silently

**Symbol ids are a public contract.** An id is derived from `file :: qualified name :: kind` and
never from file contents, so editing a body does not invalidate an id an agent was given earlier.
`test/ids.test.ts` pins a known hash to a literal value. If that test fails, you have made a
breaking change and it needs a major version, not a new literal.

**The token budget is honoured by construction.** `renderMap` measures candidate renderings and
returns the largest that fits. Never satisfy a budget by truncating the final string.

**Call resolution never guesses.** Same-file scope, then imports, then a project-unique exported
name. A call through a receiver reaches only methods; a bare call reaches only non-methods. The
project-wide tier never crosses a language family — TypeScript, TSX and JavaScript are one family,
every other language stands alone — because a unique name is not evidence when the only match is
in another language. When several candidates remain, draw no edge and record it in `ambiguous`.
A wrong edge is worse than a missing one.

**Indexing tolerates one bad file.** A grammar that will not load or a missing query costs that
file, never the run.

## Adding a language

1. An entry in `src/core/languages.ts` (set `queryId` to share another language's query).
2. Its grammar in `scripts/copy-grammars.mjs` — it must exist in `@vscode/tree-sitter-wasm`.
3. `queries/<id>.scm`, tagging `@definition.<kind>`, `@reference.call`, `@reference.method`.
4. Its local-scope node types and export rule in `src/core/extract.ts`.
5. Tests in `test/languageSupport.test.ts`: symbols with kinds and visibility, one call edge,
   and one local that must *not* be indexed.

Grammars must carry the `dylink.0` wasm section. `tree-sitter-wasms` still ships the legacy
`dylink` section, which web-tree-sitter 0.26 rejects with an empty error message — that is why
grammars come from `@vscode/tree-sitter-wasm`.

## Releasing

1. Move the `## [Unreleased]` entries into a new `## [X.Y.Z] - YYYY-MM-DD` section in
   `CHANGELOG.md`, and update the link definitions at the bottom.
2. `npm version X.Y.Z` — this bumps `package.json` and creates the `vX.Y.Z` tag.
3. `git push --follow-tags`.

Pushing the tag runs `.github/workflows/release.yml`: it refuses to continue if the tag and
`package.json` disagree, runs the full checks, and publishes a GitHub release using that
CHANGELOG section as the notes, with the packed tarball attached. A version with no CHANGELOG
section falls back to notes generated from the commits.

Publishing to npm stays manual: `npm publish --access public`.

## Conventions

British-neutral English in code and comments. Comments explain *why*, never *what*. French is
fine in issues and pull requests.

`dist/`, `grammars/` and `.orvix/` are generated — never commit them.

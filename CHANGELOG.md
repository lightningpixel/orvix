# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releasing a version means tagging it `vX.Y.Z`; the release workflow turns the matching section
below into the release notes.

## [Unreleased]

### Fixed

- Calls no longer resolve across languages. The last resort of resolution — a project-wide unique
  exported name — had no notion of language, so in a mixed repository a TypeScript `xs.filter(…)`
  matched a Python method named `filter` simply because that name was unique. On a real 155-file
  TypeScript-and-Python project this produced 103 false call edges, and `who-calls` on that Python
  method listed 41 TypeScript callers that cannot exist. TypeScript, TSX and JavaScript share one
  family and still resolve into each other.

## [0.1.0] - 2026-08-08

First release.

### Added

- `orvix index` — builds a per-file cache of symbols, call sites and imports in
  `.orvix/index.json`, keyed by mtime and size so an unchanged project costs one `stat()` per
  file rather than a parse.
- `orvix map` — the project's symbols, ranked by importance and fitted to `--budget <tokens>`.
  The budget is honoured by construction: candidate renderings are measured and the largest one
  that fits is returned, so output is never cut off mid-line.
- `orvix show` — one symbol's exact source, by short id or by name.
- `orvix find` — search by name or signature.
- `orvix who-calls` and `orvix calls` — the call graph in both directions.
- `orvix init` — writes the instructions coding agents read into `CLAUDE.md`, `AGENTS.md` or
  `GEMINI.md`, adds `.orvix/` to `.gitignore`, and builds the index. Asks once which agents you
  use and remembers the answer in `~/.orvix/config.json`.
- Language support: TypeScript, TSX, JavaScript, Python, Go and Rust.
- Continuous integration across Linux, macOS and Windows on Node 20, 22 and 24, including a job
  that installs the packed tarball and drives the CLI.

### Notes

- **Symbol ids are stable across edits.** An id derives from `file :: qualified name :: kind`
  and never from file contents, so an id an agent was given earlier still resolves after the
  file is modified. Ids display four characters wide and resolve by prefix, like git hashes.
- **Call resolution is syntactic and refuses to guess.** Same-file scope, then imports, then a
  project-unique exported name. A call through a receiver reaches only methods; a bare call
  reaches only non-methods. Where several definitions remain plausible no edge is drawn, and
  `orvix index` reports how many call sites that affected.
- Measured on this repository with `npm run measure`: ~89% fewer tokens to target a function for
  editing, ~91% to take in the project's shape. Token counts are estimated at 3.5 characters per
  token rather than produced by a tokeniser; the estimate is applied to both sides, so the ratio
  holds even though the absolute figures are approximate.

### Known limits

- Type references are not call edges, so an interface reports no callers. Ranking compensates by
  biasing toward exported symbols.
- Import following is implemented for ECMAScript module paths only; Python, Go and Rust rely on
  same-file scope and project-unique names.
- Functions inside a Rust `impl` block are reported without a container.

[Unreleased]: https://github.com/lightningpixel/orvix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lightningpixel/orvix/releases/tag/v0.1.0

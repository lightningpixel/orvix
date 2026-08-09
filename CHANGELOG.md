# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releasing a version means tagging it `vX.Y.Z`; the release workflow turns the matching section
below into the release notes.

## [Unreleased]

### Added

- Java, C#, C++ and C. `@vscode/tree-sitter-wasm` ships no C grammar; the C++ one parses C
  without error and the tags a C file can produce are a subset, so both share a grammar, a query
  and a resolution family — C++ calls into C without ceremony.
- Visibility is now read per member where the language states it. `private int shut()` inside a
  public Java class is private; inferring it from the enclosing type, as the ECMAScript path
  does, contradicted the source.
- A call written without a receiver may now reach a method, in languages where every function is
  one. `helper()` inside a Java, C# or C++ class means `this.helper()`, so applying the
  ECMAScript rule — a bare call reaches only a non-method — dropped every intra-class call in
  those languages. It still holds for ECMAScript, Python, Go and Rust, where a method needs its
  receiver spelled out.
- Constructors are no longer indexed. One carries the name of the type it builds, so a symbol for
  it made `show S` ambiguous and left every call site naming `S` with two candidates and no edge.
  Nothing is lost: a constructor is not separately addressable, and its source sits inside the
  class's range.
- Each new language was measured against a real project rather than fixtures, and the results
  differ enough to be worth publishing: C resolves 42% of call sites with 2% refused as
  ambiguous (curl), while C# resolves 27% with 59% refused (Newtonsoft.Json), C++ 27% with 30%
  (fmt) and Java 25% with 33% (gson). C has free functions with project-unique names, which is
  what a syntactic resolver can follow; the others send most calls through a receiver on a typed
  object, which it cannot. The README carries the table.
- Packed size grows from 703 kB to 1.4 MB: the C# and C++ grammars are 4.9 and 5.1 MB
  unpacked, against 405 kB for Java.

### Changed

- `orvix init` now says when it is applying the agent choice saved from an earlier project, and
  names the file it came from. Not asking again is the point of a global install, but acting on a
  months-old answer without a word reads as the tool guessing.

### Fixed

- The compression hook could exit non-zero and surface an error in the agent's transcript. Every
  guard inside it answers an unusable input by leaving the original result standing, but an
  exception escaping `main()` did the opposite — reachable with a `.orvix/symbols.json` written by
  another version of orvix. It runs on every tool call; a compression is never worth failing a
  turn over.
- Calls no longer resolve across languages. The last resort of resolution — a project-wide unique
  exported name — had no notion of language, so in a mixed repository a TypeScript `xs.filter(…)`
  matched a Python method named `filter` simply because that name was unique. On a real 155-file
  TypeScript-and-Python project this produced 103 false call edges, and `who-calls` on that Python
  method listed 41 TypeScript callers that cannot exist. TypeScript, TSX and JavaScript share one
  family and still resolve into each other.
- A Python module-level constant was given the whole file as its range, so `orvix show` on one
  printed the entire file instead of the assignment. The tag query anchored the definition on the
  enclosing `(module)` rather than on the assignment. Found by indexing a real project, where 58
  of 1 086 symbols were affected; the compression hook, which maps a line back to the symbol
  containing it, was misresolving search hits in those files for the same reason.
- Each type in a grouped Go `type ( … )` declaration was given the whole block as its range, so
  `orvix show` on one printed all of them.

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

# Third-party notices

Orvix is MIT licensed (see `LICENSE`). It **redistributes** the compiled grammar binaries in
`grammars/`, so the notices below travel with every copy of the package.

## Bundled in the published package

### Tree-sitter grammars (`grammars/*.wasm`)

The WebAssembly grammar binaries are copied at build time from
[`@vscode/tree-sitter-wasm`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm)
(MIT, Microsoft / Visual Studio Code Team), which compiles them from the upstream tree-sitter
grammars. Each grammar is MIT licensed by its own project:

| File | Upstream project |
|---|---|
| `tree-sitter-typescript.wasm` | https://github.com/tree-sitter/tree-sitter-typescript |
| `tree-sitter-tsx.wasm` | https://github.com/tree-sitter/tree-sitter-typescript |
| `tree-sitter-javascript.wasm` | https://github.com/tree-sitter/tree-sitter-javascript |
| `tree-sitter-python.wasm` | https://github.com/tree-sitter/tree-sitter-python |
| `tree-sitter-go.wasm` | https://github.com/tree-sitter/tree-sitter-go |
| `tree-sitter-rust.wasm` | https://github.com/tree-sitter/tree-sitter-rust |

The binaries embed the tree-sitter runtime
([tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter), MIT,
Copyright (c) 2018-2024 Max Brunsfeld), version 0.25.1.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Installed as dependencies

Resolved by npm rather than bundled, and covered by their own packages' licences:

| Package | Licence | Author |
|---|---|---|
| `web-tree-sitter` | MIT | Max Brunsfeld |
| `commander` | MIT | TJ Holowaychuk |
| `ignore` | MIT | kael |

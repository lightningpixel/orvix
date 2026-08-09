// Copies only the grammars Orvix supports out of @vscode/tree-sitter-wasm into
// grammars/, which is what actually ships on npm.
//
// This source is used rather than tree-sitter-wasms because the latter's
// grammars still carry the legacy `dylink` wasm section, which web-tree-sitter
// 0.26 rejects — it requires `dylink.0`.
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm");
const TARGET = join(ROOT, "grammars");

const GRAMMARS = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm",
];

const available = await readdir(SOURCE).catch(() => {
  throw new Error(
    "@vscode/tree-sitter-wasm is not installed. Run `npm install` before `npm run grammars`.",
  );
});

const missing = GRAMMARS.filter((name) => !available.includes(name));
if (missing.length > 0) {
  throw new Error(`@vscode/tree-sitter-wasm is missing: ${missing.join(", ")}`);
}

await mkdir(TARGET, { recursive: true });

let total = 0;
for (const name of GRAMMARS) {
  const from = join(SOURCE, name);
  await copyFile(from, join(TARGET, name));
  total += (await stat(from)).size;
}

console.log(
  `copied ${GRAMMARS.length} grammars (${(total / 1024 / 1024).toFixed(1)} MB) to grammars/`,
);

#!/usr/bin/env node
/**
 * PostToolUse hook for Edit, Write and MultiEdit.
 *
 * Marks the edited file dirty and does nothing else. It does not reindex:
 * parsing here would put tree-sitter on the path of every single edit, and the
 * next query can reparse one file far more cheaply than this hook can reparse
 * it eagerly for a query that may never come.
 *
 * Appends rather than rewrites, so two hooks firing at once cannot lose an
 * entry between a read and a write.
 *
 * Registered with `async: true`, so its cost never reaches the user.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Extensions Orvix can index. Anything else is not worth a dirty entry. */
const INDEXED = new Set([
  ".ts", ".mts", ".cts", ".tsx",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".go", ".rs",
]);

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

function main() {
  const input = readStdin();
  if (!input) return;

  const root = input.cwd;
  const tool = input.tool_input ?? {};

  // MultiEdit carries one path; Edit and Write likewise. `edits` is per-file,
  // so a single path still covers every change in the call.
  const target = tool.file_path ?? tool.path ?? tool.notebook_path;
  if (typeof target !== "string" || typeof root !== "string") return;

  const dot = target.lastIndexOf(".");
  if (dot === -1 || !INDEXED.has(target.slice(dot).toLowerCase())) return;

  const rel = relative(root, target);
  // Outside the project: nothing in the index can refer to it.
  if (rel.startsWith("..") || rel.length === 0) return;

  const posix = rel.split(sep).join("/");
  const log = join(root, ".orvix", "dirty");

  try {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `${posix}\n`, "utf8");
  } catch {
    // A cache that cannot be written is not worth failing a tool call over.
    // The Stop hook reconciles from scratch regardless.
  }
}

main();

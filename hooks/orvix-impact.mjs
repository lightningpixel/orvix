#!/usr/bin/env node
/**
 * PostToolUse hook for Edit, Write and MultiEdit.
 *
 * Tells the model, the moment it changes a signature or removes a symbol,
 * which callers that leaves pointing at the old shape. Until this, running
 * `orvix who-calls` before a change was a recommendation in an instruction
 * file; a model that skipped it found out from the type checker, or did not.
 *
 * The work happens in `orvix-query edited`, which reindexes the one file and
 * compares its symbols by id. A body-only edit keeps every id and signature,
 * so the common case prints nothing and adds nothing to the context.
 *
 * Synchronous on purpose: delivered asynchronously, the warning would arrive
 * after the model had already moved on to the next file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The same list as orvix-dirty.mjs; a test ties both to the registry. */
const INDEXED = new Set([
  ".ts", ".mts", ".cts", ".tsx",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".go", ".rs",
  ".java", ".cs",
  ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
  ".c", ".h",
]);

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }

  const root = input?.cwd;
  const tool = input?.tool_input ?? {};
  const target = tool.file_path ?? tool.path;
  if (typeof root !== "string" || typeof target !== "string") return;

  const dot = target.lastIndexOf(".");
  if (dot === -1 || !INDEXED.has(target.slice(dot).toLowerCase())) return;

  const rel = relative(root, target);
  if (rel.length === 0 || rel.startsWith("..")) return;

  if (!enabled(root)) return;
  const query = resolveQuery(root);
  if (!query) return;

  let report;
  try {
    report = execFileSync(
      process.execPath,
      [query, "edited", rel.split(sep).join("/"), "-p", root],
      { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return;
  }
  if (report.length === 0) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: report },
    })}\n`,
  );
}

/** On by default; `"editImpact": false` in .orvix/config.json turns it off. */
function enabled(root) {
  try {
    return JSON.parse(readFileSync(join(root, ".orvix", "config.json"), "utf8")).editImpact !== false;
  } catch {
    return true;
  }
}

/** The query bundle `orvix init` recorded; see orvix-reconcile.mjs. */
function resolveQuery(root) {
  try {
    const recorded = JSON.parse(readFileSync(join(root, ".orvix", "runtime.json"), "utf8"));
    if (typeof recorded.query === "string" && existsSync(recorded.query)) return recorded.query;
  } catch {
    // Fall through.
  }
  const local = join(root, "node_modules", "orvix-cli", "dist", "query.js");
  return existsSync(local) ? local : undefined;
}

try {
  main();
} catch {
  // An edit has already happened; a failed warning must not turn it into an error.
}

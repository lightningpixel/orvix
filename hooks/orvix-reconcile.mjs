#!/usr/bin/env node
/**
 * Stop hook — the safety net.
 *
 * Everything else in the system is incremental, and incremental things drift:
 * a missed hook, a file changed outside the agent, a crash between marking a
 * file dirty and reindexing it. A full pass when the turn ends costs nothing
 * anybody is waiting for and puts the index back on solid ground.
 *
 * Registered with `async: true`, so the turn does not wait for it.
 *
 * Emits nothing on stdout. A Stop hook that printed JSON could hold the
 * conversation open, and a background tidy-up has no business doing that.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds the orvix that installed these hooks.
 *
 * `orvix init` records the path it was run from, because a hook script has no
 * reliable way back to the package: it lives in the project, not in
 * node_modules, and the agent's PATH is not the shell's.
 */
function resolveOrvix(root) {
  try {
    const recorded = JSON.parse(readFileSync(join(root, ".orvix", "runtime.json"), "utf8"));
    if (typeof recorded.main === "string" && existsSync(recorded.main)) {
      return recorded.main;
    }
  } catch {
    // Fall through to the conventional locations.
  }

  const local = join(root, "node_modules", "orvix", "dist", "main.js");
  return existsSync(local) ? local : undefined;
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const root = input.cwd;
  if (typeof root !== "string") process.exit(0);

  const main = resolveOrvix(root);

  // Without a resolvable orvix there is nothing useful to do, and guessing at
  // a global binary risks running something else entirely.
  if (!main) process.exit(0);

  const child = spawn(process.execPath, [main, "index", root], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
} catch {
  // A reconciliation that cannot start is not worth reporting: the next one
  // will, and queries stay correct from the dirty log in the meantime.
}

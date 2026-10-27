#!/usr/bin/env node
/**
 * PreCompact hook.
 *
 * The compression hook answers a re-read of an unchanged file with "you
 * already have this". That is only true while the earlier read is still in
 * the context, and compaction is exactly the moment it stops being true. So
 * the session's memory is dropped here, and the next read of any file is sent
 * in full again.
 *
 * Emits nothing: compaction is not this hook's to influence.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const root = input?.cwd;
  if (typeof root === "string") {
    rmSync(join(root, ".orvix", "session.log"), { force: true });
    rmSync(join(root, ".orvix", "session"), { recursive: true, force: true });
  }
} catch {
  // Worst case, a re-read after compaction gets a note instead of the text,
  // and the read after that gets the text.
}

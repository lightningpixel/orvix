import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * Locates the installed package root by walking up from this module.
 *
 * The depth differs between running from source (src/core/) and running the
 * bundle (dist/), so the root is found rather than computed.
 */
export function packageRoot(): string {
  if (cached) return cached;

  let dir = dirname(fileURLToPath(import.meta.url));

  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate the orvix package root");
    }
    dir = parent;
  }

  cached = dir;
  return dir;
}

export function grammarsDir(): string {
  return join(packageRoot(), "grammars");
}

export function hooksDir(): string {
  return join(packageRoot(), "hooks");
}

export function queriesDir(): string {
  return join(packageRoot(), "queries");
}

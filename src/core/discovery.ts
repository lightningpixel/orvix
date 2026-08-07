import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface DiscoverOptions {
  /** File extensions to collect, e.g. [".ts", ".tsx"]. Matched case-insensitively. */
  extensions: string[];
  /** Files above this size are skipped; they are almost always generated. */
  maxFileSize?: number;
}

/** Never worth indexing, and never worth descending into. */
const ALWAYS_SKIP = new Set(["node_modules", ".git", ".orvix"]);

/**
 * Applied at the project root before any user rules.
 *
 * Plenty of real projects have no .gitignore, and walking a virtualenv or a
 * bundler's output is both useless and ruinously expensive — a directory of
 * minified bundles will exhaust memory before it produces a single useful
 * symbol. These are ordinary patterns rather than hard skips, so a
 * .orvixignore can put any of them back with `!`.
 */
const DEFAULT_IGNORES = [
  // Installed dependencies. site-packages is the marker that matters: a
  // virtualenv is named anything at all — venv, .venv, env, build-env — but
  // it always ends in a site-packages directory.
  "site-packages/",
  "bower_components/",
  // Python
  "venv/",
  ".venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  // Build output
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "coverage/",
  // Framework caches
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  // Generated bundles
  "*.min.js",
  "*.bundle.js",
];

const IGNORE_FILES = [".gitignore", ".orvixignore"];

const DEFAULT_MAX_FILE_SIZE = 1_000_000;

/** An ignore matcher plus the directory its patterns are relative to. */
interface Scope {
  dir: string;
  matcher: Ignore;
}

/**
 * Walks a project and returns the source files worth indexing, as posix-style
 * paths relative to `root`, sorted.
 *
 * Ignore rules follow git semantics: patterns in a nested .gitignore apply
 * relative to that file's own directory, and an ignored directory is not
 * descended into. .orvixignore is read alongside .gitignore with the same rules.
 */
export async function discover(
  root: string,
  options: DiscoverOptions,
): Promise<string[]> {
  const extensions = new Set(
    options.extensions.map((ext) => ext.toLowerCase()),
  );
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  const found: string[] = [];
  await walk(root, root, [], { extensions, maxFileSize }, found);
  return found.sort();
}

interface WalkConfig {
  extensions: Set<string>;
  maxFileSize: number;
}

async function walk(
  root: string,
  dir: string,
  inherited: Scope[],
  config: WalkConfig,
  found: string[],
): Promise<void> {
  const scopes = [...inherited, ...(await readScopes(dir, dir === root))];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (ALWAYS_SKIP.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isIgnored(scopes, full, true)) continue;
      await walk(root, full, scopes, config, found);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!config.extensions.has(extname(entry.name).toLowerCase())) continue;
    if (isIgnored(scopes, full, false)) continue;

    const { size } = await stat(full);
    if (size > config.maxFileSize) continue;

    found.push(toPosix(relative(root, full)));
  }
}

/**
 * Builds the ignore rules that apply from `dir` downwards.
 *
 * A directory's rules go into a single matcher, in order: defaults (root
 * only), then .gitignore, then .orvixignore. Sharing one matcher is what lets
 * a later `!pattern` override an earlier rule — separate matchers could only
 * ever add exclusions.
 */
async function readScopes(dir: string, isRoot: boolean): Promise<Scope[]> {
  const patterns: string[] = isRoot ? [...DEFAULT_IGNORES] : [];

  for (const name of IGNORE_FILES) {
    const contents = await readIfPresent(join(dir, name));
    if (contents !== undefined) patterns.push(contents);
  }

  if (patterns.length === 0) return [];
  return [{ dir, matcher: ignore().add(patterns.join("\n")) }];
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * `ignore` matches directory patterns like `build/` only when the tested path
 * carries a trailing slash, so directories are marked as such.
 */
function isIgnored(
  scopes: Scope[],
  fullPath: string,
  isDirectory: boolean,
): boolean {
  for (const scope of scopes) {
    const rel = toPosix(relative(scope.dir, fullPath));
    if (rel === "" || rel.startsWith("../")) continue;
    if (scope.matcher.ignores(isDirectory ? `${rel}/` : rel)) return true;
  }
  return false;
}

function toPosix(path: string): string {
  return path.split(/[\\/]/).join("/");
}

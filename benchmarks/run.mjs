#!/usr/bin/env node
/**
 * Benchmark harness — see benchmarks/README.md.
 *
 * Reports tokens saved *and* task success, always together. Tokens alone are
 * trivially gamed: a hook that returned an empty string would score a perfect
 * saving and destroy every task.
 *
 * Usage:
 *   node benchmarks/run.mjs --mode synthetic
 *   node benchmarks/run.mjs --mode live --arm both
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHARS_PER_TOKEN = 3.5;

/** @param {string} text */
const estimate = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** @param {string[]} argv */
function parse(argv) {
  const options = { mode: "synthetic", arm: "both", out: join(HERE, "results") };
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (token === "--mode") options.mode = argv[++at] ?? "synthetic";
    else if (token === "--arm") options.arm = argv[++at] ?? "both";
    else if (token === "--out") options.out = argv[++at] ?? options.out;
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* Synthetic arm                                                       */
/* ------------------------------------------------------------------ */

/**
 * Replays a fixture through the real compression hook.
 *
 * The hook is run as a child process reading stdin, exactly as the agent runs
 * it, so the thing measured is the thing shipped rather than a reimplementation
 * of it.
 *
 * @param {{cwd: string, tool_name: string, tool_input: unknown, tool_response: unknown}} payload
 * @returns {string | undefined} replacement output, or undefined for pass-through
 */
function compress(payload) {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "hooks", "orvix-compress.mjs")],
    { input: JSON.stringify(payload), encoding: "utf8" },
  );

  if (!result.stdout || result.stdout.trim().length === 0) return undefined;

  try {
    const replaced = JSON.parse(result.stdout).hookSpecificOutput?.updatedToolOutput;
    return unwrapResponse(replaced);
  } catch {
    return undefined;
  }
}

/**
 * The shape each tool's result actually has, taken from a recorded session.
 *
 * This used to send a bare string. Claude Code validates `updatedToolOutput`
 * against the tool's own schema and discards a mismatch, so a benchmark that
 * replays strings measures a path that does not exist — it reported savings on
 * compressions that would have been thrown away in a real session.
 */
function wrapResponse(toolName, text) {
  const lines = text.split("\n").length;

  if (toolName === "Read") return { file: { content: text } };
  if (toolName === "Grep") {
    return {
      mode: "content",
      numFiles: 0,
      filenames: [],
      content: text,
      numLines: lines,
      totalLines: lines,
    };
  }
  if (toolName === "Bash") {
    return {
      stdout: text,
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    };
  }
  return text;
}

/** Pulls the text back out of whatever shape the hook returned. */
function unwrapResponse(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value.content === "string") return value.content;
  if (typeof value.stdout === "string") return value.stdout;
  if (value.file && typeof value.file.content === "string") {
    return value.file.content;
  }
  throw new Error(
    `hook returned a shape this harness cannot read: ${Object.keys(value).join(",")}`,
  );
}

function runSynthetic(options) {
  const dir = join(HERE, "replay");
  if (!existsSync(dir)) {
    console.error(`no fixtures in ${dir}`);
    process.exit(1);
  }

  const fixtures = readdirSync(dir).filter((name) => name.endsWith(".json"));
  if (fixtures.length === 0) {
    console.error(`no fixtures in ${dir}`);
    process.exit(1);
  }

  // Start from nothing. The compressor remembers which files a session has
  // already read, and that memory lives in the work directory — so a second
  // run over a surviving one measures the pass-through path and reports a
  // saving of zero.
  rmSync(join(HERE, ".work"), { recursive: true, force: true });

  let before = 0;
  let after = 0;
  let succeeded = 0;
  const rows = [];

  for (const name of fixtures) {
    const fixture = JSON.parse(readFileSync(join(dir, name), "utf8"));

    // Fixtures describe a project inline so they stay self-contained and the
    // benchmark never depends on whatever happens to be checked out.
    const cwd = join(HERE, ".work", name.replace(/\.json$/, ""));
    mkdirSync(cwd, { recursive: true });
    for (const [path, contents] of Object.entries(fixture.files ?? {})) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), contents, "utf8");
    }
    execFileSync(process.execPath, [join(ROOT, "dist", "main.js"), "index", cwd], {
      stdio: "ignore",
    });

    const original = fixture.tool_response_text ?? "";
    const replacement = compress({
      cwd,
      session_id: `bench-${name}`,
      tool_name: fixture.tool_name,
      tool_input: resolvePaths(fixture.tool_input ?? {}, cwd),
      tool_response: wrapResponse(fixture.tool_name, original),
    });

    const shown = replacement ?? original;

    // Success is not "did it compress" but "did what the task needed survive".
    const needed = fixture.expect ?? [];
    const kept = needed.every((token) => shown.includes(token));
    if (kept) succeeded += 1;

    before += estimate(original);
    after += estimate(shown);

    rows.push(
      `fixture=${name} compressed=${replacement !== undefined} ` +
        `before=${estimate(original)} after=${estimate(shown)} preserved=${kept}` +
        (kept ? "" : ` missing=${needed.filter((t) => !shown.includes(t)).join(",")}`),
    );
  }

  for (const row of rows) console.log(row);

  const ratio = before > 0 ? (before - after) / before : 0;
  console.log(
    `\narm=with tasks=${fixtures.length} succeeded=${succeeded} tokens=${after}`,
  );
  console.log(`arm=without tasks=${fixtures.length} succeeded=${fixtures.length} tokens=${before}`);
  console.log(
    `delta tokens_saved=${before - after} ratio=${ratio.toFixed(3)} ` +
      `success_delta=${succeeded - fixtures.length}`,
  );

  write(options.out, "synthetic", {
    mode: "synthetic",
    at: new Date().toISOString(),
    fixtures: fixtures.length,
    succeeded,
    before,
    after,
    ratio,
  });

  // A saving that costs accuracy is a failure, however good the token number.
  if (succeeded < fixtures.length) process.exitCode = 1;
}

/** Fixture paths are relative; the hook needs them absolute. */
function resolvePaths(input, cwd) {
  const copy = { ...input };
  if (typeof copy.file_path === "string") copy.file_path = join(cwd, copy.file_path);
  return copy;
}

/* ------------------------------------------------------------------ */
/* Live arm                                                            */
/* ------------------------------------------------------------------ */

/**
 * Drives real headless agent sessions.
 *
 * Deliberately not wired into CI: it costs API tokens and depends on network
 * and on a `claude` binary being present. It prints what it would do and stops
 * unless everything it needs is actually there, so a missing prerequisite is
 * never mistaken for a result.
 */
function runLive(options) {
  const manifest = join(HERE, "repos.json");
  const tasksDir = join(HERE, "tasks");

  if (!existsSync(manifest) || !existsSync(tasksDir)) {
    console.error("live mode needs benchmarks/repos.json and benchmarks/tasks/");
    process.exit(1);
  }

  const repos = JSON.parse(readFileSync(manifest, "utf8")).repos ?? [];
  const tasks = readdirSync(tasksDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(tasksDir, name), "utf8")));

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (claude.status !== 0) {
    console.error(
      "live mode needs the `claude` CLI on PATH.\n" +
        `would run ${tasks.length} tasks across ${repos.length} repos, ` +
        `arm=${options.arm}`,
    );
    process.exit(1);
  }

  console.error(
    "live mode is wired but intentionally not automated further: it spends " +
      "real tokens. Run each task deliberately and commit the result.",
  );
  process.exit(1);
}

function write(dir, name, payload) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const options = parse(process.argv.slice(2));
if (options.mode === "live") runLive(options);
else runSynthetic(options);

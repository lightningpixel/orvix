#!/usr/bin/env node
/**
 * Replays a recorded Claude Code session through the compression hook and
 * reports what it would have saved over the whole session.
 *
 * `npm run benchmark` measures one tool result against its replacement. A
 * session pays for a tool result again on every API call that follows it,
 * because the whole context is re-sent each time, until compaction drops it.
 * So a result saved early is worth far more than one saved late, and the only
 * honest session-level figure weighs each saving by the calls that carried it.
 * That figure is set against the input the transcript says was really sent.
 *
 * Usage:
 *   node scripts/session-replay.mjs <transcript.jsonl> [--root <project>]
 *
 * Transcripts live in ~/.claude/projects/<project>/<session>.jsonl. Replay a
 * session recorded without Orvix's hooks, against an index of the code as it
 * was then: the hook maps results onto today's symbols.
 *
 * Savings are estimated at 3.5 characters per token, like every other Orvix
 * figure; the session input is the real usage the API reported.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "orvix-compress.mjs");
const CHARS_PER_TOKEN = 3.5;
const COMPRESSIBLE = new Set(["Read", "Grep", "Bash"]);

/** @param {string} text */
const estimate = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * @typedef {object} SessionReport
 * @property {number} apiCalls
 * @property {number} sessionInput Input tokens the API reported, summed over calls.
 * @property {number} toolResults Results from tools the hook handles.
 * @property {number} compressed
 * @property {number} savedOnce Tokens saved, each result counted once.
 * @property {number} savedCumulative Tokens saved, each result counted per call that carried it.
 */

/**
 * @param {string} jsonl The transcript's contents.
 * @param {{ root: string }} options
 * @returns {SessionReport}
 */
export function replaySession(jsonl, { root }) {
  const entries = jsonl
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry && typeof entry === "object");

  const sandbox = sandboxFor(root);
  try {
    return measure(entries, root, sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * @param {any[]} entries
 * @param {string} root
 * @param {string} sandbox
 * @returns {SessionReport}
 */
function measure(entries, root, sandbox) {
  /** @type {Map<string, { name: string, input: unknown }>} */
  const uses = new Map();
  const seenCalls = new Set();
  /** Savings still in the context, waiting to be charged to later calls. */
  let live = 0;

  const report = {
    apiCalls: 0,
    sessionInput: 0,
    toolResults: 0,
    compressed: 0,
    savedOnce: 0,
    savedCumulative: 0,
  };

  for (const entry of entries) {
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      live = 0;
      continue;
    }

    const content = entry.message?.content;

    if (entry.type === "assistant") {
      const id = entry.message?.id;
      const usage = entry.message?.usage;
      if (usage && id !== undefined && !seenCalls.has(id)) {
        seenCalls.add(id);
        report.apiCalls += 1;
        report.sessionInput +=
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        report.savedCumulative += live;
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === "tool_use") uses.set(block.id, { name: block.name, input: block.input });
      }
      continue;
    }

    if (entry.type !== "user" || !Array.isArray(content)) continue;

    const results = content.filter((block) => block?.type === "tool_result");
    for (const result of results) {
      const use = uses.get(result.tool_use_id);
      if (!use || !COMPRESSIBLE.has(use.name)) continue;

      const seen = textOf(result.content);
      if (seen.length === 0) continue;
      report.toolResults += 1;

      // The structured result is what a hook receives; it is recorded once
      // per entry, so it is only trusted when the entry holds one result.
      const response = results.length === 1 && entry.toolUseResult ? entry.toolUseResult : seen;
      const replacement = runHook(
        {
          cwd: root,
          session_id: "orvix-replay",
          hook_event_name: "PostToolUse",
          tool_name: use.name,
          tool_input: use.input,
          tool_response: response,
        },
        root,
        sandbox,
      );
      if (replacement === undefined) continue;

      const saved = estimate(seen) - estimate(replacement);
      if (saved <= 0) continue;
      report.compressed += 1;
      report.savedOnce += saved;
      live += saved;
    }
  }

  return report;
}

/**
 * A scratch copy of the project's index for the hook to run against.
 *
 * The hook writes session memory and gain records under its cwd, and a live
 * session in the same project keeps its own memory there. Replaying in place
 * would make that session forget what it had read.
 *
 * @param {string} root
 */
function sandboxFor(root) {
  const sandbox = mkdtempSync(join(tmpdir(), "orvix-replay-"));
  mkdirSync(join(sandbox, ".orvix"), { recursive: true });
  for (const file of ["symbols.json", "config.json"]) {
    const source = join(root, ".orvix", file);
    if (existsSync(source)) copyFileSync(source, join(sandbox, ".orvix", file));
  }
  return sandbox;
}

/**
 * Runs the hook with every mention of the project's root pointed at the
 * sandbox, so paths still resolve against the index.
 *
 * @param {unknown} payload
 * @param {string} root
 * @param {string} sandbox
 * @returns {string | undefined}
 */
function runHook(payload, root, sandbox) {
  let json = JSON.stringify(payload);
  for (const [from, to] of rootForms(root, sandbox)) json = json.split(from).join(to);

  const run = spawnSync(process.execPath, [HOOK], { input: json, encoding: "utf8" });
  if (!run.stdout || run.stdout.trim() === "") return undefined;

  try {
    const output = JSON.parse(run.stdout).hookSpecificOutput?.updatedToolOutput;
    const text = typeof output === "string" ? output : textOf(output?.file?.content ?? output?.content ?? output?.stdout ?? output?.text);
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The spellings a path can take inside JSON: native, forward-slashed, and
 * with its backslashes escaped.
 *
 * @param {string} root
 * @param {string} sandbox
 * @returns {Array<[string, string]>}
 */
function rootForms(root, sandbox) {
  /** @type {Array<[string, string]>} */
  const forms = [
    [JSON.stringify(root).slice(1, -1), JSON.stringify(sandbox).slice(1, -1)],
    [root.replace(/\\/g, "/"), sandbox.replace(/\\/g, "/")],
  ];
  return forms.filter(([from]) => from.length > 0);
}

/** @param {unknown} value */
function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((token, at) => !token.startsWith("-") && argv[at - 1] !== "--root");
  const rootAt = argv.indexOf("--root");
  const root = resolve(rootAt === -1 ? "." : (argv[rootAt + 1] ?? "."));

  if (!file) {
    console.error("usage: node scripts/session-replay.mjs <transcript.jsonl> [--root <project>]");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(join(root, ".orvix", "symbols.json"))) {
    console.error(`${root} has no index. Run \`orvix index\` there first.`);
    process.exitCode = 1;
    return;
  }

  const report = replaySession(readFileSync(file, "utf8"), { root });
  const share = report.sessionInput > 0 ? report.savedCumulative / report.sessionInput : 0;

  console.log(
    [
      `api_calls=${report.apiCalls} session_input=${report.sessionInput}`,
      `tool_results=${report.toolResults} compressed=${report.compressed}`,
      `saved_once=${report.savedOnce} saved_cumulative=${report.savedCumulative}`,
      `share_of_session_input=${share.toFixed(3)}`,
    ].join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

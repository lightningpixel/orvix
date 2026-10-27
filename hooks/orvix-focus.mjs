#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 *
 * Hands the model a map centred on whatever the prompt names, before its first
 * tool call. Every other hook reacts to a call the model already chose to make;
 * this one is the only point at which Orvix can act first, and the first thing
 * a model does with a task is go looking for the code it is about.
 *
 * Only words that look like code count: camelCase, snake_case, a dotted
 * `Service.validate`, a path, or anything in backticks. Prose does not. "run
 * the map again" names two symbols in this very repository, and focusing on
 * them would be noise presented as help.
 *
 * Emits nothing when the prompt names nothing the index knows. Context that
 * arrives with every prompt has to earn its place each time.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Small enough to sit beside a prompt, large enough to show a neighbourhood. */
const DEFAULT_BUDGET = 800;

/** A name shared by more symbols than this says nothing about the task. */
const MAX_MATCHES = 5;

const MAX_TARGETS = 8;

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }

  const root = input?.cwd;
  const prompt = input?.prompt;
  if (typeof root !== "string" || typeof prompt !== "string") return;

  const config = loadConfig(root);
  if (!config.focusPrompt) return;

  const table = loadSymbols(root);
  const query = resolveQuery(root);
  if (!table || !query) return;

  const targets = matchTargets(root, table, candidates(prompt));
  if (targets.length === 0) return;

  let map;
  try {
    map = execFileSync(
      process.execPath,
      [query, "map", "-p", root, "-b", String(config.focusBudget), "--focus", targets.join(",")],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trimEnd();
  } catch {
    return;
  }
  if (map.length === 0) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `orvix map centred on ${targets.join(", ")} — the code this prompt names and its callers and callees. ` +
          "`orvix show <id>` for exact source.\n" +
          map,
      },
    })}\n`,
  );
}

/** Words from the prompt that could name a symbol or a file. */
function candidates(prompt) {
  const found = [];

  // Backticks are an explicit "this is code", so even a plain word counts.
  for (const [, span] of prompt.matchAll(/`([^`\n]+)`/g)) {
    for (const token of span.split(/[^\w$./\\-]+/)) found.push(token);
  }

  const prose = prompt.replace(/`[^`\n]+`/g, " ");
  for (const [token] of prose.matchAll(/[\w$./\\-]+/g)) {
    if (looksLikeCode(token)) found.push(token);
  }

  // Sentence punctuation clings to the last word: "edit src/a.ts." is a path.
  return found
    .map((token) => token.replace(/[.,:;!?-]+$/, ""))
    .filter((token) => token.length >= 2);
}

function looksLikeCode(token) {
  const bare = token.replace(/[.,:;!?-]+$/, "");
  return (
    /[a-z][A-Z]/.test(bare) ||
    /\w_\w/.test(bare) ||
    /[A-Za-z_$]\.[A-Za-z_$]/.test(bare) ||
    /[/\\]/.test(bare)
  );
}

function matchTargets(root, table, tokens) {
  const targets = [];

  for (const raw of tokens) {
    if (targets.length >= MAX_TARGETS) break;
    const token = asProjectPath(root, raw);
    if (targets.includes(token)) continue;

    if (table.byFile?.[token]?.length > 0) {
      targets.push(token);
      continue;
    }

    const ids = table.byName?.[token.toLowerCase()];
    if (Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_MATCHES) {
      targets.push(token);
    }
  }

  return targets;
}

/** An absolute or ./-prefixed path, rewritten the way the index keys files. */
function asProjectPath(root, token) {
  let path = token.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^([A-Za-z]:)?\//.test(path)) {
    const rel = relative(root, token);
    if (!rel.startsWith("..")) path = rel.split(sep).join("/");
  }
  return path;
}

function loadConfig(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".orvix", "config.json"), "utf8"));
    const budget = Number(raw.focusBudget);
    return {
      focusPrompt: raw.focusPrompt !== false,
      focusBudget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET,
    };
  } catch {
    return { focusPrompt: true, focusBudget: DEFAULT_BUDGET };
  }
}

function loadSymbols(root) {
  try {
    const table = JSON.parse(readFileSync(join(root, ".orvix", "symbols.json"), "utf8"));
    return table && typeof table === "object" && table.symbols ? table : undefined;
  } catch {
    return undefined;
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
  // A prompt must never be held up by a map nobody asked for.
}

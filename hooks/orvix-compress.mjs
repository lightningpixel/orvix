#!/usr/bin/env node
/**
 * PostToolUse hook for Read, Grep and Bash.
 *
 * Replaces a tool result with an equivalent that costs fewer tokens, before
 * the model ever sees it. Interception happens here rather than at PreToolUse
 * because a denial costs a whole extra turn — the entire context re-sent to
 * save a couple of thousand tokens on one search, which is a net loss on the
 * measure Orvix exists to improve.
 *
 * Rewriting the input was not an option either. A proxy can turn `git status`
 * into `rtk git status` because the Bash tool's input *is* a command string.
 * Read and Grep are native tools with structured input: there is no command to
 * rewrite, so the only equivalent lever is the output.
 *
 * The governing rule is that a compression which is not provably equivalent
 * does not happen. Anything unrecognised — an unknown response shape, a file
 * that is not indexed, a rendering that is not clearly smaller — exits 0 with
 * no output, and the original result stands.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Matches src/render/tokens.ts. Both sides of a saving use the same measure. */
const CHARS_PER_TOKEN = 3.5;

/** Below this a file is cheap enough that compressing it risks more than it saves. */
const MIN_LINES = 200;

/** A rendering must be at least this much smaller, or it is not worth the swap. */
const MAX_RATIO = 0.5;

/** Commands whose output may be search hits. Loose on purpose — see `compressHits`. */
const SEARCH_COMMAND = /\b(?:grep|egrep|fgrep|rg|ag|ack)\b/;

const estimate = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }

  const root = input?.cwd;
  if (typeof root !== "string") return;

  const config = loadConfig(root);
  const table = loadSymbols(root);
  if (!table) return;

  const original = extractText(input.tool_response);
  if (original === undefined || original.length === 0) return;

  const replacement = choose(input, root, table, original, config);
  if (!replacement) return;

  // Refuse a swap that does not clearly pay. A rendering that is nearly the
  // size of what it replaces has taken on the risk of losing something for
  // almost none of the benefit.
  if (replacement.length > original.length * MAX_RATIO) return;

  record(root, input, original, replacement);

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: replacement,
        ...(firstTime(root, input)
          ? {
              additionalContext:
                "This result came from the orvix index. You can query it directly: " +
                "`orvix show <id>` for a symbol's exact source, `orvix who-calls <id>` " +
                "before changing a signature, `orvix find <name>` to locate one.",
            }
          : {}),
      },
    })}\n`,
  );
}

/** Routes a tool result to whichever compression suits it, if any. */
function choose(input, root, table, original, config) {
  if (input.tool_name === "Read") {
    return config.compressRead ? compressRead(input, root, table, original) : undefined;
  }

  if (!config.compressSearch) return undefined;
  if (input.tool_name === "Grep") return compressHits(root, table, original);

  // A search run through the shell rather than the native tool. Same output
  // shape, same treatment — this is the route half of real searches take, and
  // ignoring it left the largest hole in the coverage.
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command !== "string" || !SEARCH_COMMAND.test(command)) return undefined;
    return compressHits(root, table, original);
  }

  return undefined;
}

/**
 * Reads the project's Orvix settings.
 *
 * Both compressions are on by default, and both can be turned off without
 * touching the agent's hook configuration:
 *
 *   .orvix/config.json  ->  { "compressRead": false }
 *
 * A default-on feature that can cost accuracy needs an off switch that does
 * not require understanding settings.json.
 */
function loadConfig(root) {
  const defaults = { compressRead: true, compressSearch: true };

  try {
    const raw = JSON.parse(readFileSync(join(root, ".orvix", "config.json"), "utf8"));
    return {
      compressRead: raw.compressRead !== false,
      compressSearch: raw.compressSearch !== false,
    };
  } catch {
    return defaults;
  }
}

/**
 * Pulls the text out of a tool result.
 *
 * The shape is not stable across tools or versions, so every form seen is
 * handled and anything else returns undefined — which means "leave it alone",
 * not "compress an empty string".
 */
function extractText(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return undefined;

  if (Array.isArray(response)) {
    const parts = response
      .map((block) => (typeof block?.text === "string" ? block.text : undefined))
      .filter((part) => part !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (typeof response.content === "string") return response.content;
  if (typeof response.text === "string") return response.text;
  if (typeof response.stdout === "string") return response.stdout;
  if (response.file && typeof response.file.content === "string") {
    return response.file.content;
  }

  return undefined;
}

/**
 * Replaces a whole-file read with the file's symbol map.
 *
 * Every guard here exists because the failure mode is silent: the model asked
 * for a file, got something smaller, and has no way to know what was left out.
 * So it must have an escape hatch, and a second read of the same file returns
 * the real thing — asking twice is the clearest signal that the map was not
 * what was wanted.
 */
function compressRead(input, root, table, original) {
  const tool = input.tool_input ?? {};

  // A ranged read is deliberate. Never second-guess it.
  if (tool.offset !== undefined || tool.limit !== undefined) return undefined;
  if (typeof tool.file_path !== "string") return undefined;

  const path = toRelative(root, tool.file_path);
  if (!path) return undefined;

  const ids = table.byFile?.[path];
  if (!ids || ids.length === 0) return undefined;

  const lines = original.split("\n").length;
  if (lines < MIN_LINES) return undefined;

  if (alreadyRead(root, input, path)) return undefined;
  rememberRead(root, input, path);

  const symbols = ids
    .map((id) => table.symbols?.[id])
    .filter(Boolean)
    .sort((a, b) => a.startLine - b.startLine);

  if (symbols.length === 0) return undefined;

  const body = symbols
    .map((s) => `  ${s.id}  ${s.exported ? "*" : " "}${s.signature}  :${s.startLine}-${s.endLine}`)
    .join("\n");

  return (
    `${path} — ${lines} lines, ${symbols.length} symbols (body elided by orvix)\n${body}\n\n` +
    `Exact source for any symbol: \`orvix show <id>\`.\n` +
    `Callers before you change a signature: \`orvix who-calls <id>\`.\n` +
    `For the raw text, read this file again or pass offset/limit.`
  );
}

/**
 * Rewrites search hits as the symbols that contain them.
 *
 * Passes through unless most hits land inside known symbols: a search for a
 * string literal, a config key or a TODO is exactly the case Orvix should stay
 * out of, and a low match rate is what that looks like. That same test is what
 * makes this safe to run over arbitrary Bash output, and safe to sit alongside
 * another tool's hook on the same event.
 */
function compressHits(root, table, original) {
  const lines = original.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 5) return undefined;

  const resolved = [];
  let recognised = 0;

  for (const line of lines) {
    const match = /^(.+?):(\d+):/.exec(line) ?? /^(.+?):(\d+)$/.exec(line);
    if (!match) continue;
    recognised += 1;

    const path = toRelative(root, match[1]) ?? match[1];
    const at = Number(match[2]);
    const symbol = symbolAt(table, path, at);
    if (symbol) resolved.push(symbol);
  }

  if (recognised === 0) return undefined;
  if (resolved.length / recognised < 0.5) return undefined;

  const unique = [...new Map(resolved.map((s) => [s.id, s])).values()];
  if (unique.length === 0) return undefined;

  const body = unique
    .map((s) => `${s.id}  ${s.exported ? "*" : " "}${s.file}:${s.startLine}  ${s.signature}`)
    .join("\n");

  return (
    `${unique.length} symbols contain the matches (${recognised} hits, resolved by orvix)\n${body}\n\n` +
    `\`orvix show <id>\` for exact source. Re-run the search if you need the raw lines.`
  );
}

function symbolAt(table, path, line) {
  for (const id of table.byFile?.[path] ?? []) {
    const symbol = table.symbols?.[id];
    if (symbol && line >= symbol.startLine && line <= symbol.endLine) return symbol;
  }
  return undefined;
}

function loadSymbols(root) {
  try {
    const table = JSON.parse(readFileSync(join(root, ".orvix", "symbols.json"), "utf8"));
    return table && typeof table === "object" && table.symbols ? table : undefined;
  } catch {
    return undefined;
  }
}

function toRelative(root, target) {
  try {
    const rel = relative(root, target);
    if (rel.startsWith("..") || rel.length === 0) return undefined;
    return rel.split(sep).join("/");
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Session memory                                                      */
/* ------------------------------------------------------------------ */

/**
 * Remembers which files this session has already read.
 *
 * Scoped to one session and reset when a new one starts. An append-only log
 * kept across sessions would be read in full on every single tool call and
 * never truncated — a file that grows without limit on the one path that has
 * to stay fast, degrading so gradually that nobody would connect it to Orvix
 * months later.
 *
 * The first line is the session it belongs to; a different id means the rest
 * is stale and the file is replaced.
 */
function sessionLog(root) {
  return join(root, ".orvix", "session.log");
}

function readLog(root, sessionId) {
  try {
    const raw = readFileSync(sessionLog(root), "utf8");
    const split = raw.indexOf("\n");
    if (split === -1) return "";
    return raw.slice(0, split) === sessionId ? raw.slice(split + 1) : "";
  } catch {
    return "";
  }
}

function append(root, sessionId, line) {
  try {
    const path = sessionLog(root);
    mkdirSync(dirname(path), { recursive: true });

    // A new session replaces the file rather than adding to it.
    if (readLog(root, sessionId) === "" && !belongsToSession(root, sessionId)) {
      writeFileSync(path, `${sessionId}\n${line}`, "utf8");
      return;
    }
    appendFileSync(path, line, "utf8");
  } catch {
    // Losing the note only means a later read is compressed again.
  }
}

function belongsToSession(root, sessionId) {
  try {
    const raw = readFileSync(sessionLog(root), "utf8");
    const split = raw.indexOf("\n");
    return split !== -1 && raw.slice(0, split) === sessionId;
  } catch {
    return false;
  }
}

function alreadyRead(root, input, path) {
  return readLog(root, input.session_id).includes(`read\t${path}\n`);
}

function rememberRead(root, input, path) {
  append(root, input.session_id, `read\t${path}\n`);
}

/** The teaching nudge is attached once per session, then never again. */
function firstTime(root, input) {
  if (readLog(root, input.session_id).includes("nudged\n")) return false;
  append(root, input.session_id, "nudged\n");
  return true;
}

/** Real measured deltas, so `orvix gain` reports observations not estimates. */
function record(root, input, original, replacement) {
  try {
    const path = join(root, ".orvix", "gain.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        session: input.session_id ?? "unknown",
        at: new Date().toISOString(),
        tool: input.tool_name,
        before: estimate(original),
        after: estimate(replacement),
      })}\n`,
      "utf8",
    );
  } catch {
    // Accounting is not worth failing a compression over.
  }
}

main();

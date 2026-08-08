#!/usr/bin/env node
/**
 * A diagnostic hook. Not installed by `orvix init` — enable it by hand when
 * you need to see what an agent actually sends.
 *
 * `tool_response` is not one shape. It differs per tool and between versions:
 * a bare string for some, `{ file: { content } }` for others, an array of
 * content blocks elsewhere. The compressor has to recognise the real shapes
 * rather than the ones that seemed likely, and this is how those are
 * established.
 *
 * Register it against whatever you want to inspect:
 *
 *   {
 *     "hooks": {
 *       "PostToolUse": [
 *         {
 *           "matcher": "Read|Grep|Glob",
 *           "hooks": [
 *             {
 *               "type": "command",
 *               "command": "node ${CLAUDE_PROJECT_DIR}/.claude/hooks/orvix-probe.mjs",
 *               "async": true
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Writes .orvix/probe.jsonl, one record per tool call. Emits nothing on
 * stdout, so it can never change what the model sees.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Enough to identify a shape, without copying whole files into the log. */
function describe(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return depth > 2
      ? "array"
      : { array: value.length, first: describe(value[0], depth + 1) };
  }
  if (typeof value === "object") {
    if (depth > 2) return "object";
    const shape = {};
    for (const [key, inner] of Object.entries(value)) {
      shape[key] = describe(inner, depth + 1);
    }
    return shape;
  }
  if (typeof value === "string") {
    return `string(${value.length})${value.length <= 120 ? `: ${value}` : ""}`;
  }
  return typeof value;
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const log = join(input.cwd ?? ".", ".orvix", "probe.jsonl");

  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(
    log,
    `${JSON.stringify({
      tool: input.tool_name,
      input: describe(input.tool_input),
      response: describe(input.tool_response),
      keys: Object.keys(input),
    })}\n`,
    "utf8",
  );
} catch {
  // A diagnostic must never break the session it is diagnosing.
}

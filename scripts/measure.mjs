// Reproduces the savings figures quoted in the README, against this repository.
//
// Run with `npm run measure` after `npm run build`. Numbers are expected to
// drift as the codebase grows — refresh the README from this output rather
// than editing the table by hand.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Same heuristic as src/render/tokens.ts, and the same caveat: this is an
// estimate, not a tokeniser. It is applied identically to both sides of every
// comparison, so the ratio holds even though the absolute counts are rough.
const CHARS_PER_TOKEN = 3.5;

/** @param {string} text @returns {number} */
const estimate = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** @param {...string} args @returns {string} */
const orvix = (...args) =>
  execFileSync(process.execPath, ["dist/main.js", ...args], {
    encoding: "utf8",
  });

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  /** @type {string[]} */
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }

  return found;
}

/** @typedef {{ task: string, before: number, after: number }} Row */

/** @type {Row[]} */
const rows = [];

// Queries answer from the prebuilt index and never parse on their own, and
// `.orvix/` is not committed — so a fresh checkout has nothing to read and
// every measurement below would be taken against an empty index.
orvix("index", ".");

// Scenario A — the agent already knows which symbol it needs to change.
// Without that, it pays for `map` first; see scenario B for that cost.
const target = "resolveModule";
const file = "src/core/resolve.ts";
const id = JSON.parse(orvix("find", target, "--json"))[0]?.id;
if (!id) throw new Error(`${target} is no longer in the index`);

rows.push({
  task: `Target one function (${target}) to edit it`,
  before: estimate(readFileSync(file, "utf8")),
  after: estimate(orvix("find", target)) + estimate(orvix("show", id)),
});

// Scenario B — taking in the whole project.
const everything = sourceFiles("src")
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

rows.push({
  task: "Take in the whole project's shape",
  before: estimate(everything),
  after: estimate(orvix("map", "--budget", "2000")),
});

/** @param {Row} row @returns {number} */
const pct = (row) => Math.round((1 - row.after / row.before) * 100);

console.log("| Task | Reading files | With orvix | Saved |");
console.log("|---|---|---|---|");
for (const row of rows) {
  console.log(
    `| ${row.task} | ~${row.before.toLocaleString("en-US")} | ~${row.after.toLocaleString("en-US")} | **${pct(row)}%** |`,
  );
}
console.log(
  `\nEstimated at ${CHARS_PER_TOKEN} characters per token. Measured against ${sourceFiles("src").length} source files.`,
);

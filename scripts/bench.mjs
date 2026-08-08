#!/usr/bin/env node
/**
 * Measures cold start of the query path — the number that matters, because
 * this runs once per hooked tool call.
 *
 * Reports bare Node alongside it deliberately. Node's own startup is the floor
 * nothing here can go below, and quoting a total without it invites the reader
 * to think the difference is Orvix's to win back.
 *
 * Usage: node scripts/bench.mjs [runs]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const RUNS = Number(process.argv[2] ?? 15);
const QUERY = "dist/query.js";
const MAIN = "dist/main.js";

if (!existsSync(QUERY)) {
  console.error(`${QUERY} not found — run \`npm run build\` first.`);
  process.exit(1);
}

/**
 * @param {string[]} args
 * @returns {number} milliseconds
 */
function time(args) {
  const started = process.hrtime.bigint();
  try {
    execFileSync(process.execPath, args, { stdio: "ignore" });
  } catch {
    // A non-zero exit still measures startup, which is what is being timed.
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * @param {string} label
 * @param {string[]} args
 * @returns {{ label: string, min: number, median: number, p90: number }}
 */
function measure(label, args) {
  // One untimed run first: the OS file cache, not Orvix, dominates otherwise.
  time(args);

  /** @type {number[]} */
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) samples.push(time(args));
  samples.sort((a, b) => a - b);

  return {
    label,
    min: samples[0] ?? 0,
    median: samples[Math.floor(samples.length / 2)] ?? 0,
    p90: samples[Math.floor(samples.length * 0.9)] ?? 0,
  };
}

const rows = [
  measure("node (floor)", ["-e", "0"]),
  measure("query show", [QUERY, "show", "resolveModule", "--path", "."]),
  measure("query find", [QUERY, "find", "resolve", "--path", "."]),
  measure("query map", [QUERY, "map", "--path", "."]),
];

if (existsSync(MAIN)) rows.push(measure("cli find (commander)", [MAIN, "find", "resolve"]));

/** @param {number} value */
const fixed = (value) => value.toFixed(1).padStart(7);

console.log(`runs=${RUNS} platform=${process.platform} node=${process.version}`);
for (const row of rows) {
  console.log(
    `${row.label.padEnd(22)} min=${fixed(row.min)} median=${fixed(row.median)} p90=${fixed(row.p90)}`,
  );
}

const floor = rows[0]?.median ?? 0;
const query = rows[1]?.median ?? 0;
console.log(`\nnode floor      ${floor.toFixed(1)} ms`);
console.log(`orvix overhead  ${(query - floor).toFixed(1)} ms`);
console.log(`query total     ${query.toFixed(1)} ms`);

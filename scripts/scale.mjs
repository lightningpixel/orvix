#!/usr/bin/env node
/**
 * Measures how indexing and querying behave as a project grows.
 *
 * End to end on generated projects rather than in memory: it runs the real
 * binaries on real files, because the claim being made is about what a user
 * waits for, not about how fast a function is in isolation.
 *
 * Usage: node scripts/scale.mjs [sizes...]      e.g. node scripts/scale.mjs 100 500 2000
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = SIZES.length > 0 ? SIZES : [100, 500, 2000];
const WORK = join(process.cwd(), ".scale");

if (!existsSync("dist/main.js")) {
  console.error("run `npm run build` first");
  process.exit(1);
}

/**
 * A module with a realistic mix: exported functions, cross-file imports and
 * calls, so the call graph has something to resolve rather than a flat list.
 *
 * @param {number} index
 * @param {number} total
 */
function moduleSource(index, total) {
  const previous = (index + total - 1) % total;
  const lines = [`import { entry${previous} } from "./mod${previous}.js";`, ""];

  for (let n = 0; n < 6; n += 1) {
    lines.push(
      `export function helper${index}_${n}(value: string): string {`,
      `  const trimmed = value.trim();`,
      `  return trimmed.padEnd(${n + 4}, ".");`,
      `}`,
      "",
    );
  }

  lines.push(
    `export function entry${index}(value: string): string {`,
    `  const a = helper${index}_0(value);`,
    `  const b = helper${index}_3(a);`,
    `  return entry${previous}(b);`,
    `}`,
    "",
  );

  return lines.join("\n");
}

/** @param {number} count */
function makeProject(count) {
  const root = join(WORK, `p${count}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "src"), { recursive: true });

  for (let n = 0; n < count; n += 1) {
    writeFileSync(join(root, "src", `mod${n}.ts`), moduleSource(n, count), "utf8");
  }
  return root;
}

/**
 * @param {string[]} args
 * @param {number} runs
 * @returns {number} median milliseconds
 */
function time(args, runs = 1) {
  /** @type {number[]} */
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = process.hrtime.bigint();
    execFileSync(process.execPath, args, { stdio: "ignore" });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

/** @param {string} path */
const kb = (path) => (existsSync(path) ? statSync(path).size / 1024 : 0);

console.log(`platform=${process.platform} node=${process.version}`);
console.log(
  "files  index_ms  query_ms  hot_kb  cold_kb  hot_share",
);

for (const count of sizes) {
  const root = makeProject(count);

  const indexMs = time(["dist/main.js", "index", root]);
  const queryMs = time(["dist/query.js", "show", `entry${Math.floor(count / 2)}`, "--path", root], 5);

  const hot = kb(join(root, ".orvix", "symbols.json")) + kb(join(root, ".orvix", "graph.json"));
  const cold = kb(join(root, ".orvix", "facts.json"));

  console.log(
    `${String(count).padStart(5)}  ${indexMs.toFixed(0).padStart(8)}  ${queryMs.toFixed(0).padStart(8)}  ` +
      `${hot.toFixed(0).padStart(6)}  ${cold.toFixed(0).padStart(7)}  ` +
      `${((hot / (hot + cold)) * 100).toFixed(0).padStart(8)}%`,
  );
}

rmSync(WORK, { recursive: true, force: true });

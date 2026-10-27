import { run } from "./run.js";

/**
 * Entry point of the query bundle. The parsing and dispatch live in run.ts so
 * they can be imported without running anything.
 */
async function main(): Promise<void> {
  try {
    const { output, ok } = await run(process.argv.slice(2));
    if (ok) console.log(output);
    else {
      console.error(output);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();

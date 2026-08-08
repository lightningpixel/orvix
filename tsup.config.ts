import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points, deliberately. `main` is the human CLI and carries
  // commander; `query` is what hooks invoke on every tool call and must stay
  // free of both commander and the tree-sitter runtime. Splitting keeps their
  // shared code in a chunk rather than duplicating it, and keeps anything only
  // the indexer needs out of the query graph.
  entry: { main: "src/main.ts", query: "src/query/main.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});

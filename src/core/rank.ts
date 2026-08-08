import type { OrvixIndex } from "../types.js";
import { allSymbols } from "./symbols.js";
import type { CallGraph } from "./resolve.js";

export interface RankOptions {
  /** Probability of following a call edge rather than restarting. */
  damping?: number;
  iterations?: number;
  /** How much more restart mass an exported symbol receives. */
  exportedBoost?: number;
}

const DEFAULTS = {
  damping: 0.85,
  iterations: 40,
  exportedBoost: 3,
} satisfies Required<RankOptions>;

/**
 * Scores every symbol by importance, so the map can be trimmed to a token
 * budget by dropping the least important first.
 *
 * This is PageRank over caller -> callee edges, personalised toward exported
 * symbols. The personalisation is what keeps a project's public surface
 * visible: an exported interface is never a call target, so on call edges
 * alone it would rank dead last despite being central to the API.
 *
 * Edges are counted once per caller/callee pair rather than per call site —
 * calling something in a loop body does not make it three times as important.
 */
export function rankSymbols(
  index: OrvixIndex,
  graph: CallGraph,
  options: RankOptions = {},
): Map<string, number> {
  const { damping, iterations, exportedBoost } = { ...DEFAULTS, ...options };

  const symbols = allSymbols(index);
  if (symbols.length === 0) return new Map();

  // Restart distribution: where a random walk lands when it does not follow
  // an edge. Weighted so exported symbols keep a floor of importance.
  const restart = new Map<string, number>();
  let totalWeight = 0;
  for (const symbol of symbols) {
    const weight = symbol.exported ? exportedBoost : 1;
    restart.set(symbol.id, weight);
    totalWeight += weight;
  }
  for (const [id, weight] of restart) restart.set(id, weight / totalWeight);

  let ranks = new Map(symbols.map((symbol) => [symbol.id, 1 / symbols.length]));

  for (let round = 0; round < iterations; round += 1) {
    const next = new Map<string, number>();

    // Symbols that call nothing would leak rank out of the system; their mass
    // is redistributed over the restart vector instead.
    let dangling = 0;
    for (const [id, rank] of ranks) {
      if ((graph.callees.get(id)?.size ?? 0) === 0) dangling += rank;
    }

    for (const symbol of symbols) {
      const teleport = restart.get(symbol.id)!;
      let inflow = 0;

      for (const caller of graph.callers.get(symbol.id) ?? []) {
        const outDegree = graph.callees.get(caller)?.size ?? 0;
        if (outDegree > 0) inflow += (ranks.get(caller) ?? 0) / outDegree;
      }

      next.set(
        symbol.id,
        (1 - damping) * teleport + damping * (inflow + dangling * teleport),
      );
    }

    ranks = next;
  }

  return ranks;
}

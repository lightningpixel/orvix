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

  return pagerank(
    {
      ids: symbols.map((symbol) => symbol.id),
      restart,
      inbound: (id) => graph.callers.get(id) ?? [],
      outDegree: (id) => graph.callees.get(id)?.size ?? 0,
    },
    damping,
    iterations,
  );
}

/** A random walk over symbols, described by who passes rank to whom. */
export interface Walk {
  ids: readonly string[];
  /** Where the walk lands when it does not follow an edge; sums to 1. */
  restart: ReadonlyMap<string, number>;
  /** The symbols whose rank flows into this one. */
  inbound: (id: string) => Iterable<string>;
  /** How many symbols this one passes its rank on to. */
  outDegree: (id: string) => number;
}

/**
 * Personalised PageRank by power iteration.
 *
 * Shared by the index-time ranking and by the focused map, which differ only
 * in their restart vector and in which way the edges point.
 */
export function pagerank(
  walk: Walk,
  damping: number = DEFAULTS.damping,
  iterations: number = DEFAULTS.iterations,
): Map<string, number> {
  const { ids, restart, inbound, outDegree } = walk;
  let ranks = new Map(ids.map((id) => [id, 1 / ids.length]));

  for (let round = 0; round < iterations; round += 1) {
    const next = new Map<string, number>();

    // Symbols that pass rank to nothing would leak it out of the system; their
    // mass is redistributed over the restart vector instead.
    let dangling = 0;
    for (const [id, rank] of ranks) {
      if (outDegree(id) === 0) dangling += rank;
    }

    for (const id of ids) {
      const teleport = restart.get(id) ?? 0;
      let inflow = 0;

      for (const source of inbound(id)) {
        const degree = outDegree(source);
        if (degree > 0) inflow += (ranks.get(source) ?? 0) / degree;
      }

      next.set(
        id,
        (1 - damping) * teleport + damping * (inflow + dangling * teleport),
      );
    }

    ranks = next;
  }

  return ranks;
}

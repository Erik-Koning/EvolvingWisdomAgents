import type { NodeId, RoutingMatch, RoutingResult } from "@apgraph/schema";
import { Graph } from "./graph.js";
import { serializeOutline, embedText } from "./outline.js";
import { evalCondition } from "./expr.js";
import { resolveBring } from "./bring.js";
import type { Connectors } from "./connectors.js";

export interface RouteOptions {
  /** Session vars for entryCondition gating. */
  sessionVars?: Record<string, unknown>;
  connectors: Connectors;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        required: ["nodeId", "confidence"],
        properties: {
          nodeId: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
};

/**
 * Hybrid router (§7.2): eligibility gate → embedding shortlist → canonical
 * outline → single-pass structured classification → confidence gate →
 * tie-break → fallback. No randomness anywhere.
 */
export async function route(query: string, graph: Graph, opts: RouteOptions): Promise<RoutingResult> {
  const llm = opts.connectors.llm;
  if (!llm) throw new Error("Driver missing: llm connector is required for routing");
  const routing = graph.routing();
  const vars = opts.sessionVars ?? {};

  // 1. eligibility: routable, not pruned, entryCondition holds
  const eligible = graph
    .dfs()
    .filter((n) => n.routable !== false && !graph.isPruned(n.id))
    .filter((n) => (n.entryCondition ? evalCondition(n.entryCondition, vars) : true))
    .map((n) => n.id);

  // 2. embedding pre-filter. Stored node.embedding vectors are preferred;
  //    the connector is only called for the query plus nodes lacking a
  //    precomputed vector. Scores compute when the pool needs shrinking OR
  //    the graph opts into the embedBypass fast path (which needs them even
  //    for small pools).
  let shortlist = eligible;
  let bypass: RoutingMatch | null = null;
  const wantScores =
    opts.connectors.embeddings &&
    eligible.length > 0 &&
    (eligible.length > routing.shortlistK || routing.embedBypass !== null);
  if (opts.connectors.embeddings && wantScores) {
    const vectors = new Map<NodeId, number[]>();
    const missing: NodeId[] = [];
    for (const id of eligible) {
      const stored = graph.get(id).embedding;
      if (stored && stored.length > 0) vectors.set(id, stored);
      else missing.push(id);
    }
    const [queryVec, ...computed] = await opts.connectors.embeddings.embed([
      query,
      ...missing.map((id) => embedText(graph, id)),
    ]);
    missing.forEach((id, i) => vectors.set(id, computed[i]!));
    const scored = eligible.map((id) => ({ id, sim: cosine(queryVec!, vectors.get(id)!) }));
    scored.sort((a, b) => (b.sim !== a.sim ? b.sim - a.sim : graph.compareNodes(a.id, b.id)));

    // fast path: a decisive top-1 answers routing without the LLM. Two gates
    // (absolute similarity + margin over the runner-up); confidence = cosine,
    // reason "embedding". minConfidence governs only the classify path.
    const bp = routing.embedBypass;
    if (bp && scored.length > 0) {
      const top = scored[0]!;
      const second = scored[1];
      if (top.sim >= bp.minSimilarity && (second === undefined || top.sim - second.sim >= bp.minMargin)) {
        bypass = { nodeId: top.id, confidence: top.sim, reason: "embedding" };
      }
    }

    shortlist = scored.slice(0, routing.shortlistK).map((s) => s.id);
    // restore DFS order for outline stability
    const inShortlist = new Set(shortlist);
    shortlist = eligible.filter((id) => inShortlist.has(id));
  }

  let matches: RoutingMatch[];
  let fallbackUsed = false;
  if (bypass) {
    matches = [bypass];
  } else {
    // 3. canonical outline over surviving branches
    const outline = serializeOutline(graph, shortlist);
    const outlineIds = new Set(shortlist);

    // 4. single-pass structured classification
    const rawResponse = await llm.classify({
      query,
      outline,
      schema: CLASSIFY_SCHEMA,
      multi: routing.allowMulti,
    });

    // dedupe by nodeId, keeping the highest-confidence entry
    const byNode = new Map<NodeId, RoutingMatch>();
    for (const m of rawResponse) {
      const prior = byNode.get(m.nodeId);
      if (!prior || m.confidence > prior.confidence) byNode.set(m.nodeId, m);
    }
    const raw = [...byNode.values()];

    // 5. safety filter + confidence gate + tie-break total order
    const gated = raw
      .filter((m) => outlineIds.has(m.nodeId))
      .filter((m) => m.confidence >= routing.minConfidence)
      .sort(compareMatches(graph));

    matches = routing.allowMulti ? gated : gated.slice(0, 1);

    // 6. fallback: below-threshold top candidate's nearest fallbackNodeId →
    //    first isFallback node in DFS order → root
    if (matches.length === 0) {
      fallbackUsed = true;
      const rawSorted = [...raw].filter((m) => outlineIds.has(m.nodeId)).sort(compareMatches(graph));
      const target =
        (rawSorted[0] && nearestFallback(graph, rawSorted[0].nodeId)) ??
        graph.dfs().find((n) => n.isFallback === true && !graph.isPruned(n.id))?.id ??
        graph.rootId;
      matches = [{ nodeId: target, confidence: 0, reason: "fallback" }];
    }
  }

  // 7. companion context, unioned in match order
  const broughtNodes: NodeId[] = [];
  const seen = new Set<NodeId>();
  for (const m of matches) {
    for (const b of resolveBring(graph, m.nodeId).brought) {
      if (!seen.has(b)) {
        seen.add(b);
        broughtNodes.push(b);
      }
    }
  }

  return {
    matches,
    strategy: matches.length > 1 ? "multi" : "single",
    fallbackUsed,
    broughtNodes,
    shortlist,
    cacheHit: false,
  };
}

function compareMatches(graph: Graph) {
  return (a: RoutingMatch, b: RoutingMatch): number => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return graph.compareNodes(a.nodeId, b.nodeId);
  };
}

function nearestFallback(graph: Graph, id: NodeId): NodeId | undefined {
  const path = graph.pathTo(id);
  for (let i = path.length - 1; i >= 0; i--) {
    const fb = path[i]!.fallbackNodeId;
    if (fb && graph.has(fb) && !graph.isPruned(fb)) return fb;
  }
  return undefined;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

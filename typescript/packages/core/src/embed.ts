import type { GraphDoc } from "@apgraph/schema";
import { Graph } from "./graph.js";
import { embedText } from "./outline.js";
import type { EmbeddingsConnector } from "./connectors.js";

export interface PrecomputeOptions {
  /** Re-embed nodes that already carry a vector (e.g. after a descriptor change). */
  force?: boolean;
}

/**
 * Precompute node.embedding for every routable, non-pruned node missing one
 * (the write-path half of the router's stored-vector preference). Embeds the
 * embedText fields only — never prompt payloads. Returns a new doc; the input
 * is untouched. No-op (and zero connector calls) when nothing is missing.
 */
export async function precomputeEmbeddings(
  doc: GraphDoc,
  embeddings: EmbeddingsConnector,
  opts: PrecomputeOptions = {},
): Promise<GraphDoc> {
  const graph = new Graph(doc);
  const targets = graph
    .dfs()
    .filter((n) => n.routable !== false && !graph.isPruned(n.id))
    .filter((n) => opts.force || !n.embedding || n.embedding.length === 0)
    .map((n) => n.id);
  if (targets.length === 0) return doc;

  const vectors = await embeddings.embed(targets.map((id) => embedText(graph, id)));
  const next = structuredClone(doc);
  const byId = new Map(next.nodes.map((n) => [n.id, n]));
  targets.forEach((id, i) => {
    byId.get(id)!.embedding = vectors[i]!;
  });
  return next;
}

import type { ApgNode, NodeId } from "@apgraph/schema";
import { Graph, nodeField } from "./graph.js";

export interface FindNodesOptions {
  /** Scope the search to one field (reserved key or props.* path); default = effective descriptor + aliases. */
  field?: string;
  /** Restrict to the subtree rooted at this node (inclusive). */
  subtreeId?: NodeId;
}

/**
 * Case-insensitive substring search over descriptor fields and props — how an
 * agent (or the harvest loop) finds existing nodes before adding new ones.
 */
export function findNodes(graph: Graph, query: string, opts: FindNodesOptions = {}): ApgNode[] {
  const q = query.toLowerCase();
  return scope(graph, opts.subtreeId).filter((node) => {
    const fields = opts.field ? [opts.field] : [...graph.descriptorFor(node.id), "aliases"];
    return fields.some((f) => nodeField(node, f).toLowerCase().includes(q));
  });
}

/**
 * Union of props.* keys in use (with counts) so an agent landing on an
 * unfamiliar graph learns its vocabulary before searching.
 */
export function listPropertyKeys(graph: Graph, subtreeId?: NodeId): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of scope(graph, subtreeId)) {
    for (const key of Object.keys(node.props ?? {})) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function scope(graph: Graph, subtreeId?: NodeId): ApgNode[] {
  if (subtreeId === undefined) return graph.dfs();
  return graph.dfs().filter((n) => graph.pathTo(n.id).some((a) => a.id === subtreeId));
}

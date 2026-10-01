import type { NodeId } from "@apgraph/schema";
import { Graph, nodeField } from "./graph.js";

/**
 * Canonical router outline (determinism contract §7.1):
 * - depth-first, authored sibling order
 * - two-space indent per rendered-ancestor count
 * - one line per node: `{id}: {descriptor fields joined " — "}`
 * - descriptor fields render in declared order; empty fields skipped
 * - text NFC-normalized; newlines collapsed to a single space
 * - routable, non-pruned nodes only; a shortlist restricts to those nodes
 *   plus their rendered ancestors
 *
 * The outline for a given (graph, shortlist) is byte-stable: it is both a
 * cache-key input and a fixture assertion.
 */
export function serializeOutline(graph: Graph, shortlist?: NodeId[]): string {
  const include = renderSet(graph, shortlist);
  const lines: string[] = [];
  const walk = (id: NodeId, renderedDepth: number) => {
    const node = graph.get(id);
    const rendered = include.has(id);
    if (rendered) {
      const fields = graph
        .descriptorFor(id)
        .map((f) => cleanText(nodeField(node, f)))
        .filter((s) => s.length > 0);
      lines.push(`${"  ".repeat(renderedDepth)}${id}: ${fields.join(" — ")}`);
    }
    for (const child of graph.childrenOf.get(id) ?? []) {
      walk(child, rendered ? renderedDepth + 1 : renderedDepth);
    }
  };
  walk(graph.rootId, 0);
  return lines.join("\n");
}

/** Nodes rendered in the outline: eligible targets plus their eligible ancestors. */
function renderSet(graph: Graph, shortlist?: NodeId[]): Set<NodeId> {
  const eligible = (id: NodeId) => {
    const n = graph.get(id);
    return n.routable !== false && !graph.isPruned(id);
  };
  const include = new Set<NodeId>();
  if (shortlist === undefined) {
    for (const n of graph.dfs()) if (eligible(n.id)) include.add(n.id);
    return include;
  }
  for (const id of shortlist) {
    if (!graph.has(id) || !eligible(id)) continue;
    for (const anc of graph.pathTo(id)) {
      if (eligible(anc.id)) include.add(anc.id);
    }
  }
  return include;
}

export function cleanText(s: string): string {
  return s.normalize("NFC").replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Text indexed by the embedding pre-filter for a node. */
export function embedText(graph: Graph, id: NodeId): string {
  const node = graph.get(id);
  const fields = graph
    .embedTextFieldsFor(id)
    .map((f) => cleanText(nodeField(node, f)))
    .filter((s) => s.length > 0);
  return fields.join(" — ");
}

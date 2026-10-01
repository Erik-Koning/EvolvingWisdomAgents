import type { Graph, LlmConnector, RoutingMatch } from "@apgraph/core";

/**
 * Deterministic lexical classifier: the offline/demo routing driver. Scores
 * token overlap between the query and each outline line (plus node aliases
 * when constructed with a graph). Real deployments use AnthropicLlm or any
 * other LlmConnector — the routing algorithm is identical either way.
 */
export class LexicalLlm implements LlmConnector {
  constructor(private graph?: Graph) {}

  async classify(input: { query: string; outline: string }): Promise<RoutingMatch[]> {
    const queryTokens = tokenize(input.query);
    const matches: RoutingMatch[] = [];
    for (const line of input.outline.split("\n")) {
      const m = line.match(/^\s*([^:]+): (.*)$/);
      if (!m) continue;
      const nodeId = m[1]!.trim();
      const descriptorTokens = tokenize(m[2]!);
      if (this.graph?.has(nodeId)) {
        for (const alias of this.graph.get(nodeId).aliases ?? []) descriptorTokens.push(...tokenize(alias));
      }
      const overlap = queryTokens.filter((t) => descriptorTokens.includes(t)).length;
      if (overlap === 0) continue;
      // saturating scale so multi-token overlap clears the default 0.55 gate
      matches.push({
        nodeId,
        confidence: Math.min(1, 0.4 + 0.2 * overlap),
        reason: `lexical overlap: ${overlap} token(s)`,
      });
    }
    return matches;
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/)
    .filter((t) => t.length > 2);
}

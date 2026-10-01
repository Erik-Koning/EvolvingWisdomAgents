import type { NodeId } from "@apgraph/schema";
import { Graph } from "./graph.js";

export interface BringResolution {
  /** Brought node ids, BFS order (a level's brings in array order). */
  brought: NodeId[];
  /** Depth of each brought node relative to the landing node (direct = 1). */
  depths: Record<NodeId, number>;
  /** References to unknown nodes, recorded for telemetry, never fatal at runtime. */
  dangling: NodeId[];
  /** Brings skipped for crossing a tenant boundary. */
  tenantBlocked: NodeId[];
}

/**
 * BFS bring expansion (spec §7.3): the landing node's recursiveBring governs
 * the whole expansion (one hop only when false); seen-set cycle safety; depth
 * capped by the landing node's maxBringDepth; tenant boundaries respected.
 */
export function resolveBring(graph: Graph, landingId: NodeId): BringResolution {
  const landing = graph.get(landingId);
  const recursive = landing.recursiveBring ?? false;
  const maxDepth = landing.maxBringDepth ?? 3;
  const landingTenant = landing.metadata?.tenantId;

  const brought: NodeId[] = [];
  const depths: Record<NodeId, number> = {};
  const dangling: NodeId[] = [];
  const tenantBlocked: NodeId[] = [];
  const seen = new Set<NodeId>([landingId]);

  let frontier: NodeId[] = [...(landing.bring ?? [])];
  let depth = 1;
  while (frontier.length > 0 && depth <= maxDepth) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!graph.has(id)) {
        dangling.push(id);
        continue;
      }
      const node = graph.get(id);
      if (graph.isPruned(id)) continue;
      const nodeTenant = node.metadata?.tenantId;
      if (landingTenant !== undefined && nodeTenant !== undefined && nodeTenant !== landingTenant) {
        tenantBlocked.push(id);
        continue;
      }
      brought.push(id);
      depths[id] = depth;
      if (recursive) next.push(...(node.bring ?? []));
    }
    frontier = next;
    depth++;
    if (!recursive) break;
  }
  return { brought, depths, dangling, tenantBlocked };
}

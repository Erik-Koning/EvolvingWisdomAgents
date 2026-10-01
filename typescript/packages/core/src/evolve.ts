// Loop-3 growth utilities ("deep sleep"): deterministic math + op-building
// for taxonomy evolution. The LLM-judgment stages (labeling clusters,
// new-sibling vs boundary-fix) are host patterns; everything here is pure and
// mirrored in both runtimes. Resulting ops flow through the pinned
// applyChangeset, so behavior stays inside the conformance contract.
import type { ApgNode, MutationOp, NodeId } from "@apgraph/schema";
import { Graph } from "./graph.js";

export function cosineSimilarity(a: number[], b: number[]): number {
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

export interface ClusterOptions {
  /** Minimum cosine similarity to join a cluster (single-link). */
  threshold: number;
  /** Clusters smaller than this are dropped as noise (default 2). */
  minSize?: number;
}

/**
 * Deterministic greedy single-link clustering: items join the FIRST existing
 * cluster containing any member within threshold, in input order — no
 * randomness, no dependency. Returns clusters of input indices.
 */
export function clusterBySimilarity(vectors: number[][], opts: ClusterOptions): number[][] {
  const minSize = opts.minSize ?? 2;
  const clusters: number[][] = [];
  for (let i = 0; i < vectors.length; i++) {
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.some((j) => cosineSimilarity(vectors[i]!, vectors[j]!) >= opts.threshold)) {
        cluster.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([i]);
  }
  return clusters.filter((c) => c.length >= minSize);
}

/** The most central member: max total similarity, tie → lowest index. */
export function medoid(vectors: number[][], indices: number[]): number {
  let best = indices[0]!;
  let bestScore = -Infinity;
  for (const i of indices) {
    let score = 0;
    for (const j of indices) if (i !== j) score += cosineSimilarity(vectors[i]!, vectors[j]!);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export interface SplitGroup {
  /** The new subcategory node (id must be new; parentId is overwritten). */
  newCategory: ApgNode;
  /** Learning nodes (members of the category's bring) this group takes. */
  take: NodeId[];
}

/**
 * Ops that grow a category into subcategories: add each new subcategory under
 * the category, MOVE the taken learnings beneath it, and emit one
 * authoritative setBring per touched anchor (the removal-set lesson — no
 * stale-snapshot clobbering). Validated by applyChangeset downstream.
 */
export function buildSplitOps(graph: Graph, categoryId: NodeId, groups: SplitGroup[]): MutationOp[] {
  const category = graph.get(categoryId);
  const resident = new Set(category.bring ?? []);
  const taken = new Set<NodeId>();
  const ops: MutationOp[] = [];

  for (const group of groups) {
    if (graph.has(group.newCategory.id)) {
      throw new Error(`buildSplitOps: node id already exists: ${group.newCategory.id}`);
    }
    const take = group.take.filter((id) => resident.has(id) && !taken.has(id));
    if (take.length === 0) continue;
    for (const id of take) taken.add(id);
    ops.push({
      op: "addNode",
      parentId: categoryId,
      node: { ...structuredClone(group.newCategory), parentId: categoryId },
    });
    for (const id of take) {
      ops.push({ op: "moveNode", id, newParentId: group.newCategory.id });
    }
    ops.push({ op: "setBring", id: group.newCategory.id, bring: take });
  }

  if (taken.size > 0) {
    ops.push({
      op: "setBring",
      id: categoryId,
      bring: (category.bring ?? []).filter((id) => !taken.has(id)),
    });
  }
  return ops;
}

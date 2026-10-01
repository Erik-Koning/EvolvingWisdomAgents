import type {
  ApgNode,
  Changeset,
  GraphDoc,
  GraphLayer,
  LayerConflict,
  MutationOp,
  NodeId,
} from "@apgraph/schema";
import { Graph } from "./graph.js";
import { normalizeDocument, normalizeNode, materializeEdges } from "./loader.js";
import { isPlainObject } from "./minischema.js";
import { validateGraph } from "./validator.js";

// ---- op application (§7.1: transactional and ordered) ----

/**
 * Apply a single op to a normalized document, returning a new document.
 * Throws on structural failure (unknown ids, cycles, collisions). The nodes
 * array is re-emitted in DFS order after every op.
 */
export function applyOp(doc: GraphDoc, op: MutationOp): GraphDoc {
  const next: GraphDoc = structuredClone(doc);
  const graph = new Graph(next);
  const nodes = () => next.nodes;

  const require = (id: NodeId, what = "node"): ApgNode => {
    const n = nodes().find((x) => x.id === id);
    if (!n) throw new Error(`Unknown ${what} id: ${id}`);
    return n;
  };
  const childIds = (parentId: NodeId): NodeId[] =>
    nodes().filter((n) => n.parentId === parentId).map((n) => n.id);
  const subtreeIds = (rootId: NodeId): Set<NodeId> => {
    const out = new Set<NodeId>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes()) {
        if (n.parentId !== null && out.has(n.parentId) && !out.has(n.id)) {
          out.add(n.id);
          grew = true;
        }
      }
    }
    return out;
  };
  // Sibling order is order of appearance in the flat array; a position among
  // siblings maps to a flat insertion point just before the sibling currently
  // at that position (or the end).
  const insertAtSiblingPosition = (node: ApgNode, position?: number) => {
    const siblings = childIds(node.parentId!);
    const pos = position === undefined ? siblings.length : Math.min(position, siblings.length);
    if (pos >= siblings.length) {
      next.nodes.push(node);
    } else {
      const beforeId = siblings[pos]!;
      const idx = next.nodes.findIndex((n) => n.id === beforeId);
      next.nodes.splice(idx, 0, node);
    }
  };

  switch (op.op) {
    case "addNode": {
      require(op.parentId, "parent");
      if (nodes().some((n) => n.id === op.node.id)) throw new Error(`Node id already exists: ${op.node.id}`);
      const node = normalizeNode({ ...structuredClone(op.node), parentId: op.parentId });
      insertAtSiblingPosition(node, op.position);
      break;
    }
    case "updateNode": {
      const node = require(op.id);
      if ("id" in op.patch) throw new Error("updateNode may not change id");
      if ("parentId" in op.patch) throw new Error("updateNode may not change parentId; use moveNode");
      deepMergeInto(node as unknown as Record<string, unknown>, op.patch);
      // re-normalize so patches keep the doc canonical (string prompts
      // desugar; patched bring/collect/decision get their defaults)
      const idx = next.nodes.findIndex((n) => n.id === op.id);
      next.nodes[idx] = normalizeNode(node);
      break;
    }
    case "moveNode": {
      const node = require(op.id);
      if (node.parentId === null) throw new Error("Cannot move the root node");
      require(op.newParentId, "parent");
      if (subtreeIds(op.id).has(op.newParentId)) {
        throw new Error(`moveNode would create a cycle: ${op.id} → ${op.newParentId}`);
      }
      next.nodes.splice(next.nodes.findIndex((n) => n.id === op.id), 1);
      node.parentId = op.newParentId;
      insertAtSiblingPosition(node, op.position);
      break;
    }
    case "deleteNode": {
      const node = require(op.id);
      if (node.parentId === null) throw new Error("Cannot delete the root node");
      if (op.orphans === "cascade") {
        const doomed = subtreeIds(op.id);
        for (const id of doomed) assertNotPinned(require(id), op.force);
        next.nodes = nodes().filter((n) => !doomed.has(n.id));
      } else {
        assertNotPinned(node, op.force);
        for (const n of nodes()) if (n.parentId === op.id) n.parentId = node.parentId;
        next.nodes = nodes().filter((n) => n.id !== op.id);
      }
      break;
    }
    case "pruneSubtree": {
      require(op.id);
      for (const id of subtreeIds(op.id)) assertNotPinned(require(id), op.force);
      for (const id of subtreeIds(op.id)) {
        const n = require(id);
        n.metadata = { ...(n.metadata ?? {}), status: "pruned" };
      }
      break;
    }
    case "graftSubtree": {
      require(op.parentId, "parent");
      const incoming = new Set(op.nodes.map((n) => n.id));
      for (const n of op.nodes) {
        if (nodes().some((x) => x.id === n.id)) throw new Error(`graftSubtree collides on node id: ${n.id}`);
      }
      for (const n of op.nodes) {
        const node = normalizeNode(structuredClone(n));
        if (node.parentId === null || node.parentId === undefined || !incoming.has(node.parentId)) {
          node.parentId = op.parentId;
        }
        next.nodes.push(node);
      }
      break;
    }
    case "mergeNodes": {
      const into = require(op.intoId, "merge target");
      for (const id of op.ids) {
        if (id === op.intoId) continue;
        const victim = require(id);
        assertNotPinned(victim, op.force); // merging INTO a pinned node is fine
        if (subtreeIds(id).has(op.intoId)) throw new Error(`mergeNodes target ${op.intoId} is inside merged subtree ${id}`);
        const aliases = [...(into.aliases ?? [])];
        for (const a of [victim.title, ...(victim.aliases ?? [])]) {
          if (a !== undefined && a !== "" && !aliases.includes(a)) aliases.push(a);
        }
        if (aliases.length > 0) into.aliases = aliases;
        const bring = [...(into.bring ?? [])];
        for (const b of victim.bring ?? []) if (!bring.includes(b) && b !== op.intoId) bring.push(b);
        if (bring.length > 0) into.bring = bring;
        for (const n of nodes()) if (n.parentId === id) n.parentId = op.intoId;
        next.nodes = nodes().filter((n) => n.id !== id);
        rewriteReferences(next, id, op.intoId);
      }
      break;
    }
    case "splitNode": {
      const original = require(op.id);
      for (const part of op.partitions) {
        if (nodes().some((x) => x.id === part.node.id)) throw new Error(`splitNode collides on node id: ${part.node.id}`);
      }
      for (const part of op.partitions) {
        const node = normalizeNode({ ...structuredClone(part.node), parentId: op.id });
        const takes = part.takes.filter((t) => (original.aliases ?? []).includes(t));
        if (takes.length > 0) {
          original.aliases = (original.aliases ?? []).filter((a) => !takes.includes(a));
          const merged = [...(node.aliases ?? [])];
          for (const t of takes) if (!merged.includes(t)) merged.push(t);
          node.aliases = merged;
        }
        next.nodes.push(node);
      }
      break;
    }
    case "reorderChildren": {
      require(op.parentId, "parent");
      const current = childIds(op.parentId);
      if (current.length !== op.order.length || !current.every((id) => op.order.includes(id))) {
        throw new Error(`reorderChildren order must be a permutation of current children of ${op.parentId}`);
      }
      const byId = new Map(nodes().map((n) => [n.id, n]));
      const childSet = new Set(current);
      const orderQueue = op.order.map((id) => byId.get(id)!);
      next.nodes = nodes().map((n) => (childSet.has(n.id) ? orderQueue.shift()! : n));
      break;
    }
    case "setBring": {
      const node = require(op.id);
      node.bring = [...op.bring];
      node.recursiveBring = op.recursiveBring ?? node.recursiveBring ?? false;
      node.bringMode = node.bringMode ?? "contextOnly";
      node.maxBringDepth = node.maxBringDepth ?? 3;
      break;
    }
    case "linkChoice": {
      const node = require(op.decisionId);
      if (node.type !== "decision" || !node.decision) throw new Error(`Node ${op.decisionId} is not a decision node`);
      const existing = node.decision.choices.findIndex((c) => c.value === op.choice.value);
      if (existing >= 0) node.decision.choices[existing] = { ...op.choice };
      else node.decision.choices.push({ ...op.choice });
      break;
    }
    case "unlinkChoice": {
      const node = require(op.decisionId);
      if (node.type !== "decision" || !node.decision) throw new Error(`Node ${op.decisionId} is not a decision node`);
      const idx = node.decision.choices.findIndex((c) => c.value === op.value);
      if (idx < 0) throw new Error(`No choice with value "${op.value}" on decision ${op.decisionId}`);
      node.decision.choices.splice(idx, 1);
      break;
    }
    case "setEdge": {
      if (op.edge.kind !== "seeAlso" && op.edge.kind !== "aliasOf" && op.edge.kind !== "fallback") {
        throw new Error(`setEdge supports seeAlso|aliasOf|fallback, got: ${op.edge.kind}`);
      }
      require(op.edge.from);
      require(op.edge.to);
      if (op.edge.kind === "fallback") {
        require(op.edge.from).fallbackNodeId = op.edge.to;
      } else {
        next.edges = next.edges ?? [];
        if (!next.edges.some((e) => e.from === op.edge.from && e.to === op.edge.to && e.kind === op.edge.kind)) {
          next.edges.push({ ...op.edge });
        }
      }
      break;
    }
    case "removeEdge": {
      if (op.edge.kind === "fallback") {
        const node = require(op.edge.from);
        if (node.fallbackNodeId === op.edge.to) delete node.fallbackNodeId;
      } else {
        next.edges = (next.edges ?? []).filter(
          (e) => !(e.from === op.edge.from && e.to === op.edge.to && e.kind === op.edge.kind),
        );
      }
      break;
    }
    case "updateGraphConfig": {
      if (op.patch.defaults) {
        next.defaults = next.defaults ?? {};
        deepMergeInto(next.defaults as Record<string, unknown>, op.patch.defaults as Record<string, unknown>);
      }
      if (op.patch.meta) {
        next.meta = next.meta ?? {};
        deepMergeInto(next.meta as Record<string, unknown>, op.patch.meta as Record<string, unknown>);
      }
      if (op.patch.variables) next.variables = structuredClone(op.patch.variables);
      break;
    }
    case "updateRoutingConfig": {
      next.defaults = next.defaults ?? {};
      next.defaults.routing = next.defaults.routing ?? {};
      if (op.patch.descriptor) next.defaults.routing.descriptor = [...op.patch.descriptor];
      if (op.patch.embedText) next.defaults.routing.embedText = [...op.patch.embedText];
      break;
    }
    default: {
      const never: never = op;
      throw new Error(`Unknown op: ${JSON.stringify(never)}`);
    }
  }

  void graph;
  // re-emit DFS order + refreshed edges
  const rebuilt = new Graph(next);
  next.nodes = rebuilt.dfs().map((n) => n);
  next.edges = materializeEdges(next);
  return next;
}

/** Pinned nodes are protected from removal ops; content edits stay legal (§9). */
function assertNotPinned(node: ApgNode, force: boolean | undefined): void {
  if (node.pinned === true && force !== true) {
    throw new Error(`Node "${node.id}" is pinned (pass force to override)`);
  }
}

/** updateNode patch semantics: deep-merge; null deletes a key; arrays replace wholesale. */
export function deepMergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMergeInto(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function rewriteReferences(doc: GraphDoc, from: NodeId, to: NodeId): void {
  for (const node of doc.nodes) {
    if (node.bring) node.bring = dedupe(node.bring.map((b) => (b === from ? to : b)).filter((b) => b !== node.id));
    if (node.fallbackNodeId === from) node.fallbackNodeId = to;
    if (node.decision) {
      for (const c of node.decision.choices) if (c.next === from) c.next = to;
      if (node.decision.timeoutNext === from) node.decision.timeoutNext = to;
      if (node.decision.freeform) {
        node.decision.freeform.classifyInto = dedupe(node.decision.freeform.classifyInto.map((x) => (x === from ? to : x)));
      }
    }
    if (node.action) {
      if (node.action.onSuccess === from) node.action.onSuccess = to;
      if (node.action.onError === from) node.action.onError = to;
    }
    if (node.escalation?.resumeNode === from) node.escalation.resumeNode = to;
  }
  doc.edges = (doc.edges ?? []).map((e) => ({
    ...e,
    from: e.from === from ? to : e.from,
    to: e.to === from ? to : e.to,
  }));
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ---- changesets (base/tenant scope: full pipeline, atomic) ----

export function createChangeset(doc: GraphDoc, createdBy: string, id = "cs-draft"): Changeset {
  return { id, baseGraphVersion: doc.version ?? "0", ops: [], status: "draft", createdBy };
}

/**
 * Transactional application: any op failure aborts the whole changeset; the
 * result must pass structural validation; version suffix increments
 * deterministically.
 */
export function applyChangeset(doc: GraphDoc, ops: MutationOp[]): GraphDoc {
  let next = doc;
  ops.forEach((op, i) => {
    try {
      next = applyOp(next, op);
    } catch (err) {
      throw new Error(`Changeset aborted at op ${i} (${op.op}): ${(err as Error).message}`);
    }
  });
  const report = validateGraph(next);
  if (!report.valid) {
    const first = report.errors[0]!;
    throw new Error(`Changeset produced an invalid graph: ${first.code}${first.nodeId ? ` at ${first.nodeId}` : ""}`);
  }
  const result = structuredClone(next);
  result.version = bumpVersion(doc.version ?? "0");
  return result;
}

export function bumpVersion(version: string): string {
  const m = version.match(/^(.*)-(\d+)$/);
  if (m) return `${m[1]}-${Number(m[2]) + 1}`;
  return `${version}-1`;
}

// ---- layers (per-scope evolution: drop-and-flag, never guess) ----

export interface MaterializeResult {
  doc: GraphDoc;
  conflicts: Array<LayerConflict & { layerId: string }>;
}

/**
 * base ⊕ layers, in the given order. An op that fails to apply is dropped
 * and flagged (never guessed); updateRoutingConfig is base-scope-only and is
 * always dropped from layers.
 */
export function materializeLayers(base: GraphDoc, layers: GraphLayer[]): MaterializeResult {
  let doc = structuredClone(base);
  const conflicts: MaterializeResult["conflicts"] = [];
  for (const layer of layers) {
    layer.ops.forEach((op, opIndex) => {
      if (op.op === "updateRoutingConfig") {
        conflicts.push({
          layerId: layer.layerId,
          opIndex,
          reason: "updateRoutingConfig is a major change allowed on base scope only",
          droppedAt: layer.version,
        });
        return;
      }
      try {
        doc = applyOp(doc, op);
      } catch (err) {
        conflicts.push({
          layerId: layer.layerId,
          opIndex,
          reason: (err as Error).message,
          droppedAt: layer.version,
        });
      }
    });
  }
  return { doc: normalizeDocument(doc), conflicts };
}

/** Cache key derivation (§7.2): undiverged users share the base cache. */
export function routeCacheKey(query: string, baseVersion: string, layerVersions: string[]): string {
  return JSON.stringify([query, baseVersion, ...layerVersions]);
}

/**
 * Rebase a layer onto a (newer) base: re-applies through the pinned
 * materializeLayers machinery, writing drop-and-flag conflicts INTO the
 * returned layer and stamping the new baseVersion. Never guesses.
 */
export function rebaseLayer(base: GraphDoc, layer: GraphLayer): GraphLayer {
  const { conflicts } = materializeLayers(base, [layer]);
  return {
    ...structuredClone(layer),
    baseVersion: base.version ?? "0",
    conflicts: conflicts.map(({ opIndex, reason, droppedAt }) => ({ opIndex, reason, droppedAt })),
  };
}

/** Convenience: base ⊕ layers, materialized and indexed in one call. */
export function loadWithLayers(
  base: GraphDoc,
  layers: GraphLayer[],
): { doc: GraphDoc; graph: Graph; conflicts: MaterializeResult["conflicts"] } {
  const { doc, conflicts } = materializeLayers(base, layers);
  return { doc, graph: new Graph(doc), conflicts };
}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ApgNode, Edge, GraphDoc } from "@apgraph/schema";
import { Graph } from "./graph.js";

export interface LoadOptions {
  /** Base path for resolving $include entries (defaults to cwd for in-memory docs). */
  basePath?: string;
  /** Internal: include-cycle detection across files. */
  _seenIncludes?: Set<string>;
}

/**
 * Normalize a raw document into canonical form:
 * - defaults materialized (type, routable, recursiveBring, bringMode,
 *   maxBringDepth, fillPolicy, visitPolicy, isFallback, profile)
 * - string prompts desugared to { slots: { task } }
 * - $include documents grafted (their roots must name a mount node here)
 * - inline relations (bring / choice / fallback / child) materialized into
 *   edges[] alongside authored seeAlso/aliasOf edges
 * - nodes re-serialized in DFS order (parent first, authored sibling order)
 */
export function normalizeDocument(raw: GraphDoc, opts: LoadOptions = {}): GraphDoc {
  const doc: GraphDoc = structuredClone(raw);

  // resolve $include before normalization so grafted nodes normalize too
  if (doc.$include && doc.$include.length > 0) {
    const base = opts.basePath ?? process.cwd();
    const seen = opts._seenIncludes ?? new Set<string>();
    for (const rel of doc.$include) {
      const abs = resolve(base, rel);
      if (seen.has(abs)) throw new Error(`$include cycle detected at: ${abs}`);
      seen.add(abs);
      const child = JSON.parse(readFileSync(abs, "utf8")) as GraphDoc;
      const childNorm = normalizeDocument(child, { basePath: dirname(abs), _seenIncludes: seen });
      for (const node of childNorm.nodes) {
        if (node.parentId === null) {
          throw new Error(`$include document ${rel} has a parentId:null root; included roots must name a mount node`);
        }
        if (doc.nodes.some((n) => n.id === node.id)) {
          throw new Error(`$include document ${rel} collides on node id: ${node.id}`);
        }
        doc.nodes.push(node);
      }
    }
  }
  delete doc.$include;

  doc.profile = doc.profile ?? "L0";
  doc.version = doc.version ?? "0";
  doc.nodes = doc.nodes.map(normalizeNode);

  // DFS re-serialization + edge materialization need indexes; build once.
  // Orphaned nodes (dangling parentId) are preserved after the DFS block, in
  // authored order, so the validator can flag them instead of losing them.
  const graph = new Graph(doc);
  const ordered = graph.dfs();
  const seen = new Set(ordered.map((n) => n.id));
  doc.nodes = [...ordered, ...doc.nodes.filter((n) => !seen.has(n.id))];
  doc.edges = materializeEdges(doc);
  return doc;
}

export function normalizeNode(n: ApgNode): ApgNode {
  const node: ApgNode = { ...n };
  node.type = node.type ?? "category";
  node.routable = node.routable ?? true;
  if (typeof node.prompt === "string") node.prompt = { slots: { task: node.prompt } };
  if (node.bring !== undefined || node.recursiveBring !== undefined || node.maxBringDepth !== undefined) {
    node.recursiveBring = node.recursiveBring ?? false;
    node.bringMode = node.bringMode ?? "contextOnly";
    node.maxBringDepth = node.maxBringDepth ?? 3;
  }
  if (node.collect !== undefined || node.decision !== undefined) {
    node.fillPolicy = node.fillPolicy ?? "opportunistic";
  }
  node.visitPolicy = node.visitPolicy ?? "repeatable";
  node.isFallback = node.isFallback ?? false;
  return node;
}

/** Inline relations → edges[], preserving authored seeAlso/aliasOf edges. */
export function materializeEdges(doc: GraphDoc): Edge[] {
  const edges: Edge[] = [];
  for (const node of doc.nodes) {
    if (node.parentId !== null) edges.push({ from: node.parentId, to: node.id, kind: "child" });
  }
  for (const node of doc.nodes) {
    for (const b of node.bring ?? []) edges.push({ from: node.id, to: b, kind: "bring" });
    for (const c of node.decision?.choices ?? []) edges.push({ from: node.id, to: c.next, kind: "choice" });
    if (node.fallbackNodeId) edges.push({ from: node.id, to: node.fallbackNodeId, kind: "fallback" });
  }
  for (const e of doc.edges ?? []) {
    if (e.kind === "seeAlso" || e.kind === "aliasOf") edges.push(e);
  }
  return edges;
}

/** Load and materialize a graph from a document or a *.apg.json path. */
export function loadGraph(source: GraphDoc | string, opts: LoadOptions = {}): Graph {
  if (typeof source === "string") {
    const raw = JSON.parse(readFileSync(source, "utf8")) as GraphDoc;
    return new Graph(normalizeDocument(raw, { ...opts, basePath: opts.basePath ?? dirname(resolve(source)) }));
  }
  return new Graph(normalizeDocument(source, opts));
}

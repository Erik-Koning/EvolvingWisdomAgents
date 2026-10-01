import type {
  ApgNode,
  Edge,
  GraphDoc,
  GraphDefaults,
  NodeId,
  PromptTemplate,
  RoutingDefaults,
} from "@apgraph/schema";

export const ROUTING_DEFAULTS: Required<RoutingDefaults> = {
  minConfidence: 0.55,
  allowMulti: true,
  shortlistK: 12,
  descriptor: ["title", "description"],
  embedText: ["title", "description", "aliases"],
  embedBypass: null, // fast path is opt-in per graph
};

export const BUDGET_DEFAULT_MAX_TOKENS = 6000;

/** Reserved structural keys that may not appear inside props. */
export const RESERVED_KEYS = new Set([
  "id",
  "slug",
  "parentId",
  "type",
  "title",
  "description",
  "aliases",
  "props",
  "routingOverride",
  "routable",
  "pinned",
  "prompt",
  "composition",
  "fewShot",
  "outputSchema",
  "bring",
  "recursiveBring",
  "bringMode",
  "maxBringDepth",
  "decision",
  "action",
  "escalation",
  "collect",
  "fillPolicy",
  "entryCondition",
  "exitCondition",
  "visitPolicy",
  "skipCondition",
  "fallbackNodeId",
  "isFallback",
  "toolAllowlist",
  "modelOverride",
  "embedding",
  "metadata",
]);

/**
 * Materialized graph: canonical doc + indexes. Nodes in the canonical doc are
 * serialized in DFS order (parent before children, siblings in authored
 * order); sibling order is order of appearance.
 */
export class Graph {
  readonly doc: GraphDoc;
  readonly byId = new Map<NodeId, ApgNode>();
  readonly childrenOf = new Map<NodeId, NodeId[]>();
  readonly rootId: NodeId;

  constructor(doc: GraphDoc) {
    this.doc = doc;
    let root: NodeId | null = null;
    for (const node of doc.nodes) {
      this.byId.set(node.id, node);
      if (!this.childrenOf.has(node.id)) this.childrenOf.set(node.id, []);
    }
    for (const node of doc.nodes) {
      if (node.parentId === null) {
        root = node.id;
      } else if (this.byId.has(node.parentId)) {
        this.childrenOf.get(node.parentId)!.push(node.id);
      }
    }
    if (root === null) throw new Error("Graph has no root node (parentId: null)");
    this.rootId = root;
  }

  get(id: NodeId): ApgNode {
    const n = this.byId.get(id);
    if (!n) throw new Error(`Unknown node id: ${id}`);
    return n;
  }

  has(id: NodeId): boolean {
    return this.byId.has(id);
  }

  children(id: NodeId): ApgNode[] {
    return (this.childrenOf.get(id) ?? []).map((c) => this.get(c));
  }

  /** root → … → id, inclusive. */
  pathTo(id: NodeId): ApgNode[] {
    const path: ApgNode[] = [];
    let cur: ApgNode | undefined = this.get(id);
    const seen = new Set<NodeId>();
    while (cur) {
      if (seen.has(cur.id)) throw new Error(`Parent cycle at node: ${cur.id}`);
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentId === null ? undefined : this.byId.get(cur.parentId);
    }
    return path.reverse();
  }

  depth(id: NodeId): number {
    return this.pathTo(id).length - 1;
  }

  /** DFS order over the whole tree: parent first, siblings in authored order. */
  dfs(): ApgNode[] {
    const out: ApgNode[] = [];
    const walk = (id: NodeId) => {
      out.push(this.get(id));
      for (const c of this.childrenOf.get(id) ?? []) walk(c);
    };
    walk(this.rootId);
    return out;
  }

  /** Index of a node among its siblings (authored order). */
  siblingIndex(id: NodeId): number {
    const node = this.get(id);
    if (node.parentId === null) return 0;
    return (this.childrenOf.get(node.parentId) ?? []).indexOf(id);
  }

  isPruned(id: NodeId): boolean {
    return this.get(id).metadata?.status === "pruned";
  }

  routing(): Required<RoutingDefaults> {
    const r = this.doc.defaults?.routing ?? {};
    return {
      minConfidence: r.minConfidence ?? ROUTING_DEFAULTS.minConfidence,
      allowMulti: r.allowMulti ?? ROUTING_DEFAULTS.allowMulti,
      shortlistK: r.shortlistK ?? ROUTING_DEFAULTS.shortlistK,
      descriptor: r.descriptor ?? ROUTING_DEFAULTS.descriptor,
      embedText: r.embedText ?? ROUTING_DEFAULTS.embedText,
      embedBypass: r.embedBypass ?? ROUTING_DEFAULTS.embedBypass,
    };
  }

  maxPromptTokens(): number {
    return this.doc.defaults?.budget?.maxPromptTokens ?? BUDGET_DEFAULT_MAX_TOKENS;
  }

  /**
   * Effective routing descriptor for a node: nearest ancestor (including
   * self) with routingOverride.descriptor wins; else the graph descriptor.
   */
  descriptorFor(id: NodeId): string[] {
    const path = this.pathTo(id);
    for (let i = path.length - 1; i >= 0; i--) {
      const ov = path[i]!.routingOverride?.descriptor;
      if (ov && ov.length > 0) return ov;
    }
    return this.routing().descriptor;
  }

  embedTextFieldsFor(id: NodeId): string[] {
    const path = this.pathTo(id);
    for (let i = path.length - 1; i >= 0; i--) {
      const ov = path[i]!.routingOverride?.embedText;
      if (ov && ov.length > 0) return ov;
    }
    return this.routing().embedText;
  }

  /**
   * Total tie-break order over nodes (after confidence): deeper node first,
   * then sibling order along the path, then lexicographic id. Returns a
   * comparator key; smaller sorts first.
   */
  compareNodes(a: NodeId, b: NodeId): number {
    const da = this.depth(a);
    const db = this.depth(b);
    if (da !== db) return db - da; // deeper wins
    const pa = this.pathTo(a);
    const pb = this.pathTo(b);
    for (let i = 1; i < pa.length; i++) {
      const ia = this.siblingIndex(pa[i]!.id);
      const ib = this.siblingIndex(pb[i]!.id);
      if (ia !== ib) return ia - ib;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

// ---- field access ----

/**
 * Resolve a descriptor/embedText field path on a node. Reserved keys are read
 * directly; "props.x.y" walks the props bag. Arrays of strings join with
 * ", "; non-string scalars stringify; null/undefined/empty → "".
 */
export function nodeField(node: ApgNode, field: string): string {
  let value: unknown;
  if (field.startsWith("props.")) {
    let cur: unknown = node.props ?? {};
    for (const part of field.slice("props.".length).split(".")) {
      if (cur !== null && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        cur = undefined;
        break;
      }
    }
    value = cur;
  } else {
    value = (node as unknown as Record<string, unknown>)[field];
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function promptTemplate(node: ApgNode): PromptTemplate | undefined {
  if (node.prompt === undefined) return undefined;
  if (typeof node.prompt === "string") return { slots: { task: node.prompt } };
  return node.prompt;
}

export function graphDefaults(doc: GraphDoc): GraphDefaults {
  return doc.defaults ?? {};
}

export type { Edge };

import type { ApgNode, GraphDoc, NodeId, Profile, ValidationError, ValidationReport } from "@apgraph/schema";
import { parseExpr } from "./expr.js";
import { RESERVED_KEYS, ROUTING_DEFAULTS, nodeField } from "./graph.js";

const PROFILE_ORDER: Profile[] = ["L0", "L1", "L2", "L3", "L4", "L5"];
const DESCRIPTOR_RESERVED = new Set(["title", "description", "aliases", "slug"]);
const DEPTH_LIMIT = 12;
const WIDTH_LIMIT = 50;

/**
 * Structural + semantic validation of a canonical document (§7.9). Returns
 * a report; never throws. Error codes are part of the conformance contract.
 */
export function validateGraph(doc: GraphDoc): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const err = (code: string, message: string, nodeId?: NodeId) => {
    const e: ValidationError = { code, message };
    if (nodeId !== undefined) e.nodeId = nodeId;
    errors.push(e);
  };
  const warn = (code: string, message: string, nodeId?: NodeId) => {
    const e: ValidationError = { code, message };
    if (nodeId !== undefined) e.nodeId = nodeId;
    warnings.push(e);
  };

  // ---- identity & tree backbone ----
  const byId = new Map<NodeId, ApgNode>();
  for (const node of doc.nodes) {
    if (byId.has(node.id)) err("DUPLICATE_ID", `Duplicate node id: ${node.id}`, node.id);
    byId.set(node.id, node);
  }
  const roots = doc.nodes.filter((n) => n.parentId === null);
  if (roots.length === 0) err("NO_ROOT", "Graph has no root node (parentId: null)");
  if (roots.length > 1) err("MULTIPLE_ROOTS", `Graph has ${roots.length} roots: ${roots.map((r) => r.id).join(", ")}`);
  for (const node of doc.nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      err("DANGLING_PARENT", `Node ${node.id} references unknown parent ${node.parentId}`, node.id);
    }
  }

  // parent cycles
  for (const node of doc.nodes) {
    const seen = new Set<NodeId>();
    let cur: ApgNode | undefined = node;
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) {
        err("PARENT_CYCLE", `Parent cycle through node ${node.id}`, node.id);
        break;
      }
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
  }

  // sibling slug uniqueness
  const slugKey = new Map<string, NodeId>();
  for (const node of doc.nodes) {
    if (!node.slug) continue;
    const key = `${node.parentId}::${node.slug}`;
    const prior = slugKey.get(key);
    if (prior !== undefined) {
      err("DUPLICATE_SIBLING_SLUG", `Slug "${node.slug}" duplicated among children of ${node.parentId} (${prior}, ${node.id})`, node.id);
    }
    slugKey.set(key, node.id);
  }

  // ---- reference integrity ----
  const ref = (from: NodeId, to: NodeId | undefined, what: string) => {
    if (to !== undefined && !byId.has(to)) {
      err("DANGLING_REF", `Node ${from}: ${what} references unknown node ${to}`, from);
    }
  };
  for (const node of doc.nodes) {
    for (const b of node.bring ?? []) ref(node.id, b, "bring");
    ref(node.id, node.fallbackNodeId, "fallbackNodeId");
    if (node.decision) {
      for (const c of node.decision.choices) ref(node.id, c.next, `choice "${c.value}"`);
      ref(node.id, node.decision.timeoutNext, "timeoutNext");
      for (const t of node.decision.freeform?.classifyInto ?? []) ref(node.id, t, "freeform.classifyInto");
    }
    if (node.action) {
      ref(node.id, node.action.onSuccess, "onSuccess");
      ref(node.id, node.action.onError, "onError");
    }
    ref(node.id, node.escalation?.resumeNode, "resumeNode");
  }
  for (const e of doc.edges ?? []) {
    if (e.kind === "seeAlso" || e.kind === "aliasOf") {
      if (!byId.has(e.from) || !byId.has(e.to)) {
        err("DANGLING_REF", `Edge ${e.kind} ${e.from} → ${e.to} references an unknown node`, byId.has(e.from) ? e.from : undefined);
      }
    }
  }

  // ---- discriminated blocks ----
  for (const node of doc.nodes) {
    if (node.type === "decision" && !node.decision) err("TYPE_BLOCK_MISMATCH", `Decision node ${node.id} has no decision block`, node.id);
    if (node.type !== "decision" && node.decision) err("TYPE_BLOCK_MISMATCH", `Node ${node.id} has a decision block but type ${node.type}`, node.id);
    if (node.type === "action" && !node.action) err("TYPE_BLOCK_MISMATCH", `Action node ${node.id} has no action block`, node.id);
    if (node.type !== "action" && node.action) err("TYPE_BLOCK_MISMATCH", `Node ${node.id} has an action block but type ${node.type}`, node.id);
    if (node.type === "answer" && node.prompt === undefined) {
      err("ANSWER_WITHOUT_PROMPT", `Answer node ${node.id} must carry a prompt — a terminal that says nothing is a bug`, node.id);
    }
  }

  // ---- expressions parse ----
  for (const node of doc.nodes) {
    for (const [field, src] of [
      ["entryCondition", node.entryCondition],
      ["exitCondition", node.exitCondition],
      ["skipCondition", node.skipCondition],
      ["guard", node.decision?.guard],
    ] as Array<[string, string | undefined]>) {
      if (src === undefined) continue;
      try {
        parseExpr(src);
      } catch (e) {
        err("EXPRESSION_PARSE_ERROR", `Node ${node.id}: ${field} does not parse: ${(e as Error).message}`, node.id);
      }
    }
  }

  // ---- descriptor invariants (v3.1) ----
  const graphDescriptor = doc.defaults?.routing?.descriptor ?? ROUTING_DEFAULTS.descriptor;
  const checkDescriptorFields = (fields: string[], nodeId?: NodeId) => {
    for (const f of fields) {
      if (!DESCRIPTOR_RESERVED.has(f) && !f.startsWith("props.")) {
        err("DESCRIPTOR_FIELD_INVALID", `Descriptor field "${f}" must be a reserved key or a props.* path`, nodeId);
      }
    }
  };
  checkDescriptorFields(graphDescriptor);
  checkDescriptorFields(doc.defaults?.routing?.embedText ?? []);
  for (const node of doc.nodes) {
    if (node.routingOverride?.descriptor) checkDescriptorFields(node.routingOverride.descriptor, node.id);
    if (node.routingOverride?.embedText) checkDescriptorFields(node.routingOverride.embedText, node.id);
  }

  // effective descriptor per node (nearest ancestor override incl. self)
  const effectiveDescriptor = (node: ApgNode): string[] => {
    let cur: ApgNode | undefined = node;
    const seen = new Set<NodeId>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const ov = cur.routingOverride?.descriptor;
      if (ov && ov.length > 0) return ov;
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    return graphDescriptor;
  };
  for (const node of doc.nodes) {
    if (node.routable === false || node.metadata?.status === "pruned") continue;
    const fields = effectiveDescriptor(node);
    const nonEmpty = fields.some((f) => nodeField(node, f).trim().length > 0);
    if (!nonEmpty) {
      err("DESCRIPTOR_EMPTY", `Routable node ${node.id} has no text in any effective descriptor field (${fields.join(", ")})`, node.id);
    }
  }

  // reserved keys may not appear inside props
  for (const node of doc.nodes) {
    for (const key of Object.keys(node.props ?? {})) {
      if (RESERVED_KEYS.has(key)) err("RESERVED_PROPS_KEY", `Node ${node.id}: props may not contain reserved key "${key}"`, node.id);
    }
  }

  // ---- tenant boundaries (brings may not cross) ----
  for (const node of doc.nodes) {
    const from = node.metadata?.tenantId;
    if (from === undefined) continue;
    for (const b of node.bring ?? []) {
      const to = byId.get(b)?.metadata?.tenantId;
      if (to !== undefined && to !== from) {
        err("TENANT_CROSSING_BRING", `Node ${node.id} (tenant ${from}) brings ${b} (tenant ${to})`, node.id);
      }
    }
  }

  // ---- decision flows terminate ----
  for (const node of doc.nodes) {
    if (node.type !== "decision" || !node.decision) continue;
    const reachedTerminal = flowReachesTerminal(node, byId);
    if (!reachedTerminal) {
      err("DECISION_UNTERMINATED", `Decision ${node.id} has no reachable terminal (answer, escalation, or category)`, node.id);
    }
  }

  // ---- bring cycles (runtime is seen-set safe; surface as warning) ----
  for (const node of doc.nodes) {
    if (!node.bring || node.bring.length === 0) continue;
    const stack = new Set<NodeId>();
    const visit = (id: NodeId): boolean => {
      if (stack.has(id)) return true;
      stack.add(id);
      for (const b of byId.get(id)?.bring ?? []) if (visit(b)) return true;
      stack.delete(id);
      return false;
    };
    if (visit(node.id)) {
      warn("BRING_CYCLE", `Bring cycle through node ${node.id} (runtime expansion is cycle-safe)`, node.id);
      break;
    }
  }

  // ---- limits ----
  if (roots.length === 1 && errors.every((e) => e.code !== "PARENT_CYCLE" && e.code !== "DANGLING_PARENT")) {
    const depthOf = (node: ApgNode): number => {
      let d = 0;
      let cur: ApgNode | undefined = node;
      while (cur && cur.parentId !== null) {
        cur = byId.get(cur.parentId);
        d++;
      }
      return d;
    };
    for (const node of doc.nodes) {
      if (depthOf(node) > DEPTH_LIMIT) warn("DEPTH_LIMIT", `Node ${node.id} exceeds depth ${DEPTH_LIMIT}`, node.id);
    }
    const width = new Map<NodeId | null, number>();
    for (const node of doc.nodes) width.set(node.parentId, (width.get(node.parentId) ?? 0) + 1);
    for (const [parent, count] of width) {
      if (count > WIDTH_LIMIT) warn("WIDTH_LIMIT", `Node ${parent} has ${count} children (limit ${WIDTH_LIMIT})`, parent ?? undefined);
    }
  }

  // ---- profile conformance ----
  const declared = doc.profile ?? "L0";
  const required = detectRequiredProfile(doc);
  if (PROFILE_ORDER.indexOf(required) > PROFILE_ORDER.indexOf(declared)) {
    err("PROFILE_VIOLATION", `Graph declares profile ${declared} but uses ${required} features`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function flowReachesTerminal(start: ApgNode, byId: Map<NodeId, ApgNode>): boolean {
  const queue: NodeId[] = [start.id];
  const seen = new Set<NodeId>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    const isTerminal =
      node.type === "answer" ||
      (node.escalation !== undefined && node.escalation.mode !== "none") ||
      (node.type === "category" && id !== start.id);
    if (isTerminal) return true;
    if (node.decision) {
      for (const c of node.decision.choices) queue.push(c.next);
      if (node.decision.timeoutNext) queue.push(node.decision.timeoutNext);
      for (const t of node.decision.freeform?.classifyInto ?? []) queue.push(t);
    }
    if (node.action) {
      queue.push(node.action.onSuccess, node.action.onError);
    }
  }
  return false;
}

/**
 * Lowest profile that covers the features a document uses. Detection ignores
 * canonicalized defaults (e.g. visitPolicy "repeatable" or a desugared
 * task-only prompt do not count as L1/L2 features).
 */
export function detectRequiredProfile(doc: GraphDoc): Profile {
  let required = 0;
  const need = (level: number) => {
    if (level > required) required = level;
  };

  if ((doc.variables ?? []).length > 0) need(1);
  const routing = doc.defaults?.routing;
  if (routing?.descriptor || routing?.embedText) need(1);

  for (const node of doc.nodes) {
    if (typeof node.prompt === "object" && node.prompt !== null) {
      const slots = Object.keys(node.prompt.slots);
      if (slots.some((s) => s !== "task") || node.prompt.variables || node.prompt.format) need(1);
      if (slots.includes("queryRewrite")) need(1);
    }
    if ((node.bring ?? []).length > 0) need(1);
    if (node.routable === false) need(1);
    if (node.props && Object.keys(node.props).length > 0) need(1);
    if (node.routingOverride) need(1);

    if (node.collect) need(2);
    if (node.entryCondition || node.exitCondition || node.skipCondition) need(2);
    if (node.decision?.guard) need(2);
    if (node.visitPolicy && node.visitPolicy !== "repeatable") need(2);
    if (node.outputSchema) need(2);

    if (node.type === "decision" || node.type === "action" || node.type === "answer") need(3);
    if (node.toolAllowlist) need(3);
    if (node.fallbackNodeId || node.isFallback === true) need(3);

    if (node.escalation) need(4);
  }
  return PROFILE_ORDER[required]!;
}

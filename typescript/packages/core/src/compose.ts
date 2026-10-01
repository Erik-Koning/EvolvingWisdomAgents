import type {
  ApgNode,
  ComposedPrompt,
  JsonSchemaFragment,
  MergeMode,
  ModelHints,
  NodeId,
  Slot,
  UserOverlay,
} from "@apgraph/schema";
import { CONTEXT_ONLY_SLOTS } from "@apgraph/schema";
import { Graph, promptTemplate } from "./graph.js";
import { resolveBring } from "./bring.js";
import { countTokensFallback } from "./connectors.js";

const TEXT_SLOTS: Slot[] = ["persona", "task", "constraints", "knowledge", "examples", "outputFormat"];

// Pinned truncation priorities (§7.1). Higher = kept longer. Path constraints
// are never dropped.
const PRIORITY_LEAF_CORE = 900;
const PRIORITY_PATH = 800;
const PRIORITY_BRING = 700;
const PRIORITY_BRING_DEPTH_STEP = 50;
const PRIORITY_EXAMPLES = 400;
const PRIORITY_OVERLAY = 100;

interface Fragment {
  nodeId: NodeId;
  slot: Slot;
  text: string;
  priority: number;
  droppable: boolean;
  seq: number;
}

export interface ComposeOptions {
  query?: string;
  /** Call-site variable overrides (highest precedence). */
  vars?: Record<string, unknown>;
  sessionVars?: Record<string, unknown>;
  memoryVars?: Record<string, unknown>;
  tenantVars?: Record<string, unknown>;
  overlays?: UserOverlay[];
  maxPromptTokens?: number;
  countTokens?: (text: string) => number;
}

/**
 * Deterministic three-stage composition (§7.4): path (the author's intent) →
 * brings + secondary matches (the graph's shared knowledge, contextOnly) →
 * user overlays (this user's history), then priority-based token budgeting.
 */
export function compose(graph: Graph, targetIds: NodeId[], opts: ComposeOptions = {}): ComposedPrompt {
  if (targetIds.length === 0) throw new Error("compose requires at least one target node");
  const primary = targetIds[0]!;
  if (graph.isPruned(primary)) throw new Error(`Node "${primary}" is pruned`);
  const path = graph.pathTo(primary);
  const pathIds = new Set(path.map((n) => n.id));

  // variable defaults are scoped to the nodes that can contribute fragments:
  // the primary path plus imports (secondary matches and brings) — a default
  // declared on an unrelated subtree must not leak into this composition
  const scopeIds = new Set<NodeId>(pathIds);
  for (const t of targetIds.slice(1)) if (graph.has(t)) scopeIds.add(t);
  for (const t of targetIds) {
    if (!graph.has(t)) continue;
    for (const b of resolveBring(graph, t).brought) scopeIds.add(b);
  }
  const vars = mergeVars(graph, opts, scopeIds);
  const unresolved: Array<{ nodeId: NodeId; variable: string }> = [];
  let seq = 0;

  const perSlot = new Map<Slot, Fragment[]>();
  for (const s of TEXT_SLOTS) perSlot.set(s, []);

  const addFragment = (slot: Slot, frag: Fragment, mode: MergeMode) => {
    const list = perSlot.get(slot)!;
    if (mode === "override") list.length = 0;
    if (mode === "merge" && list.some((f) => f.text === frag.text)) return;
    if (mode === "prepend") list.unshift(frag);
    else list.push(frag);
  };

  const render = (node: ApgNode, raw: string): string =>
    interpolate(raw, node, vars, opts.query, unresolved, requiredVarNames(graph, node));

  // ---- stage 1: path ----
  let rewrittenQuery: string | undefined;
  for (const node of path) {
    const template = promptTemplate(node);
    const isLeaf = node.id === primary;
    if (template) {
      for (const slot of TEXT_SLOTS) {
        const raw = template.slots[slot];
        if (raw === undefined || raw === "") continue;
        const text = render(node, raw);
        const priority = pathPriority(node, slot, isLeaf);
        addFragment(slot, {
          nodeId: node.id,
          slot,
          text,
          priority,
          droppable: slot !== "constraints",
          seq: seq++,
        }, slotMode(graph, node, slot));
      }
      const rewrite = template.slots["queryRewrite"];
      if (rewrite !== undefined && rewrite !== "") {
        rewrittenQuery = render(node, rewrite); // deepest wins (override)
      }
    }
    for (const ex of node.fewShot ?? []) {
      addFragment("examples", {
        nodeId: node.id,
        slot: "examples",
        text: `Input: ${ex.input}\nOutput: ${ex.output}`,
        priority: node.composition?.priority ?? PRIORITY_EXAMPLES,
        droppable: true,
        seq: seq++,
      }, "append");
    }
  }

  // ---- stage 2: secondary matches + brings (always append, contextOnly unless bringMode full) ----
  const contributed = new Set<NodeId>(pathIds);
  const broughtNodes: NodeId[] = [];

  const contributeImport = (node: ApgNode, slots: readonly Slot[], priority: number) => {
    const template = promptTemplate(node);
    if (template) {
      for (const slot of slots) {
        const raw = template.slots[slot];
        if (raw === undefined || raw === "") continue;
        addFragment(slot, {
          nodeId: node.id,
          slot,
          text: render(node, raw),
          priority: node.composition?.priority ?? (slot === "examples" ? PRIORITY_EXAMPLES : priority),
          droppable: true,
          seq: seq++,
        }, "append");
      }
    }
    if (slots.includes("examples")) {
      for (const ex of node.fewShot ?? []) {
        addFragment("examples", {
          nodeId: node.id,
          slot: "examples",
          text: `Input: ${ex.input}\nOutput: ${ex.output}`,
          priority: node.composition?.priority ?? PRIORITY_EXAMPLES,
          droppable: true,
          seq: seq++,
        }, "append");
      }
    }
  };

  for (const targetId of targetIds.slice(1)) {
    if (contributed.has(targetId) || !graph.has(targetId)) continue;
    contributed.add(targetId);
    broughtNodes.push(targetId);
    contributeImport(graph.get(targetId), CONTEXT_ONLY_SLOTS, PRIORITY_BRING);
  }

  for (const targetId of targetIds) {
    if (!graph.has(targetId)) continue;
    const landing = graph.get(targetId);
    const importSlots: readonly Slot[] =
      landing.bringMode === "full" ? TEXT_SLOTS : CONTEXT_ONLY_SLOTS;
    const resolution = resolveBring(graph, targetId);
    for (const id of resolution.brought) {
      if (contributed.has(id)) continue;
      contributed.add(id);
      broughtNodes.push(id);
      const depth = resolution.depths[id] ?? 1;
      contributeImport(graph.get(id), importSlots, PRIORITY_BRING - PRIORITY_BRING_DEPTH_STEP * (depth - 1));
    }
  }

  // ---- stage 3: user overlays (contextOnly by construction, ancestors first) ----
  const overlays = (opts.overlays ?? [])
    .filter((o) => pathIds.has(o.nodeId))
    .sort((a, b) => pathIndex(path, a.nodeId) - pathIndex(path, b.nodeId));
  for (const overlay of overlays) {
    for (const slot of CONTEXT_ONLY_SLOTS) {
      const text = overlay.digest[slot as "constraints" | "knowledge" | "examples"];
      if (text === undefined || text === "") continue;
      addFragment(slot, {
        nodeId: overlay.nodeId,
        slot,
        text,
        priority: PRIORITY_OVERLAY,
        droppable: true,
        seq: seq++,
      }, "append");
    }
  }

  // ---- budgeting ----
  const countTokens = opts.countTokens ?? countTokensFallback;
  const maxTokens = opts.maxPromptTokens ?? graph.maxPromptTokens();
  const truncated: Array<{ nodeId: NodeId; slot: Slot }> = [];
  const all = () => TEXT_SLOTS.flatMap((s) => perSlot.get(s)!);
  let total = all().reduce((acc, f) => acc + countTokens(f.text), 0);
  while (total > maxTokens) {
    const candidates = all().filter((f) => f.droppable);
    if (candidates.length === 0) break;
    let victim = candidates[0]!;
    for (const f of candidates) {
      if (f.priority < victim.priority || (f.priority === victim.priority && f.seq > victim.seq)) {
        victim = f;
      }
    }
    const list = perSlot.get(victim.slot)!;
    list.splice(list.indexOf(victim), 1);
    truncated.push({ nodeId: victim.nodeId, slot: victim.slot });
    total -= countTokens(victim.text);
  }

  // ---- assembly ----
  const slots: Partial<Record<Slot, string>> = {};
  const sections: string[] = [];
  for (const slot of TEXT_SLOTS) {
    const texts = perSlot.get(slot)!.map((f) => f.text);
    if (texts.length === 0) continue;
    const joined = texts.join("\n\n");
    slots[slot] = joined;
    sections.push(joined);
  }

  // contributors: nodes with ≥1 SURVIVING fragment, first-contribution order
  // (ascending seq) — the usage-telemetry contract (§5)
  const surviving = all().sort((a, b) => a.seq - b.seq);
  const contributors: NodeId[] = [];
  for (const frag of surviving) {
    if (!contributors.includes(frag.nodeId)) contributors.push(frag.nodeId);
  }

  const result: ComposedPrompt = {
    slots,
    text: sections.join("\n\n"),
    contributors,
    truncated,
    unresolved,
  };
  if (rewrittenQuery !== undefined) result.rewrittenQuery = rewrittenQuery;

  const outputSchema = leafOutputSchema(path);
  if (outputSchema) result.outputSchema = outputSchema;
  const modelHints = mergeModelHints(graph, path);
  if (modelHints) result.modelHints = modelHints;
  const allowlist = effectiveToolAllowlist(path);
  if (allowlist) result.toolAllowlist = allowlist;
  return result;
}

function pathPriority(node: ApgNode, slot: Slot, isLeaf: boolean): number {
  if (node.composition?.priority !== undefined) return node.composition.priority;
  if (slot === "constraints") return 1000; // never dropped anyway
  if (slot === "examples") return PRIORITY_EXAMPLES;
  if (isLeaf && (slot === "persona" || slot === "task")) return PRIORITY_LEAF_CORE;
  return PRIORITY_PATH;
}

function slotMode(graph: Graph, node: ApgNode, slot: Slot): MergeMode {
  return (
    node.composition?.mode?.[slot] ??
    node.composition?.defaultMode ??
    graph.doc.defaults?.composition?.mode?.[slot] ??
    graph.doc.defaults?.composition?.defaultMode ??
    "append"
  );
}

function pathIndex(path: ApgNode[], id: NodeId): number {
  return path.findIndex((n) => n.id === id);
}

function leafOutputSchema(path: ApgNode[]): JsonSchemaFragment | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.outputSchema) return path[i]!.outputSchema;
  }
  return undefined;
}

function mergeModelHints(graph: Graph, path: ApgNode[]): ModelHints | undefined {
  const merged: ModelHints = { ...(graph.doc.defaults?.model ?? {}) };
  for (const node of path) Object.assign(merged, node.modelOverride ?? {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function effectiveToolAllowlist(path: ApgNode[]): string[] | undefined {
  let allow: string[] | undefined;
  for (const node of path) {
    if (!node.toolAllowlist) continue;
    allow = allow === undefined ? [...node.toolAllowlist] : allow.filter((t) => node.toolAllowlist!.includes(t));
  }
  return allow;
}

// ---- variables ----

/**
 * Precedence (low → high): graph defaults → tenant → memory → session →
 * call-site. Template-level defaults apply only for nodes in scopeIds (the
 * composition's path + imports); omit scopeIds to collect from all nodes.
 */
export function mergeVars(
  graph: Graph,
  opts: ComposeOptions,
  scopeIds?: Set<NodeId>,
): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const spec of graph.doc.variables ?? []) {
    if (spec.default !== undefined) bag[spec.name] = spec.default;
  }
  for (const node of graph.dfs()) {
    if (scopeIds !== undefined && !scopeIds.has(node.id)) continue;
    const template = promptTemplate(node);
    for (const spec of template?.variables ?? []) {
      if (spec.default !== undefined && !(spec.name in bag)) bag[spec.name] = spec.default;
    }
  }
  Object.assign(bag, opts.tenantVars ?? {}, opts.memoryVars ?? {}, opts.sessionVars ?? {}, opts.vars ?? {});
  return bag;
}

function requiredVarNames(graph: Graph, node: ApgNode): Set<string> {
  const required = new Set<string>();
  for (const spec of graph.doc.variables ?? []) if (spec.required) required.add(spec.name);
  const template = promptTemplate(node);
  for (const spec of template?.variables ?? []) if (spec.required) required.add(spec.name);
  return required;
}

const MUSTACHE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const FSTRING_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

function interpolate(
  raw: string,
  node: ApgNode,
  vars: Record<string, unknown>,
  query: string | undefined,
  unresolved: Array<{ nodeId: NodeId; variable: string }>,
  required: Set<string>,
): string {
  const template = promptTemplate(node);
  const re = template?.format === "f-string" ? FSTRING_RE : MUSTACHE_RE;
  return raw.replace(re, (_m, name: string) => {
    if (name === "query") return query ?? "";
    let value: unknown;
    if (name.startsWith("props.")) {
      value = resolveDotted(node.props ?? {}, name.slice("props.".length));
    } else {
      value = resolveDotted(vars, name);
    }
    if (value === undefined || value === null) {
      if (required.has(name)) {
        throw new Error(`Missing required variable "${name}" at node "${node.id}"`);
      }
      unresolved.push({ nodeId: node.id, variable: name });
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function resolveDotted(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split(".")) {
    if (cur !== null && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

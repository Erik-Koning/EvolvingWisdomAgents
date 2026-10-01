// Pure op-builders and graph readers shared by every engine pass. Lifted from
// the wisdom-chat reference app; no LLM, no I/O, no clock.
import { Graph, promptTemplate, type GraphDoc, type MutationOp, type Slot } from "@apgraph/core";

/** Charter text from a set of root slots (persona/task/constraints, non-empty). */
export function charterFromSlots(slots: Partial<Record<Slot, string>>): string {
  return (["persona", "task", "constraints"] as const)
    .map((s) => slots[s])
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
}

/** The root's own identity text (its slots only — brings excluded). */
export function charterText(graph: Graph, rootId: string): string {
  return charterFromSlots(promptTemplate(graph.get(rootId))?.slots ?? {});
}

export function charterHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** The graph's root node (parentId null). */
export function rootId(graph: Graph): string {
  const root = graph.dfs().find((n) => n.parentId === null);
  if (!root) throw new Error("graph has no root node");
  return root.id;
}

/** Routable categories = the learnable vocabulary (root and knowledge nodes are non-routable). */
export function categories(graph: Graph): string[] {
  return graph
    .dfs()
    .filter((n) => n.routable !== false && n.parentId !== null)
    .map((n) => n.id);
}

/** The slot a category's learnings are stored in (props.storeAs, else the caller's default). */
export function storeSlot(graph: Graph, categoryId: string, fallback: Slot = "knowledge"): Slot {
  const declared = graph.get(categoryId).props?.["storeAs"];
  return declared === "constraints" || declared === "examples" || declared === "knowledge"
    ? declared
    : fallback;
}

export function learnedText(graph: Graph, id: string): string {
  const slots = promptTemplate(graph.get(id))?.slots ?? {};
  return slots.knowledge ?? slots.constraints ?? slots.examples ?? "";
}

/** Existing learnings, id-tagged so the LLM can dedupe/update/cross-link. */
export function existingLearnings(graph: Graph, scope?: string[]): string {
  const lines: string[] = [];
  for (const categoryId of scope ?? categories(graph)) {
    if (!graph.has(categoryId)) continue;
    for (const brought of graph.get(categoryId).bring ?? []) {
      const line = learningLine(graph, brought, categoryId);
      if (line) lines.push(line);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(nothing learned yet)";
}

/** Cap listing lines so large node prompts never bloat an identification call. */
const LISTING_TEXT_CAP = 160;

export function learningLine(graph: Graph, nodeId: string, categoryId: string): string | null {
  if (!graph.has(nodeId)) return null;
  const text = learnedText(graph, nodeId);
  if (!text) return null;
  const node = graph.get(nodeId);
  const label = typeof node.props?.["label"] === "string" ? (node.props["label"] as string) : undefined;
  // long nodes show their authored summary label; blind truncation is only
  // the fallback for unlabeled legacy nodes
  const shown =
    text.length <= LISTING_TEXT_CAP
      ? text
      : label
        ? `${label} — ${text.slice(0, LISTING_TEXT_CAP)}… [truncated]`
        : `${text.slice(0, LISTING_TEXT_CAP)}… [truncated]`;
  const count = node.props?.["feedbackCount"];
  const suffix = typeof count === "number" && count > 1 ? ` (feedback ×${count})` : "";
  return `- [${nodeId}] (${categoryId}) ${shown}${suffix}`;
}

export function uniqueId(anchorId: string, known: Set<string>): string {
  let n = 1;
  while (known.has(`kn-${anchorId}-${n}`)) n++;
  return `kn-${anchorId}-${n}`;
}

/** Build the ops that save one learning under a category (or task anchor). */
export function saveLearningOps(
  graph: Graph,
  knownIds: Set<string>,
  pendingBring: Map<string, string[]>,
  categoryId: string,
  anchorId: string,
  text: string,
  props: Record<string, unknown>,
  fallbackSlot: Slot = "knowledge"
): { ops: MutationOp[]; nodeId: string } {
  const slot = storeSlot(graph, categoryId, fallbackSlot);
  const nodeId = uniqueId(anchorId, knownIds);
  knownIds.add(nodeId);
  const ops: MutationOp[] = [
    {
      op: "addNode",
      parentId: anchorId,
      node: {
        id: nodeId,
        parentId: anchorId,
        type: "category",
        routable: false,
        prompt: { slots: { [slot]: text } },
        props,
      },
    },
  ];
  const adds = pendingBring.get(anchorId) ?? [];
  adds.push(nodeId);
  pendingBring.set(anchorId, adds);
  return { ops, nodeId };
}

/**
 * Ops that cleanly remove a SET of learning nodes in one changeset: one final
 * setBring per affected anchor (computed once, so multiple removals cannot
 * clobber each other with stale snapshots), seeAlso edge cleanup, then the
 * deletes. `remap` retargets bring references instead of dropping them
 * (absorbed → keeper during consolidation merges; the mergeNodes op deletes
 * those victims itself, so they must NOT be in removedIds).
 */
export function removalOps(
  graph: Graph,
  doc: GraphDoc,
  removedIds: Set<string>,
  remap: Map<string, string> = new Map()
): MutationOp[] {
  const ops: MutationOp[] = [];
  for (const anchor of graph.dfs()) {
    const bring = anchor.bring ?? [];
    if (!bring.some((b) => removedIds.has(b) || remap.has(b))) continue;
    const next = [...new Set(bring.map((b) => remap.get(b) ?? b))].filter((b) => !removedIds.has(b));
    ops.push({ op: "setBring", id: anchor.id, bring: next });
  }
  for (const edge of doc.edges ?? []) {
    if (edge.kind === "seeAlso" && (removedIds.has(edge.from) || removedIds.has(edge.to))) {
      ops.push({ op: "removeEdge", edge });
    }
  }
  for (const id of removedIds) {
    ops.push({ op: "deleteNode", id, orphans: "cascade" });
  }
  return ops;
}

/**
 * One setBring per touched anchor: union of existing + new (setBring replaces
 * wholesale). `exclude` drops ids being removed in the same changeset — these
 * ops must be emitted AFTER removalOps so shared anchors resolve to the
 * correct final array.
 */
export function bringOps(
  graph: Graph,
  pendingBring: Map<string, string[]>,
  exclude: Set<string> = new Set()
): MutationOp[] {
  return [...pendingBring].map(([anchorId, adds]) => ({
    op: "setBring" as const,
    id: anchorId,
    bring: [...(graph.get(anchorId).bring ?? []).filter((b) => !exclude.has(b)), ...adds],
  }));
}

/** Deterministic bag-of-words term-frequency vectors (demo-grade lexical fallback). */
export function bagOfWordsVectors(texts: string[]): number[][] {
  const tokenize = (s: string) => s.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter((t) => t.length > 2);
  const vocab: string[] = [];
  const seen = new Set<string>();
  const tokenLists = texts.map(tokenize);
  for (const tokens of tokenLists) {
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        vocab.push(t);
      }
    }
  }
  return tokenLists.map((tokens) => {
    const v = new Array<number>(vocab.length).fill(0);
    for (const t of tokens) v[vocab.indexOf(t)]! += 1;
    return v;
  });
}

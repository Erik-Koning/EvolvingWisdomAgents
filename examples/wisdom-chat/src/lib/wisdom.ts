// The learning engine: every harvest reads the un-harvested transcript slice,
// asks the LLM what it learned (vocabulary = the graph's own category nodes
// and their props.learn guidance, delivered via serializeOutline), then saves
// validated knowledge through the mutation algebra. Categories choose how
// their learnings act via props.storeAs ("knowledge" facts vs "constraints"
// behavior rules — the slot contract).
import {
  Graph,
  applyChangeset,
  findNodes,
  precomputeEmbeddings,
  promptTemplate,
  route,
  serializeOutline,
  type GraphDoc,
  type MutationOp,
  type Slot,
} from "@apgraph/core";
import type { AgentConfig } from "./agents";
import { commitOps, saveAgentDoc, type ChatSession } from "./store";
import { embeddingsConnector, llm, routingConnectors } from "./llm";

export interface HarvestResult {
  learned: Array<{ nodeId: string; fact: string; categoryId: string }>;
  updated: Array<{ nodeId: string; fact: string }>;
  version: string;
}

interface ExtractedFact {
  fact: string;
  categoryId: string;
  updateOfNodeId?: string;
  relatedNodeIds?: string[];
}

/** The root's own identity text (its slots only — brings excluded). */
export function charterText(graph: Graph, rootId: string): string {
  const slots = promptTemplate(graph.get(rootId))?.slots ?? {};
  return (["persona", "task", "constraints"] as const)
    .map((s) => slots[s])
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
}

export function charterHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
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
  const text = learnedText(graph, nodeId);
  if (!text) return null;
  const node = graph.get(nodeId);
  const label = typeof node.props?.["label"] === "string" ? (node.props["label"] as string) : undefined;
  // long nodes show their authored summary label; blind truncation is only
  // the fallback for unlabeled legacy nodes (known-concerns #2)
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

/** Build the ops that save one learning under a category (or task anchor). */
export function saveLearningOps(
  graph: Graph,
  knownIds: Set<string>,
  pendingBring: Map<string, string[]>,
  categoryId: string,
  anchorId: string,
  text: string,
  props: Record<string, unknown>,
  fallbackSlot: Slot = "knowledge",
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
 * those victims itself, so they must NOT be in removedIds). Shared by
 * feedback retires and the consolidation pass.
 */
export function removalOps(
  graph: Graph,
  doc: GraphDoc,
  removedIds: Set<string>,
  remap: Map<string, string> = new Map(),
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

export function bringOps(
  graph: Graph,
  pendingBring: Map<string, string[]>,
  exclude: Set<string> = new Set(),
): MutationOp[] {
  // one setBring per touched anchor: union of existing + new (setBring
  // replaces wholesale). `exclude` drops ids being removed in the same
  // changeset — these ops must be emitted AFTER removalOps so shared anchors
  // resolve to the correct final array.
  return [...pendingBring].map(([anchorId, adds]) => ({
    op: "setBring" as const,
    id: anchorId,
    bring: [...(graph.get(anchorId).bring ?? []).filter((b) => !exclude.has(b)), ...adds],
  }));
}

export async function harvest(
  agent: AgentConfig,
  session: ChatSession,
  doc: GraphDoc,
  graph: Graph,
): Promise<HarvestResult | null> {
  const slice = session.messages.slice(session.lastHarvestIndex);
  if (!slice.some((m) => m.role === "user")) return null;

  const categoryIds = categories(graph);
  // dedup listing scoped to the categories this slice actually routed to
  const routedScope = [...new Set(slice.flatMap((m) => (m.routedTo ?? []).map((r) => r.nodeId)))];
  const transcript = slice
    .map((m) => {
      const tools = m.toolCalls?.length ? ` [tools used: ${m.toolCalls.map((t) => t.tool).join(", ")}]` : "";
      return `${m.role}: ${m.content}${tools}`;
    })
    .join("\n");

  const schema = {
    type: "object",
    required: ["facts"],
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          required: ["fact", "categoryId"],
          properties: {
            fact: { type: "string", description: "One durable fact about the user, stated in third person." },
            categoryId: { type: "string", enum: categoryIds },
            updateOfNodeId: {
              type: "string",
              description: "If this refines an existing [id] fact, that node id — otherwise omit.",
            },
            relatedNodeIds: {
              type: "array",
              items: { type: "string" },
              description: "Existing [id] facts this one meaningfully relates to.",
            },
          },
        },
      },
    },
  };

  const text = [
    "Read this chat transcript and report durable facts learned about the user.",
    "Each category line below shows what that category wants learned — only report facts that fit a category's guidance, and only facts worth remembering across conversations (no small talk, no assistant behavior).",
    "",
    "Categories:",
    serializeOutline(graph),
    "",
    "Already known (do not re-report; use updateOfNodeId to refine, relatedNodeIds to cross-link):",
    existingLearnings(graph, routedScope.length > 0 ? routedScope : undefined),
    "",
    "Transcript:",
    transcript,
  ].join("\n");

  const extracted = (await llm.extract({ text, schema })) as { facts?: ExtractedFact[] };
  const facts = (extracted.facts ?? []).filter((f) => f.fact && f.fact.trim().length > 0);
  if (facts.length === 0) return null;

  const ops: MutationOp[] = [];
  const learned: HarvestResult["learned"] = [];
  const updated: HarvestResult["updated"] = [];
  const pendingBring = new Map<string, string[]>();
  const knownIds = new Set(graph.dfs().map((n) => n.id));

  for (const fact of facts) {
    // refine an existing fact in place
    if (fact.updateOfNodeId && knownIds.has(fact.updateOfNodeId)) {
      const slot = Object.keys(promptTemplate(graph.get(fact.updateOfNodeId))?.slots ?? { knowledge: 1 })[0]!;
      ops.push({
        op: "updateNode",
        id: fact.updateOfNodeId,
        patch: {
          prompt: { slots: { [slot]: fact.fact } },
          props: { updatedAt: new Date().toISOString() },
        },
      });
      updated.push({ nodeId: fact.updateOfNodeId, fact: fact.fact });
      continue;
    }

    // find the branch point: trust the LLM's category, else route the fact text
    let categoryId = categoryIds.includes(fact.categoryId) ? fact.categoryId : undefined;
    if (!categoryId) {
      const routing = await route(fact.fact, graph, { connectors: routingConnectors() });
      categoryId = routing.matches[0]?.nodeId;
    }
    if (!categoryId || !knownIds.has(categoryId)) continue;

    // skip near-duplicates the extractor missed
    const dupe = findNodes(graph, fact.fact.toLowerCase().slice(0, 40), { field: "prompt", subtreeId: categoryId });
    if (dupe.length > 0) continue;

    const { ops: saveOps, nodeId } = saveLearningOps(graph, knownIds, pendingBring, categoryId, categoryId, fact.fact, {
      source: "chat",
      sessionId: session.id,
      learnedAt: new Date().toISOString(),
    });
    ops.push(...saveOps);
    learned.push({ nodeId, fact: fact.fact, categoryId });

    for (const related of fact.relatedNodeIds ?? []) {
      if (knownIds.has(related) && related !== nodeId) {
        ops.push({ op: "setEdge", edge: { from: nodeId, to: related, kind: "seeAlso" } });
      }
    }
  }

  ops.push(...bringOps(graph, pendingBring));
  if (ops.length === 0) return null;

  // user-writes-win commit: retries once against a fresh doc on conflict
  let next = await commitOps(agent, doc.version, ops, {
    actor: "harvest",
    summary: `harvest: +${learned.length} learned, ~${updated.length} updated (session ${session.id})`,
    retry: true,
  });
  // write-path embeddings: best-effort follow-up save; a conflict here just
  // means someone else wrote first — vectors get filled on the next harvest
  const embeddings = embeddingsConnector();
  if (embeddings) {
    const vectored = await precomputeEmbeddings(next, embeddings);
    if (vectored !== next) {
      try {
        await saveAgentDoc(agent, vectored, {
          actor: "harvest",
          summary: "precomputed embeddings",
          expectedVersion: next.version,
        });
        next = vectored;
      } catch {
        /* user won the race; skip */
      }
    }
  }
  return { learned, updated, version: next.version ?? "0" };
}

export function uniqueId(anchorId: string, known: Set<string>): string {
  let n = 1;
  while (known.has(`kn-${anchorId}-${n}`)) n++;
  return `kn-${anchorId}-${n}`;
}

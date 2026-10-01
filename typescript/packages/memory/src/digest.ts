// The wake path, generalized: harvest distills the un-harvested tail of a
// transcript into learnings; feedback digestion turns one comment into
// add/refine/retire adjustments in a single atomic changeset. Both commit
// with user-write semantics (retry once against fresh — the opposite of
// maintenance passes, which abort). Tool-allowlist edits are app policy and
// stay out of the library.
import {
  Graph,
  findNodes,
  promptTemplate,
  route,
  serializeOutline,
  type GraphDoc,
  type MutationOp,
} from "@apgraph/core";
import { type MemoryDeps } from "./deps.js";
import {
  bringOps,
  categories,
  existingLearnings,
  learnedText,
  removalOps,
  saveLearningOps,
} from "./ops.js";
import { commitOps, nowIso } from "./state.js";
import { proposeFromEdict, type ProposalOutcome } from "./transcend.js";

export interface HarvestResult {
  learned: Array<{ nodeId: string; fact: string; categoryId: string }>;
  updated: Array<{ nodeId: string; fact: string }>;
  version: string | null;
}

interface ExtractedFact {
  fact: string;
  categoryId: string;
  updateOfNodeId?: string;
  relatedNodeIds?: string[];
}

/**
 * Distill the un-harvested tail of a transcript into graph learnings and
 * advance its harvestedUpTo watermark. Returns null when the tail holds no
 * user turn or nothing durable was found.
 */
export async function harvestTurns(deps: MemoryDeps, transcriptId: string): Promise<HarvestResult | null> {
  const transcript = await deps.transcripts.get(transcriptId);
  if (!transcript) throw new Error(`Unknown transcript: ${transcriptId}`);
  const start = transcript.harvestedUpTo ?? 0;
  const slice = transcript.turns.slice(start);
  if (!slice.some((m) => m.role === "user")) return null;

  const doc = await deps.store.load(deps.graphId);
  const graph = new Graph(doc);
  const categoryIds = categories(graph);
  const transcriptText = slice.map((m) => `${m.role}: ${m.content}`).join("\n");

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
    existingLearnings(graph),
    "",
    "Transcript:",
    transcriptText,
  ].join("\n");

  if (!deps.llm.extract) throw new Error("harvestTurns requires an LlmConnector with extract()");
  const extracted = (await deps.llm.extract({ text, schema })) as { facts?: ExtractedFact[] };
  const facts = (extracted.facts ?? []).filter((f) => f.fact && f.fact.trim().length > 0);

  const advance = async (): Promise<void> => {
    await deps.transcripts.put({ ...transcript, harvestedUpTo: transcript.turns.length });
  };
  if (facts.length === 0) {
    await advance();
    return null;
  }

  const ops: MutationOp[] = [];
  const learned: HarvestResult["learned"] = [];
  const updated: HarvestResult["updated"] = [];
  const pendingBring = new Map<string, string[]>();
  const knownIds = new Set(graph.dfs().map((n) => n.id));
  const at = nowIso(deps);

  for (const fact of facts) {
    if (fact.updateOfNodeId && knownIds.has(fact.updateOfNodeId)) {
      const slot = Object.keys(promptTemplate(graph.get(fact.updateOfNodeId))?.slots ?? { knowledge: 1 })[0]!;
      ops.push({
        op: "updateNode",
        id: fact.updateOfNodeId,
        patch: { prompt: { slots: { [slot]: fact.fact } }, props: { updatedAt: at } },
      });
      updated.push({ nodeId: fact.updateOfNodeId, fact: fact.fact });
      continue;
    }

    const categoryId = categoryIds.includes(fact.categoryId) ? fact.categoryId : undefined;
    if (!categoryId) continue;

    // skip near-duplicates the extractor missed
    const dupe = findNodes(graph, fact.fact.toLowerCase().slice(0, 40), { field: "prompt", subtreeId: categoryId });
    if (dupe.length > 0) continue;

    const { ops: saveOps, nodeId } = saveLearningOps(graph, knownIds, pendingBring, categoryId, categoryId, fact.fact, {
      source: "chat",
      transcriptId,
      learnedAt: at,
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
  if (ops.length === 0) {
    await advance();
    return null;
  }

  const next = await commitOps(deps, doc.version, ops, {
    actor: "harvest",
    summary: `harvest: +${learned.length} learned, ~${updated.length} updated (transcript ${transcriptId})`,
    retry: true,
  });
  await advance();
  return { learned, updated, version: next.version ?? null };
}

export interface FeedbackResult {
  adjustments: Array<{ nodeId?: string; instruction: string; categoryId: string }>;
  refined: Array<{ nodeId: string; instruction: string; viaRewrite: boolean }>;
  retired: Array<{ nodeId: string }>;
  version: string | null;
  /** An identity edict became a charter-amendment draft (or was rejected). */
  proposal: ProposalOutcome | null;
}

// Above this, a refine gets its own stage-2 rewrite call: the identification
// call sees only a truncated listing line, and the rewrite call sees only ONE
// node's full text — neither ever holds the whole graph's prompt content.
const REWRITE_THRESHOLD = 200;

interface Adjustment {
  instruction: string;
  categoryId: string;
  action?: "add" | "refine" | "retire";
  updateOfNodeId?: string;
  appliesTo?: string;
}

/**
 * One feedback comment → standing adjustments (add / refine / retire) in one
 * atomic changeset, plus an optional identity-edict path to transcendence.
 * `identity: true` skips edict classification — the comment IS the edict.
 */
export async function digestFeedback(
  deps: MemoryDeps,
  comment: string,
  opts: { identity?: boolean; context?: string } = {}
): Promise<FeedbackResult> {
  const doc = await deps.store.load(deps.graphId);
  const graph = new Graph(doc);
  const categoryIds = categories(graph);
  const taskIds = categoryIds.filter((id) => graph.get(id).prompt !== undefined);
  const empty: FeedbackResult = { adjustments: [], refined: [], retired: [], version: null, proposal: null };

  const schema = {
    type: "object",
    required: ["adjustments"],
    properties: {
      identityEdict: {
        type: "string",
        description:
          "ONLY when the feedback explicitly redefines who the agent IS (its identity, role, or core philosophy), restate that identity instruction here. Ordinary behavior preferences are adjustments, not edicts.",
      },
      adjustments: {
        type: "array",
        items: {
          type: "object",
          required: ["instruction", "categoryId"],
          properties: {
            instruction: {
              type: "string",
              description:
                "Always a complete standing instruction, imperative, self-contained — the text as it should be STORED, never a description of the change. For refine: the full revised rule. For retire: restate the rule being removed.",
            },
            categoryId: { type: "string", enum: categoryIds },
            action: {
              type: "string",
              enum: ["add", "refine", "retire"],
              description:
                "add = new instruction; refine = the feedback strengthens/reshapes an existing [id]; retire = the feedback contradicts an existing [id], remove it",
            },
            updateOfNodeId: { type: "string", description: "The existing [id] this refines or retires." },
            appliesTo: {
              type: "string",
              enum: taskIds,
              description: "If the instruction only applies to one task, that task's node id.",
            },
          },
        },
      },
    },
  };

  const text = [
    "A user is teaching this agent how to respond. Turn their feedback into standing adjustments.",
    "Prefer REFINE over add when the feedback strengthens, repeats, or reshapes an existing instruction below; use RETIRE when it contradicts one; use ADD only for genuinely new instructions.",
    "",
    "Categories (each line shows what that category governs):",
    serializeOutline(graph),
    "",
    "Existing standing instructions (target these ids for refine/retire):",
    existingLearnings(graph, await scopeIds(deps, graph, comment)),
    "",
    ...(opts.context ? [`Context: ${opts.context}`, ""] : []),
    `Feedback: ${comment}`,
  ].join("\n");

  if (!deps.llm.extract) throw new Error("digestFeedback requires an LlmConnector with extract()");
  const extracted = (await deps.llm.extract({ text, schema })) as { identityEdict?: string; adjustments?: Adjustment[] };
  const adjustments = (extracted.adjustments ?? []).filter((a) => a.instruction?.trim());

  const ops: MutationOp[] = [];
  const pendingBring = new Map<string, string[]>();
  const knownIds = new Set(graph.dfs().map((n) => n.id));
  const result: FeedbackResult = { ...empty };
  const refinedTargets = new Set<string>();
  const retiredTargets = new Set<string>();
  const at = nowIso(deps);

  const applyRefine = async (target: string, intent: string): Promise<void> => {
    if (refinedTargets.has(target)) return; // one refine per node per digest
    refinedTargets.add(target);
    const node = graph.get(target);
    const slot = Object.keys(promptTemplate(node)?.slots ?? { constraints: 1 })[0]!;
    const current = learnedText(graph, target);
    // stage 2: long nodes get a focused per-node rewrite call that sees the
    // FULL current text; short one-liners take the stage-1 instruction
    const viaRewrite = current.length > REWRITE_THRESHOLD;
    const rewrite = viaRewrite ? await rewriteNodeText(deps, target, slot, current, intent, comment) : null;
    const revised = rewrite?.revisedText ?? intent;
    const count = typeof node.props?.["feedbackCount"] === "number" ? (node.props["feedbackCount"] as number) : 1;
    ops.push({
      op: "updateNode",
      id: target,
      patch: {
        prompt: { slots: { [slot]: revised } },
        props: { feedbackCount: count + 1, updatedAt: at, ...(rewrite?.label ? { label: rewrite.label } : {}) },
      },
    });
    result.refined.push({ nodeId: target, instruction: revised, viaRewrite });
  };

  for (const adj of adjustments) {
    const target = adj.updateOfNodeId;
    if (adj.action === "refine" && target && knownIds.has(target)) {
      await applyRefine(target, adj.instruction);
      continue;
    }
    if (adj.action === "retire" && target && knownIds.has(target)) {
      // collected and emitted as one removal set after the loop — per-node
      // setBring ops would clobber each other with stale snapshots
      retiredTargets.add(target);
      knownIds.delete(target);
      result.retired.push({ nodeId: target });
      continue;
    }

    // add (also the fallback when refine/retire named an unknown id)
    const categoryId = categoryIds.includes(adj.categoryId) ? adj.categoryId : categoryIds[0];
    if (!categoryId) continue;
    const anchorId = adj.appliesTo && knownIds.has(adj.appliesTo) ? adj.appliesTo : categoryId;

    // dedup backstop: a near-duplicate of an existing rule becomes
    // reinforcement of that rule, never a second node
    const dupe = findNodes(graph, adj.instruction.toLowerCase().slice(0, 40), {
      field: "prompt",
      subtreeId: anchorId,
    }).filter((n) => n.routable === false);
    if (dupe.length > 0) {
      await applyRefine(dupe[0]!.id, adj.instruction);
      continue;
    }
    // feedback is behavioral — default to the constraints slot unless the
    // category explicitly declares a storeAs
    const { ops: saveOps, nodeId } = saveLearningOps(
      graph,
      knownIds,
      pendingBring,
      categoryId,
      anchorId,
      adj.instruction,
      { source: "feedback", feedbackCount: 1, learnedAt: at },
      "constraints"
    );
    ops.push(...saveOps);
    result.adjustments.push({ nodeId, instruction: adj.instruction, categoryId });
  }

  if (retiredTargets.size > 0) ops.push(...removalOps(graph, doc, retiredTargets));
  ops.push(...bringOps(graph, pendingBring, retiredTargets));
  if (ops.length > 0) {
    const next = await commitOps(deps, doc.version, ops, {
      actor: "feedback",
      summary: `feedback: +${result.adjustments.length} rules, ~${result.refined.length} refined, -${result.retired.length} retired`,
      retry: true,
    });
    result.version = next.version ?? null;
  }

  // identity edict → governed charter-amendment proposal (draft, never
  // applied here). The explicit flag makes intent deterministic.
  const edict = opts.identity ? comment : extracted.identityEdict?.trim();
  if (edict) result.proposal = await proposeFromEdict(deps, doc, edict);

  return result;
}

/** Stage-2 rewrite: one node, full text, one focused call. */
async function rewriteNodeText(
  deps: MemoryDeps,
  nodeId: string,
  slot: string,
  current: string,
  intent: string,
  feedback: string
): Promise<{ revisedText: string; label?: string }> {
  const schema = {
    type: "object",
    required: ["revisedText", "label"],
    properties: {
      revisedText: {
        type: "string",
        description:
          "The complete revised text for this node — everything still valid preserved, only what the feedback requires changed.",
      },
      label: { type: "string", description: "A summary of the revised text in at most 10 words, for graph listings." },
    },
  };
  const text = [
    `You maintain one node of an agent-configuration graph. Revise its text per the user's feedback.`,
    ``,
    `Node [${nodeId}], slot "${slot}", current text:`,
    current,
    ``,
    `User feedback: ${feedback}`,
    `Requested change: ${intent}`,
    ``,
    `Return the complete revised text. Preserve everything that is still valid; change only what the feedback requires. Keep it as standing instructions (imperative).`,
  ].join("\n");
  const out = (await deps.llm.extract!({ text, schema })) as { revisedText?: string; label?: string };
  const revisedText = out.revisedText?.trim() || current;
  const label = out.label?.trim();
  return label ? { revisedText, label } : { revisedText };
}

/** Route the feedback text to scope the candidate listing; undefined = show all. */
async function scopeIds(deps: MemoryDeps, graph: Graph, comment: string): Promise<string[] | undefined> {
  try {
    const routing = await route(comment, graph, { connectors: { llm: deps.llm, embeddings: deps.embeddings } });
    if (routing.fallbackUsed || routing.matches.length === 0) return undefined;
    return routing.matches.map((m) => m.nodeId);
  } catch {
    return undefined; // scoping is an optimization, never a failure mode
  }
}

// Direct feedback → graph edits, inline. (The design doc prefers lazy
// digestion; this demo digests on submit so the tree reacts in the moment.)
//
// v2: natural-language feedback can ADD a new standing instruction, REFINE an
// existing one in place (feedbackCount increments), or RETIRE one that the
// feedback contradicts — all in one atomic changeset. The candidate set shown
// to the digester is scoped by routing the feedback text (plus seeAlso
// neighbors), so the prompt stays small as the graph grows. Feedback may be
// anchored to a message (👎 Adjust) or free-form (the Teach box).
import {
  Graph,
  findNodes,
  promptTemplate,
  route,
  serializeOutline,
  type FeedbackEvent,
  type GraphDoc,
  type MutationOp,
} from "@apgraph/core";
import { getAgent, memoryPolicy, type AgentId } from "./agents";
import {
  commitOps,
  getSession,
  loadAgentGraph,
  recordFeedbackEvent,
  saveSession,
  type AmendmentProposal,
  type ChatMessage,
} from "./store";
import { proposeFromEdict } from "./transcend";
import { llm, routingConnectors } from "./llm";
import { bringOps, categories, existingLearnings, learnedText, learningLine, removalOps, saveLearningOps } from "./wisdom";
import { SHOP_TOOL_NAMES } from "./tools";

export interface FeedbackResult {
  adjustments: Array<{ nodeId?: string; instruction: string; categoryId: string; tool?: string }>;
  refined: Array<{ nodeId: string; instruction: string; viaRewrite: boolean }>;
  retired: Array<{ nodeId: string }>;
  deniedTools: string[];
  version: string | null;
  /** An identity edict became a draft charter amendment (or was drift-rejected). */
  proposal?: { id: string; status: AmendmentProposal["status"]; label: string } | { rejected: string };
}

// Above this, a refine gets its own stage-2 rewrite call: the identification
// call sees only a truncated listing line (never the full text of every
// candidate), and the rewrite call sees only ONE node's full text — so
// neither call ever holds the whole graph's prompt content at once.
const REWRITE_THRESHOLD = 200;

interface Adjustment {
  instruction: string;
  categoryId: string;
  action?: "add" | "refine" | "retire";
  updateOfNodeId?: string;
  appliesTo?: string;
  tool?: { name: string; action: "avoid" | "deny" };
}

export async function digestFeedback(
  agentId: AgentId,
  sessionId: string | undefined,
  messageIndex: number | undefined,
  comment: string,
  /** Explicit teach-identity intent: the comment IS the edict (no classification). */
  identity = false,
): Promise<FeedbackResult> {
  const agent = getAgent(agentId);
  if (!agent.supportsFeedback) throw new Error(`Agent ${agent.id} does not take direct feedback`);

  const session = sessionId ? getSession(sessionId) : null;
  if (sessionId && !session) throw new Error(`Unknown session: ${sessionId}`);
  let flagged: ChatMessage | undefined;
  let userTurn: ChatMessage | undefined;
  if (messageIndex !== undefined) {
    flagged = session?.messages[messageIndex];
    if (!flagged || flagged.role !== "assistant") throw new Error("messageIndex must point at an assistant message");
    userTurn = session?.messages[messageIndex - 1];
  }

  const { doc, graph } = await loadAgentGraph(agent);
  const categoryIds = categories(graph);
  const taskIds = categoryIds.filter((id) => graph.get(id).prompt !== undefined);

  recordFeedbackEvent(feedbackEvent(sessionId ?? "direct", agent.rootId, comment));

  const schema = {
    type: "object",
    required: ["adjustments"],
    properties: {
      identityEdict: {
        type: "string",
        description:
          "ONLY when the feedback explicitly redefines who the agent IS (its identity, role, or core philosophy — e.g. 'you are now also the service manager'), restate that identity instruction here. Ordinary behavior preferences are adjustments, not edicts.",
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
                "Always a complete standing instruction, imperative, self-contained — the text as it should be STORED, never a description of the change (e.g. 'Keep responses to one paragraph.', not 'Reinforce the brevity rule'). For refine: the full revised rule; if the feedback merely repeats the rule, restate the rule itself. For retire: restate the rule being removed.",
            },
            categoryId: { type: "string", enum: categoryIds },
            action: {
              type: "string",
              enum: ["add", "refine", "retire"],
              description:
                "add = new instruction; refine = the feedback strengthens/reshapes an existing [id] instruction; retire = the feedback contradicts an existing [id] instruction, remove it",
            },
            updateOfNodeId: {
              type: "string",
              description: "The existing [id] this refines or retires. Required for refine/retire.",
            },
            appliesTo: {
              type: "string",
              enum: taskIds,
              description: "If the instruction only applies to one task (e.g. quotes), that task's node id.",
            },
            tool: {
              type: "object",
              required: ["name", "action"],
              properties: {
                name: { type: "string", enum: SHOP_TOOL_NAMES },
                action: {
                  type: "string",
                  enum: ["avoid", "deny"],
                  description: "avoid = discourage via instruction; deny = remove the tool entirely",
                },
              },
            },
          },
        },
      },
    },
  };

  const text = [
    "A customer is teaching this agent how to respond. Turn their feedback into standing adjustments.",
    "Prefer REFINE over add when the feedback strengthens, repeats, or reshapes an existing instruction below; use RETIRE when it contradicts one; use ADD only for genuinely new instructions.",
    "",
    "Categories (each line shows what that category governs):",
    serializeOutline(graph),
    "",
    "Existing standing instructions (target these ids for refine/retire):",
    scopedLearnings(graph, doc, await scopeIds(graph, comment)),
    "",
    ...(flagged
      ? [
          "The exchange the customer flagged:",
          userTurn ? `customer: ${userTurn.content}` : "(no user turn)",
          `agent: ${flagged.content}`,
          flagged.toolCalls?.length
            ? `tools the agent used: ${flagged.toolCalls.map((t) => `${t.tool}(${JSON.stringify(t.args)})`).join(", ")}`
            : "tools the agent used: none",
          "",
          `Customer feedback: ${comment}`,
        ]
      : [`Direct instruction from the customer: ${comment}`]),
  ].join("\n");

  const extracted = (await llm.extract({ text, schema })) as { adjustments?: Adjustment[] };
  const adjustments = (extracted.adjustments ?? []).filter((a) => a.instruction?.trim());
  const empty: FeedbackResult = { adjustments: [], refined: [], retired: [], deniedTools: [], version: null };
  if (adjustments.length === 0) return empty;

  const ops: MutationOp[] = [];
  const pendingBring = new Map<string, string[]>();
  const knownIds = new Set(graph.dfs().map((n) => n.id));
  const result: FeedbackResult = { ...empty, adjustments: [] };
  let allowlist = [...(graph.get(agent.rootId).toolAllowlist ?? [])];
  const refinedTargets = new Set<string>();
  const retiredTargets = new Set<string>();

  const applyRefine = async (target: string, intent: string) => {
    if (refinedTargets.has(target)) return; // one refine per node per digest
    refinedTargets.add(target);
    const node = graph.get(target);
    const slot = Object.keys(promptTemplate(node)?.slots ?? { constraints: 1 })[0]!;
    const current = learnedText(graph, target);
    // stage 2: long nodes get a focused per-node rewrite call that sees the
    // FULL current text (the identification call saw a truncated line);
    // short one-liners take the stage-1 instruction as the replacement
    const viaRewrite = current.length > REWRITE_THRESHOLD;
    const rewrite = viaRewrite ? await rewriteNodeText(target, slot, current, intent, comment) : null;
    const revised = rewrite?.revisedText ?? intent;
    const count = typeof node.props?.["feedbackCount"] === "number" ? (node.props["feedbackCount"] as number) : 1;
    ops.push({
      op: "updateNode",
      id: target,
      patch: {
        prompt: { slots: { [slot]: revised } },
        props: {
          feedbackCount: count + 1,
          updatedAt: new Date().toISOString(),
          ...(rewrite?.label ? { label: rewrite.label } : {}),
        },
      },
    });
    result.refined.push({ nodeId: target, instruction: revised, viaRewrite });
    recordFeedbackEvent(feedbackEvent(sessionId ?? "direct", target, revised));
  };

  for (const adj of adjustments) {
    // tool denial: a hard allowlist edit, no node needed
    if (adj.tool?.action === "deny") {
      if (allowlist.includes(adj.tool.name)) {
        allowlist = allowlist.filter((t) => t !== adj.tool!.name);
        result.deniedTools.push(adj.tool.name);
      }
      result.adjustments.push({ instruction: adj.instruction, categoryId: adj.categoryId, tool: adj.tool.name });
      continue;
    }

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
      recordFeedbackEvent(feedbackEvent(sessionId ?? "direct", target, `retired: ${adj.instruction}`));
      continue;
    }

    // add (also the fallback when refine/retire named an unknown id)
    const categoryId = categoryIds.includes(adj.categoryId) ? adj.categoryId : "style";
    // task-scoped instructions anchor to the task node so they only compose
    // when that task routes; global ones anchor to their preference category
    const anchorId = adj.appliesTo && knownIds.has(adj.appliesTo) ? adj.appliesTo : categoryId;

    // dedup backstop (known-concerns #2): a near-duplicate of an existing rule
    // becomes reinforcement of that rule, never a second node — this also
    // catches targets the scoped listing failed to show the identifier call
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
      {
        source: "feedback",
        sessionId: sessionId ?? "direct",
        feedbackCount: 1,
        learnedAt: new Date().toISOString(),
        ...(adj.tool ? { tool: adj.tool.name, toolAction: adj.tool.action } : {}),
      },
      "constraints",
    );
    ops.push(...saveOps);
    result.adjustments.push({ nodeId, instruction: adj.instruction, categoryId, tool: adj.tool?.name });
    recordFeedbackEvent(feedbackEvent(sessionId ?? "direct", categoryId, adj.instruction));
  }

  if (retiredTargets.size > 0) ops.push(...removalOps(graph, doc, retiredTargets));
  ops.push(...bringOps(graph, pendingBring, retiredTargets));
  if (result.deniedTools.length > 0) {
    ops.push({ op: "updateNode", id: agent.rootId, patch: { toolAllowlist: allowlist } });
  }
  if (ops.length > 0) {
    // user-writes-win commit: retries once against a fresh doc on conflict
    const next = await commitOps(agent, doc.version, ops, {
      actor: "feedback",
      summary: `feedback: +${result.adjustments.filter((a) => a.nodeId).length} rules, ~${result.refined.length} refined, -${result.retired.length} retired${result.deniedTools.length ? `, tools denied: ${result.deniedTools.join(",")}` : ""}`,
      retry: true,
    });
    result.version = next.version ?? null;
  }

  // identity edict → governed charter-amendment proposal (draft, never applied
  // here). The explicit toggle makes intent deterministic; otherwise the
  // digester's classification decides.
  const edict = identity ? comment : (extracted as { identityEdict?: string }).identityEdict?.trim();
  if (edict) {
    const outcome = await proposeFromEdict(agent, doc, edict);
    if (outcome.proposal) {
      result.proposal = { id: outcome.proposal.id, status: outcome.proposal.status, label: outcome.proposal.label };
    } else if (outcome.rejected && outcome.rejected.reason !== "disabled") {
      result.proposal = { rejected: outcome.rejected.detail ?? outcome.rejected.reason };
    }
  }

  if (session) {
    session.learned.push(
      ...result.adjustments
        .filter((a) => a.nodeId)
        .map((a) => ({ nodeId: a.nodeId!, fact: a.instruction, categoryId: a.categoryId, at: new Date().toISOString() })),
    );
    saveSession(session);
  }
  return result;
}

/**
 * Stage-2 rewrite: one node, full text, one focused call. Returns the complete
 * revised text plus a ≤10-word summary label (used by future candidate
 * listings instead of blind truncation); falls back to the current text if
 * the model returns nothing.
 */
async function rewriteNodeText(
  nodeId: string,
  slot: string,
  current: string,
  intent: string,
  feedback: string,
): Promise<{ revisedText: string; label?: string }> {
  const schema = {
    type: "object",
    required: ["revisedText", "label"],
    properties: {
      revisedText: {
        type: "string",
        description: "The complete revised text for this node — everything still valid preserved, only what the feedback requires changed.",
      },
      label: {
        type: "string",
        description:
          "A title for the COMPLETE rule as it now stands, at most 10 words — name what the whole rule covers (e.g. 'Voice, tone, and formatting policy'), NEVER the edit just made (no 'Add…', 'Update…', 'Tighten…', 'Remove…' phrasing).",
      },
    },
  };
  const text = [
    `You maintain one node of an agent-configuration graph. Revise its text per the customer's feedback.`,
    ``,
    `Node [${nodeId}], slot "${slot}", current text:`,
    current,
    ``,
    `Customer feedback: ${feedback}`,
    `Requested change: ${intent}`,
    ``,
    `Return the complete revised text. Preserve everything that is still valid; change only what the feedback requires. Keep it as standing instructions (imperative).`,
    `The label must title the whole revised rule — what it covers as a standing policy — not describe this edit.`,
  ].join("\n");
  const out = (await llm.extract({ text, schema })) as { revisedText?: string; label?: string };
  const revisedText = out.revisedText?.trim() || current;
  const label = out.label?.trim();
  return label ? { revisedText, label } : { revisedText };
}

/** Route the feedback text to scope the candidate listing; undefined = show all. */
async function scopeIds(graph: Graph, comment: string): Promise<string[] | undefined> {
  try {
    const routing = await route(comment, graph, { connectors: routingConnectors() });
    if (routing.fallbackUsed || routing.matches.length === 0) return undefined;
    return routing.matches.map((m) => m.nodeId);
  } catch {
    return undefined; // scoping is an optimization, never a failure mode
  }
}

/** Scoped listing plus seeAlso neighbors (relatedness reaches across categories). */
function scopedLearnings(graph: Graph, doc: GraphDoc, scope: string[] | undefined): string {
  if (scope === undefined) return existingLearnings(graph);
  const base = existingLearnings(graph, scope);
  const inScope = new Set(
    scope.flatMap((categoryId) => (graph.has(categoryId) ? graph.get(categoryId).bring ?? [] : [])),
  );
  const neighborLines: string[] = [];
  for (const edge of doc.edges ?? []) {
    if (edge.kind !== "seeAlso") continue;
    for (const [member, neighbor] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      if (inScope.has(member) && !inScope.has(neighbor) && graph.has(neighbor)) {
        inScope.add(neighbor);
        const parent = graph.get(neighbor).parentId ?? "?";
        const line = learningLine(graph, neighbor, parent);
        if (line) neighborLines.push(line);
      }
    }
  }
  return neighborLines.length > 0 ? `${base}\n${neighborLines.join("\n")}` : base;
}

function feedbackEvent(sessionId: string, nodeId: string, comment: string): FeedbackEvent {
  return {
    userId: "local",
    sessionId,
    nodeId,
    signal: "thumbsDown",
    comment,
    at: new Date().toISOString(),
  };
}

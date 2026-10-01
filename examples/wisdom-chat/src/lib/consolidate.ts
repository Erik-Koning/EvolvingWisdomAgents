// The consolidation ("sleep") pass — the maintenance loop write-time hygiene
// can't provide (docs/architecture.md): per category, one off-the-chat-path
// LLM call reviews ALL resident rules against each other at full text, then
// one atomic changeset merges near-duplicates (mergeNodes), retires
// stale/contradicted rules, and maps feedbackCount reinforcement onto
// composition priority.
//
// Orchestration: maybeSleep() gates every trigger (manual button, session-end
// bedtime, idle sleep-pressure timer, cron) behind lock → threshold →
// cooldown, and commits with CAS — a user write racing a sleep always wins
// (the sleep result is discarded and rescheduled). Reviews are charter-aware:
// rules conflicting with the root's philosophy are NEVER auto-retired; they
// log pressure to the transcendence ledger instead.
import {
  Graph,
  applyChangeset,
  promptTemplate,
  type GraphDoc,
  type LlmConnector,
  type MutationOp,
} from "@apgraph/core";
import { getAgent, memoryPolicy, type AgentId, type MemoryPolicy } from "./agents";
import {
  ConflictError,
  getAgentState,
  loadAgentGraph,
  putAgentState,
  recordConsolidationEvent,
  saveAgentDoc,
  type LedgerEntry,
} from "./store";
import { llm as defaultLlm } from "./llm";
import { categories, charterHash, charterText, learnedText, removalOps } from "./wisdom";
import { maybeProposeFromPressure } from "./transcend";
import { maybeGrow, type GrowthResult } from "./grow";

/** Fallback threshold (the effective value comes from MemoryPolicy). */
export const CONSOLIDATE_MIN = 6;

// priority = 700 (direct-bring default) + 25 per reinforcement step, capped
// below leaf persona/task (900) and far below path constraints (never dropped)
const PRIORITY_BASE = 700;
const PRIORITY_STEP = 25;
const PRIORITY_CAP = 800;

export interface CategoryReview {
  merges?: Array<{ keepId: string; absorbIds: string[]; mergedText: string; label?: string }>;
  retires?: Array<{ id: string; reason?: string }>;
  priorities?: Array<{ id: string; weight: number }>;
  /** Rules that conflict with the charter — pressure evidence, never ops. */
  philosophyConflicts?: Array<{ id: string; note: string }>;
}

export interface CategorySummary {
  categoryId: string;
  merged: number;
  retired: number;
  reranked: number;
}

export interface SleepResult {
  ran: boolean;
  skipped?: "locked" | "threshold" | "cooldown" | "conflict" | "no-op";
  reason: SleepReason;
  categories: CategorySummary[];
  conflictsLogged: number;
  growth: GrowthResult | null;
  version: string | null;
}

export type SleepReason = "manual" | "sessionEnd" | "idle" | "cron";

export function consolidationStatus(
  graph: Graph,
  threshold = CONSOLIDATE_MIN,
): { recommended: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const categoryId of categories(graph)) {
    counts[categoryId] = (graph.get(categoryId).bring ?? []).length;
  }
  return { recommended: Object.values(counts).some((n) => n >= threshold), counts };
}

function isPinned(graph: Graph, id: string): boolean {
  const node = graph.get(id);
  // top-level pinned is the library invariant (kernel-enforced); props.pinned
  // is tolerated read-only for legacy data written before the promotion
  return node.pinned === true || node.props?.["pinned"] === true;
}

/**
 * Pure op-builder: validates a review against the graph and emits the
 * changeset ops. Pinned nodes are untouchable. No LLM, no I/O.
 */
export function buildConsolidationOps(
  graph: Graph,
  doc: GraphDoc,
  categoryId: string,
  review: CategoryReview,
): { ops: MutationOp[]; summary: CategorySummary } {
  const residents = new Set(graph.get(categoryId).bring ?? []);
  const consumed = new Set<string>(); // a node may be absorbed or retired once
  const ops: MutationOp[] = [];
  const summary: CategorySummary = { categoryId, merged: 0, retired: 0, reranked: 0 };
  const retired = new Set<string>();
  const absorbedToKeep = new Map<string, string>();
  const feedbackCount = (id: string): number => {
    const c = graph.get(id).props?.["feedbackCount"];
    return typeof c === "number" ? c : 1;
  };

  for (const merge of review.merges ?? []) {
    if (!residents.has(merge.keepId) || consumed.has(merge.keepId) || isPinned(graph, merge.keepId)) continue;
    const absorbIds = (merge.absorbIds ?? []).filter(
      (id) => residents.has(id) && id !== merge.keepId && !consumed.has(id) && !isPinned(graph, id),
    );
    if (absorbIds.length === 0 || !merge.mergedText?.trim()) continue;
    consumed.add(merge.keepId);
    for (const id of absorbIds) consumed.add(id);
    const keep = graph.get(merge.keepId);
    const slot = Object.keys(promptTemplate(keep)?.slots ?? { constraints: 1 })[0]!;
    const combined = [merge.keepId, ...absorbIds].reduce((acc, id) => acc + feedbackCount(id), 0);
    ops.push({
      op: "updateNode",
      id: merge.keepId,
      patch: {
        prompt: { slots: { [slot]: merge.mergedText } },
        props: {
          feedbackCount: combined,
          consolidatedAt: new Date().toISOString(),
          ...(merge.label ? { label: merge.label } : {}),
        },
      },
    });
    // mergeNodes unions brings/aliases and rewrites references graph-wide
    // (seeAlso edges etc.), then deletes the absorbed nodes; bring anchors
    // get their single authoritative setBring via removalOps below
    ops.push({ op: "mergeNodes", ids: absorbIds, intoId: merge.keepId });
    for (const id of absorbIds) absorbedToKeep.set(id, merge.keepId);
    summary.merged += absorbIds.length;
  }

  for (const retire of review.retires ?? []) {
    if (!residents.has(retire.id) || consumed.has(retire.id) || isPinned(graph, retire.id)) continue;
    consumed.add(retire.id);
    retired.add(retire.id);
    summary.retired += 1;
  }
  // one removal set for the whole changeset: final per-anchor bring arrays
  // computed once (absorbed remapped to keepers, retired dropped), edges
  // cleaned, retired nodes deleted (mergeNodes deletes the absorbed ones)
  if (retired.size > 0 || absorbedToKeep.size > 0) {
    ops.push(...removalOps(graph, doc, retired, absorbedToKeep));
  }

  for (const rank of review.priorities ?? []) {
    // keepers stay rankable; only nodes leaving the graph (or pinned) are excluded
    if (!residents.has(rank.id) || retired.has(rank.id) || absorbedToKeep.has(rank.id) || isPinned(graph, rank.id)) continue;
    const weight = Math.min(5, Math.max(1, Math.round(rank.weight)));
    const priority = Math.min(PRIORITY_CAP, PRIORITY_BASE + PRIORITY_STEP * (weight - 1));
    ops.push({ op: "updateNode", id: rank.id, patch: { composition: { priority } } });
    summary.reranked += 1;
  }

  return { ops, summary };
}

/**
 * One category's sleep cycle: charter-aware review call + atomic changeset.
 * Philosophy conflicts come back as evidence, never as ops.
 */
export async function consolidateCategory(
  doc: GraphDoc,
  graph: Graph,
  categoryId: string,
  llm: LlmConnector = defaultLlm,
  opts: { charter?: string; identityChanged?: boolean } = {},
): Promise<{ doc: GraphDoc; summary: CategorySummary; conflicts: Array<{ id: string; note: string }> } | null> {
  const residents = graph.get(categoryId).bring ?? [];
  if (residents.length < 2) return null;

  const lines = residents.map((id) => {
    const node = graph.get(id);
    const props = node.props ?? {};
    return [
      `[${id}]`,
      `text: ${learnedText(graph, id)}`,
      `feedbackCount: ${typeof props["feedbackCount"] === "number" ? props["feedbackCount"] : 1}`,
      `learnedAt: ${props["learnedAt"] ?? "unknown"}`,
      `source: ${props["source"] ?? "unknown"}`,
      ...(node.pinned === true || props["pinned"] === true ? ["PINNED (must not be merged or retired)"] : []),
    ].join(" | ");
  });

  const schema = {
    type: "object",
    properties: {
      merges: {
        type: "array",
        items: {
          type: "object",
          required: ["keepId", "absorbIds", "mergedText"],
          properties: {
            keepId: { type: "string", enum: residents },
            absorbIds: { type: "array", items: { type: "string", enum: residents } },
            mergedText: {
              type: "string",
              description: "The single rule replacing keep + absorbed — complete, imperative, no meaning lost.",
            },
            label: {
              type: "string",
              description: "≤10-word title for the merged rule's content (what it covers), never the merge action itself.",
            },
          },
        },
      },
      retires: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", enum: residents },
            reason: { type: "string" },
          },
        },
      },
      priorities: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "weight"],
          properties: {
            id: { type: "string", enum: residents },
            weight: { type: "number", description: "1 (ordinary) to 5 (strongly reinforced, must survive truncation)." },
          },
        },
      },
      philosophyConflicts: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "note"],
          properties: {
            id: { type: "string", enum: residents },
            note: { type: "string", description: "How this rule conflicts with the charter." },
          },
        },
      },
    },
  };

  const text = [
    "You are the consolidation pass over one category of an agent's learned rules — the maintenance step that compares existing rules AGAINST EACH OTHER (they were each added incrementally and have never been jointly reviewed).",
    "",
    "MERGE rules that say the same thing in different words (keep the clearest id, absorb the rest, write one merged text preserving every distinct requirement).",
    "RETIRE rules that a newer rule contradicts (keep the newer intent), or that are trivial one-offs unlikely to matter again.",
    "Assign PRIORITIES: weight 5 for heavily-reinforced rules (high feedbackCount) that must survive context truncation, 1 for ordinary ones. Only report weights for rules you keep.",
    ...(opts.charter
      ? [
          "Report PHILOSOPHY CONFLICTS: rules that contradict the agent's charter below. Do NOT retire a rule merely for conflicting with the charter — report it as a conflict instead (conflicts feed a separate governed process).",
          ...(opts.identityChanged
            ? ["NOTE: the charter recently changed — check every rule against the NEW charter text."]
            : []),
          "",
          "Agent charter:",
          opts.charter,
        ]
      : []),
    "Do not invent changes: if the category is already clean, return empty arrays.",
    "",
    `Category: ${categoryId}`,
    "Resident rules:",
    ...lines,
  ].join("\n");

  if (!llm.extract) throw new Error("consolidate requires an LlmConnector with extract()");
  const review = (await llm.extract({ text, schema })) as CategoryReview;
  const conflicts = (review.philosophyConflicts ?? []).filter((c) => residents.includes(c.id) && c.note?.trim());
  const { ops, summary } = buildConsolidationOps(graph, doc, categoryId, review);
  if (ops.length === 0 && conflicts.length === 0) return null;
  return { doc: ops.length > 0 ? applyChangeset(doc, ops) : doc, summary, conflicts };
}

/** The full sleep cycle: every qualifying category, CAS-committed as one save. */
export async function consolidate(
  agentId: AgentId,
  llm: LlmConnector = defaultLlm,
): Promise<{
  categories: CategorySummary[];
  conflicts: Array<{ id: string; note: string }>;
  growth: GrowthResult | null;
  version: string | null;
}> {
  const agent = getAgent(agentId);
  let { doc, graph } = await loadAgentGraph(agent);
  const startVersion = doc.version;
  const policy = memoryPolicy(agent, doc.meta);
  const charter = charterText(graph, agent.rootId);
  const state = getAgentState(agent.id);
  const identityChanged = state.identityHash !== null && state.identityHash !== charterHash(charter);

  const summaries: CategorySummary[] = [];
  const allConflicts: Array<{ id: string; note: string }> = [];

  // deep sleep FIRST: growth must cluster the RAW misfit episodes before
  // light sleep compresses them into merged summaries (schema extraction
  // precedes compression). When a draft is produced, the pool is exempt from
  // this cycle's merge pass so approval can still move the original nodes;
  // when growth declines, ordinary consolidation reclaims the pool.
  let growth: GrowthResult | null = null;
  try {
    growth = await maybeGrow(agent, doc, graph, llm);
  } catch {
    growth = null; // growth is opportunistic; a failed proposal never breaks sleep
  }
  const poolExempt =
    growth !== null ? graph.dfs().find((n) => n.isFallback === true && n.routable !== false)?.id : undefined;

  for (const categoryId of categories(graph)) {
    if (categoryId === poolExempt) continue;
    if ((graph.get(categoryId).bring ?? []).length < policy.sleep.threshold) continue;
    const result = await consolidateCategory(doc, graph, categoryId, llm, { charter, identityChanged });
    if (!result) continue;
    doc = result.doc;
    graph = new Graph(doc);
    if (result.summary.merged + result.summary.retired + result.summary.reranked > 0) {
      summaries.push(result.summary);
      recordConsolidationEvent({ agentId: agent.id, ...result.summary, version: doc.version, at: new Date().toISOString() });
    }
    allConflicts.push(...result.conflicts);
  }

  if (summaries.length > 0) {
    // CAS: a user write that landed mid-sleep wins; ConflictError propagates
    await saveAgentDoc(agent, doc, {
      actor: "sleep",
      summary: summaries.map((s) => `${s.categoryId}: -${s.merged + s.retired} rules`).join(", "),
      expectedVersion: startVersion,
    });
  }

  // ledger + stamps update even when only conflicts were found
  const next = getAgentState(agent.id);
  const openIds = new Set(next.pressure.filter((p) => p.status === "open").map((p) => p.nodeId));
  const additions: LedgerEntry[] = allConflicts
    .filter((c) => !openIds.has(c.id))
    .map((c) => ({ nodeId: c.id, note: c.note, at: new Date().toISOString(), status: "open" as const }));
  next.pressure = [...next.pressure, ...additions];
  next.lastSleepAt = new Date().toISOString();
  next.lastSleepSummary =
    summaries.length > 0
      ? `merged ${summaries.reduce((a, s) => a + s.merged, 0)} · retired ${summaries.reduce((a, s) => a + s.retired, 0)} · re-ranked ${summaries.reduce((a, s) => a + s.reranked, 0)}`
      : null;
  next.identityHash = charterHash(charterText(new Graph(doc), agent.rootId));
  putAgentState(agent.id, next);

  // pressure may now justify a root-amendment proposal (draft only, gated)
  await maybeProposeFromPressure(agent, doc, policy, llm);

  return {
    categories: summaries,
    conflicts: allConflicts,
    growth,
    version: summaries.length > 0 ? (doc.version ?? null) : null,
  };
}

// ---- orchestration: every trigger funnels through maybeSleep ----

const sleeping = new Set<AgentId>();
const idleTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
const lastActivity = new Map<AgentId, number>();

export async function maybeSleep(agentId: AgentId, reason: SleepReason, llm: LlmConnector = defaultLlm): Promise<SleepResult> {
  const agent = getAgent(agentId);
  const base: SleepResult = { ran: false, reason, categories: [], conflictsLogged: 0, growth: null, version: null };
  if (sleeping.has(agent.id)) return { ...base, skipped: "locked" };

  const { doc, graph } = await loadAgentGraph(agent);
  const policy = memoryPolicy(agent, doc.meta);
  if (!consolidationStatus(graph, policy.sleep.threshold).recommended) {
    return { ...base, skipped: "threshold" };
  }
  if (reason !== "manual") {
    const state = getAgentState(agent.id);
    if (state.lastSleepAt && Date.now() - Date.parse(state.lastSleepAt) < policy.sleep.cooldownMs) {
      return { ...base, skipped: "cooldown" };
    }
  }

  sleeping.add(agent.id);
  try {
    const result = await consolidate(agent.id, llm);
    return {
      ran: result.categories.length > 0,
      ...(result.categories.length === 0 ? { skipped: "no-op" as const } : {}),
      reason,
      categories: result.categories,
      conflictsLogged: result.conflicts.length,
      growth: result.growth,
      version: result.version,
    };
  } catch (err) {
    if (err instanceof ConflictError) {
      armIdleSleep(agent.id); // user won; try again after the next quiet stretch
      return { ...base, skipped: "conflict" };
    }
    throw err;
  } finally {
    sleeping.delete(agent.id);
  }
}

/**
 * Sleep-pressure trigger: (re)arm the per-agent idle timer. Called after every
 * chat/feedback commit; each activity pushes sleep further away, so the pass
 * only runs in a quiet stretch.
 */
export function armIdleSleep(agentId: AgentId): void {
  const agent = getAgent(agentId);
  lastActivity.set(agent.id, Date.now());
  const existing = idleTimers.get(agent.id);
  if (existing) clearTimeout(existing);
  void (async () => {
    const { doc } = await loadAgentGraph(agent);
    const policy = memoryPolicy(agent, doc.meta);
    if (policy.sleep.idleMs === null) return;
    const timer = setTimeout(() => {
      idleTimers.delete(agent.id);
      void maybeSleep(agent.id, "idle").catch(() => {});
    }, policy.sleep.idleMs);
    timer.unref?.();
    idleTimers.set(agent.id, timer);
  })();
}

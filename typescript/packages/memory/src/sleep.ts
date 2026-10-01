// The consolidation ("sleep") pass — the maintenance loop write-time hygiene
// can't provide: per category, one off-the-hot-path LLM call reviews ALL
// resident rules against each other at full text, then one atomic changeset
// merges near-duplicates, retires stale/contradicted rules, and maps
// feedbackCount reinforcement onto composition priority.
//
// Ordering rule (pinned in docs/architecture.md): deep-sleep growth runs
// FIRST against the pre-compression graph — the merge pass would destroy the
// very signal clustering needs — and when growth drafts a proposal, the pool
// is exempt from that cycle's merges. Reviews are charter-aware: rules
// conflicting with the root's philosophy are NEVER auto-retired; they log
// pressure to the transcendence ledger instead.
import {
  Graph,
  StoreConflictError,
  applyChangeset,
  promptTemplate,
  verifyCitation,
  type GraphDoc,
  type MutationOp,
} from "@apgraph/core";
import { depLock, emitAudit, type MemoryDeps } from "./deps.js";
import { categories, charterHash, charterText, learnedText, removalOps, rootId } from "./ops.js";
import { resolvePolicy, type MemoryPolicy, type PolicyOverride } from "./policy.js";
import { getEngineState, nowIso, putEngineState, type LedgerCitation, type LedgerEntry } from "./state.js";
import { maybeGrow, type GrowthResult } from "./grow.js";
import { driftSimilarity, maybeProposeFromPressure, type ProposalOutcome } from "./transcend.js";

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
  skipped?: "threshold" | "cooldown" | "conflict" | "no-op";
  categories: CategorySummary[];
  conflictsLogged: number;
  growth: GrowthResult | null;
  proposal: ProposalOutcome | null;
  version: string | null;
}

export interface SleepOptions {
  /** Manual triggers bypass the cooldown (never the threshold). */
  manual?: boolean;
  policy?: PolicyOverride;
}

export function consolidationStatus(
  graph: Graph,
  threshold: number
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
  at: string
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
      (id) => residents.has(id) && id !== merge.keepId && !consumed.has(id) && !isPinned(graph, id)
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
          consolidatedAt: at,
          ...(merge.label ? { label: merge.label } : {}),
        },
      },
    });
    // mergeNodes unions brings/aliases and rewrites references graph-wide,
    // then deletes the absorbed nodes; bring anchors get their single
    // authoritative setBring via removalOps below
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
    if (!residents.has(rank.id) || retired.has(rank.id) || absorbedToKeep.has(rank.id) || isPinned(graph, rank.id))
      continue;
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
  deps: MemoryDeps,
  doc: GraphDoc,
  graph: Graph,
  categoryId: string,
  opts: { charter?: string; identityChanged?: boolean } = {}
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
            label: { type: "string", description: "≤10-word summary of the merged rule." },
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

  if (!deps.llm.extract) throw new Error("runSleep requires an LlmConnector with extract()");
  const review = (await deps.llm.extract({ text, schema })) as CategoryReview;
  const conflicts = (review.philosophyConflicts ?? []).filter((c) => residents.includes(c.id) && c.note?.trim());
  const { ops, summary } = buildConsolidationOps(graph, doc, categoryId, review, nowIso(deps));
  if (ops.length === 0 && conflicts.length === 0) return null;
  return { doc: ops.length > 0 ? applyChangeset(doc, ops) : doc, summary, conflicts };
}

/** Cap per-turn text in the citation prompt; a quote drawn from the shown
 * prefix is still a verbatim substring of the full turn, so it verifies. */
const TURN_CAP = 400;

/**
 * The citation pass (library-roadmap #8): a philosophy conflict earns full
 * pressure weight only with a verbatim USER-turn quote from the rule's
 * originating transcript (`props.transcriptId`, stamped by harvest), verified
 * mechanically with the kernel's `verifyCitation` — the same authority rule
 * as the replay evidence gate. One focused extract call per fresh conflict
 * whose rule carries provenance; everything else — no provenance, unknown
 * transcript, failed verification, extract error — is marked `inferred`.
 * Corroboration is best-effort, never a failure mode.
 */
export async function citeConflict(
  deps: MemoryDeps,
  graph: Graph,
  conflict: { id: string; note: string }
): Promise<{ citation?: LedgerCitation }> {
  try {
    const transcriptId = graph.has(conflict.id) ? graph.get(conflict.id).props?.["transcriptId"] : undefined;
    if (typeof transcriptId !== "string" || !deps.llm.extract) return {};
    const transcript = await deps.transcripts.get(transcriptId);
    if (!transcript) return {};
    const userTurns = transcript.turns.map((t, i) => ({ ...t, i })).filter((t) => t.role === "user");
    if (userTurns.length === 0) return {};

    const out = (await deps.llm.extract({
      text: [
        "A learned rule conflicts with an agent's charter. Find the user turn that evidences the rule, and copy a short quote from it EXACTLY (a verbatim substring). If no user turn evidences it, report found: false.",
        "",
        `Rule: ${learnedText(graph, conflict.id)}`,
        `Conflict: ${conflict.note}`,
        "",
        "User turns:",
        ...userTurns.map((t) => `[${t.i}] ${t.content.slice(0, TURN_CAP)}`),
      ].join("\n"),
      schema: {
        type: "object",
        required: ["found"],
        properties: {
          found: { type: "boolean" },
          turnIndex: { type: "number", description: "The [index] of the quoted user turn." },
          quote: { type: "string", description: "Verbatim substring copied from that turn." },
        },
      },
    })) as { found?: boolean; turnIndex?: number; quote?: string };
    if (out.found !== true || typeof out.turnIndex !== "number" || !out.quote?.trim()) return {};

    const citation: LedgerCitation = { transcriptId, turnIndex: out.turnIndex, quote: out.quote.trim() };
    return verifyCitation({ opIndex: 0, ...citation }, [transcript]) === null ? { citation } : {};
  } catch {
    return {}; // corroboration is best-effort
  }
}

/**
 * The full sleep cycle, gated: threshold always, cooldown unless manual.
 * Growth first, then every qualifying category, one CAS-committed save — a
 * user write racing the sleep wins (the result is discarded, skipped:
 * "conflict"). Ends by checking whether accumulated pressure justifies a
 * charter-amendment draft.
 */
export async function runSleep(deps: MemoryDeps, opts: SleepOptions = {}): Promise<SleepResult> {
  return depLock(deps)(`sleep:${deps.graphId}`, () => runSleepLocked(deps, opts));
}

async function runSleepLocked(deps: MemoryDeps, opts: SleepOptions): Promise<SleepResult> {
  const base: SleepResult = { ran: false, categories: [], conflictsLogged: 0, growth: null, proposal: null, version: null };
  let doc = await deps.store.load(deps.graphId);
  let graph = new Graph(doc);
  const startVersion = doc.version;
  const policy: MemoryPolicy = resolvePolicy(doc, opts.policy);
  const root = rootId(graph);
  const charter = charterText(graph, root);
  const state = await getEngineState(deps);

  if (!consolidationStatus(graph, policy.sleep.threshold).recommended) {
    return { ...base, skipped: "threshold" };
  }
  if (!opts.manual && state.lastSleepAt) {
    const elapsed = Date.parse(nowIso(deps)) - Date.parse(state.lastSleepAt);
    if (elapsed < policy.sleep.cooldownMs) return { ...base, skipped: "cooldown" };
  }
  const identityChanged = state.identityHash !== null && state.identityHash !== charterHash(charter);

  // deep sleep FIRST: growth must cluster the RAW misfit episodes before
  // light sleep compresses them into merged summaries (schema extraction
  // precedes compression). When a draft is produced, the pool is exempt from
  // this cycle's merge pass so approval can still move the original nodes.
  let growth: GrowthResult | null = null;
  try {
    growth = await maybeGrow(deps, doc, graph, policy.growth);
  } catch {
    growth = null; // growth is opportunistic; a failed proposal never breaks sleep
  }
  const poolExempt =
    growth !== null ? graph.dfs().find((n) => n.isFallback === true && n.routable !== false)?.id : undefined;

  const summaries: CategorySummary[] = [];
  const allConflicts: Array<{ id: string; note: string }> = [];
  for (const categoryId of categories(graph)) {
    if (categoryId === poolExempt) continue;
    if ((graph.get(categoryId).bring ?? []).length < policy.sleep.threshold) continue;
    const result = await consolidateCategory(deps, doc, graph, categoryId, { charter, identityChanged });
    if (!result) continue;
    doc = result.doc;
    graph = new Graph(doc);
    if (result.summary.merged + result.summary.retired + result.summary.reranked > 0) summaries.push(result.summary);
    allConflicts.push(...result.conflicts);
  }

  if (summaries.length > 0) {
    try {
      // CAS: a user write that landed mid-sleep wins
      await deps.store.save(doc, { expectedVersion: startVersion ?? null });
    } catch (err) {
      if (err instanceof StoreConflictError) return { ...base, growth, skipped: "conflict" };
      throw err;
    }
    emitAudit(deps, {
      actor: "sleep",
      fromVersion: startVersion ?? null,
      toVersion: doc.version ?? null,
      summary: summaries.map((s) => `${s.categoryId}: -${s.merged + s.retired} rules`).join(", "),
    });
  }

  // ledger + stamps update even when only conflicts were found. Fresh
  // conflicts get the citation pass: a verified user quote earns full weight,
  // uncorroborated model inference is marked inferred (reduced weight).
  const next = await getEngineState(deps);
  const openIds = new Set(next.pressure.filter((p) => p.status === "open").map((p) => p.nodeId));
  const additions: LedgerEntry[] = [];
  for (const c of allConflicts) {
    if (openIds.has(c.id)) continue;
    openIds.add(c.id);
    const { citation } = await citeConflict(deps, graph, c);
    additions.push({
      nodeId: c.id,
      note: c.note,
      at: nowIso(deps),
      status: "open",
      ...(citation ? { citation } : { inferred: true }),
    });
  }
  next.pressure = [...next.pressure, ...additions];
  next.lastSleepAt = nowIso(deps);
  next.lastSleepSummary =
    summaries.length > 0
      ? `merged ${summaries.reduce((a, s) => a + s.merged, 0)} · retired ${summaries.reduce((a, s) => a + s.retired, 0)} · re-ranked ${summaries.reduce((a, s) => a + s.reranked, 0)}`
      : null;
  next.identityHash = charterHash(charterText(new Graph(doc), root));
  // identity odometer: capture genesis on first contact; refresh the live
  // cumulative when the charter moved (amendments AND manual root edits)
  if (next.genesisCharter === null) next.genesisCharter = charter;
  if (identityChanged || next.identityCumulative === null) {
    try {
      next.identityCumulative = await driftSimilarity(deps, next.genesisCharter, charter);
    } catch {
      // the odometer is best-effort; never fails a sleep
    }
  }
  await putEngineState(deps, next);

  // pressure may now justify a root-amendment proposal (draft only, gated)
  const proposal = await maybeProposeFromPressure(deps, doc, policy);

  return {
    ran: summaries.length > 0,
    ...(summaries.length === 0 ? { skipped: "no-op" as const } : {}),
    categories: summaries,
    conflictsLogged: allConflicts.length,
    growth,
    proposal,
    version: summaries.length > 0 ? (doc.version ?? null) : null,
  };
}

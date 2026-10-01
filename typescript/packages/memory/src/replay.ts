// Transcript replay — offline re-processing of RAW stored conversations with
// hindsight the wake-path harvest never had (cross-session patterns, rules
// that later turned out over-generalized). Contract (docs/library-roadmap.md):
//
// - PRESERVATION-BIASED: adds/reinforcements/refinements are free; an op that
//   degrades stored wisdom applies only with a mechanically verified citation
//   quoting the USER's own words (the evidence gate, fixture 64). Uncited
//   degrades are dropped to the pressure ledger — a doubt for a future sleep
//   to examine, never a deletion.
// - REPLAY → SLEEP: a replay run always finishes with the sleep pass, so all
//   merging and category break-out happen after replay's additions land.
// - EXPLICIT TRIGGER ONLY: nothing in this module schedules anything; hosts
//   call runReplay from a deliberate API/tool call or their own cron.
//
// Commit policy: the gated batch auto-commits under actor "replay" with
// maintenance CAS semantics — a user write racing the replay wins and the
// whole batch is discarded (watermarks do not advance). Structural change
// stays human-gated: replay never creates categories or touches the root.
import {
  Graph,
  StoreConflictError,
  applyEvidenceGate,
  commitChangeset,
  createChangeset,
  addOps,
  findNodes,
  promptTemplate,
  serializeOutline,
  validateChangeset,
  type GraphDoc,
  type MutationOp,
  type OpEvidence,
  type Transcript,
} from "@apgraph/core";
import { depLock, depNow, emitAudit, type MemoryDeps } from "./deps.js";
import { bringOps, categories, charterText, existingLearnings, removalOps, rootId, saveLearningOps } from "./ops.js";
import { resolvePolicy, type PolicyOverride } from "./policy.js";
import { getEngineState, nowIso, putEngineState } from "./state.js";
import { runSleep, type SleepResult } from "./sleep.js";

export interface ReplayOptions {
  /** Explicit transcripts to replay; default = every transcript with un-replayed turns. */
  transcriptIds?: string[];
  /** Extract + gate only: no commit, no watermark advance, no sleep. */
  dryRun?: boolean;
  /** Set false to skip the trailing sleep pass (default true per the contract). */
  sleep?: boolean;
  policy?: PolicyOverride;
}

export interface ReplayReport {
  ran: boolean;
  skipped?: "no-transcripts" | "no-candidates" | "conflict";
  dryRun: boolean;
  transcripts: Array<{ id: string; fromTurn: number; toTurn: number }>;
  added: Array<{ nodeId: string; text: string; categoryId: string }>;
  reinforced: Array<{ nodeId: string; text: string }>;
  refined: Array<{ nodeId: string; text: string }>;
  /** Degrades that carried a verified user quote and were applied. */
  degradesApplied: Array<{ nodeId: string; kind: "retire" | "refine"; quote: string; transcriptId: string }>;
  /** Degrades dropped by the evidence gate (reason per fixture-64 vocabulary). */
  degradesDropped: Array<{ nodeId: string; kind: string; reason: string }>;
  changesetId: string | null;
  version: string | null;
  sleep: SleepResult | null;
}

interface ReplayCandidate {
  kind: "add" | "reinforce" | "refine" | "retire";
  text: string;
  categoryId?: string;
  targetNodeId?: string;
  quote?: string;
  transcriptId?: string;
  turnIndex?: number;
}

/** Replay stored transcripts, commit the gated batch, then sleep. */
export async function runReplay(deps: MemoryDeps, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const base: ReplayReport = {
    ran: false,
    dryRun: opts.dryRun === true,
    transcripts: [],
    added: [],
    reinforced: [],
    refined: [],
    degradesApplied: [],
    degradesDropped: [],
    changesetId: null,
    version: null,
    sleep: null,
  };

  const selected = await selectTranscripts(deps, opts.transcriptIds);
  if (selected.length === 0) return { ...base, skipped: "no-transcripts" };
  base.transcripts = selected.map((t) => ({ id: t.id, fromTurn: t.replayedUpTo ?? 0, toTurn: t.turns.length }));

  const doc = await deps.store.load(deps.graphId);
  const graph = new Graph(doc);
  const policy = resolvePolicy(doc, opts.policy);

  // one extract per transcript window, all against the SAME graph snapshot
  const candidates: ReplayCandidate[] = [];
  for (const transcript of selected) {
    candidates.push(...(await extractCandidates(deps, graph, transcript, policy.replay.windowTurns)));
  }
  if (candidates.length === 0) {
    if (!opts.dryRun) await advanceWatermarks(deps, selected);
    const sleep = !opts.dryRun && opts.sleep !== false ? await runSleep(deps, { manual: true }) : null;
    return { ...base, skipped: "no-candidates", sleep };
  }

  const { ops, evidence, pendingBring, report } = buildReplayOps(deps, doc, graph, candidates);
  // the gate runs on intent ops (addNode/updateNode/deleteNode); verified
  // retires are then expanded into the full removal set (bring cleanup +
  // seeAlso edges) which carries the same warrant as its delete
  const gate = applyEvidenceGate(doc, ops, evidence, selected);
  for (const d of gate.dropped) {
    const nodeId = "id" in d.op ? String(d.op.id) : "?";
    report.degradesDropped.push({ nodeId, kind: d.op.op === "deleteNode" ? "retire" : "refine", reason: d.reason });
  }
  report.degradesApplied = report.degradesApplied.filter((a) =>
    gate.kept.some((op) => "id" in op && op.id === a.nodeId)
  );
  report.refined = report.refined.filter(
    (r) => !report.degradesDropped.some((d) => d.nodeId === r.nodeId && d.kind === "refine")
  );
  // uncited degrades become pressure-ledger doubts, never deletions
  if (gate.dropped.length > 0 && !opts.dryRun) {
    const state = await getEngineState(deps);
    const openIds = new Set(state.pressure.filter((p) => p.status === "open").map((p) => p.nodeId));
    for (const d of gate.dropped) {
      const nodeId = "id" in d.op ? String(d.op.id) : "?";
      if (openIds.has(nodeId)) continue;
      openIds.add(nodeId);
      // uncited by definition (that is why the op dropped) → inferred weight
      state.pressure.push({
        nodeId,
        note: `replay: uncited ${d.op.op} dropped (${d.reason})`,
        at: nowIso(deps),
        status: "open",
        inferred: true,
      });
    }
    await putEngineState(deps, state);
  }

  const retiredIds = new Set(
    gate.kept.filter((op): op is MutationOp & { op: "deleteNode"; id: string } => op.op === "deleteNode").map((op) => op.id)
  );
  const keptNonDelete = gate.kept.filter((op) => op.op !== "deleteNode");
  const finalOps: MutationOp[] = [
    ...keptNonDelete,
    ...(retiredIds.size > 0 ? removalOps(graph, doc, retiredIds) : []),
    ...bringOps(graph, pendingBring, retiredIds),
  ];
  if (finalOps.length === 0) {
    if (!opts.dryRun) await advanceWatermarks(deps, selected);
    const sleep = !opts.dryRun && opts.sleep !== false ? await runSleep(deps, { manual: true }) : null;
    return { ...base, ...report, skipped: "no-candidates", sleep };
  }
  const finalEvidence: OpEvidence[] = gate.evidence.map((e) => {
    const source = gate.kept[e.opIndex]!;
    return { ...e, opIndex: finalOps.indexOf(source) };
  });

  if (opts.dryRun) return { ...base, ...report, ran: true };

  // one audited changeset, maintenance CAS: the user's write always wins
  try {
    const committed = await depLock(deps)(deps.graphId, async () => {
      const fresh = await deps.store.load(deps.graphId);
      if (fresh.version !== doc.version) throw new StoreConflictError(`graph moved during replay (${doc.version} → ${fresh.version})`);
      let cs = createChangeset(doc, "replay", `replay-${depNow(deps).toString(36)}`);
      cs = addOps(cs, finalOps);
      cs = { ...cs, evidence: finalEvidence, createdAt: nowIso(deps), meta: { kind: "replay" } };
      cs = await validateChangeset(doc, cs, {});
      if (cs.status !== "validated") {
        const errors = cs.validation?.errors.map((e) => e.message).join("; ") ?? "unknown";
        throw new Error(`replay changeset failed validation: ${errors}`);
      }
      const { doc: next, changeset } = commitChangeset(doc, cs, { autoApprove: true });
      await deps.store.save(next, { expectedVersion: doc.version ?? null });
      await deps.changesets.put(changeset);
      emitAudit(deps, {
        actor: "replay",
        fromVersion: doc.version ?? null,
        toVersion: next.version ?? null,
        summary: `replay: +${report.added.length} added, ~${report.reinforced.length + report.refined.length} updated, -${retiredIds.size} retired (cited)`,
      });
      return { changeset, version: next.version ?? null };
    });
    base.changesetId = committed.changeset.id;
    base.version = committed.version;
  } catch (err) {
    if (err instanceof StoreConflictError) return { ...base, ...report, skipped: "conflict" };
    throw err;
  }

  await advanceWatermarks(deps, selected);
  const sleep = opts.sleep !== false ? await runSleep(deps, { manual: true }) : null;
  return { ...base, ...report, ran: true, sleep };
}

async function selectTranscripts(deps: MemoryDeps, ids?: string[]): Promise<Transcript[]> {
  const all =
    ids !== undefined
      ? (await Promise.all(ids.map((id) => deps.transcripts.get(id)))).filter((t): t is Transcript => t !== null)
      : await deps.transcripts.list(deps.graphId);
  return all.filter((t) => t.turns.length > (t.replayedUpTo ?? 0));
}

async function advanceWatermarks(deps: MemoryDeps, selected: Transcript[]): Promise<void> {
  for (const t of selected) {
    await deps.transcripts.put({ ...t, replayedUpTo: t.turns.length });
  }
}

async function extractCandidates(
  deps: MemoryDeps,
  graph: Graph,
  transcript: Transcript,
  windowTurns: number
): Promise<ReplayCandidate[]> {
  const categoryIds = categories(graph);
  const knownIds = graph.dfs().map((n) => n.id);
  const start = transcript.replayedUpTo ?? 0;
  const harvestedUpTo = transcript.harvestedUpTo ?? 0;
  const out: ReplayCandidate[] = [];

  const schema = {
    type: "object",
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "text"],
          properties: {
            kind: {
              type: "string",
              enum: ["add", "reinforce", "refine", "retire"],
              description:
                "add = genuinely new durable learning; reinforce = an existing [id] was confirmed again; refine = an existing [id] needs its text corrected with hindsight; retire = the user's own words contradict an existing [id].",
            },
            text: {
              type: "string",
              description: "For add/refine: the COMPLETE text as it should be stored. For reinforce/retire: restate the rule.",
            },
            categoryId: { type: "string", enum: categoryIds },
            targetNodeId: { type: "string", description: "The existing [id] for reinforce/refine/retire." },
            quote: {
              type: "string",
              description:
                "REQUIRED for retire, and for any refine that weakens or shortens: the user's EXACT words (verbatim from a user turn below) that justify it. Never quote the assistant.",
            },
            turnIndex: { type: "number", description: "The [index] of the user turn the quote comes from." },
          },
        },
      },
    },
  };

  for (let from = start; from < transcript.turns.length; from += windowTurns) {
    const window = transcript.turns.slice(from, from + windowTurns);
    const lines = window.map((t, i) => `[${from + i}] ${t.role}: ${t.content}`);
    const distilled = harvestedUpTo > from;
    const text = [
      "You are the REPLAY pass re-reading a stored conversation with hindsight, against everything the agent has learned since. Report durable learnings the wake-path extraction missed, confirmations of existing rules, corrections, and contradictions.",
      "Be conservative: stored wisdom is presumed correct. Only retire/weaken when the USER's own words contradict it — and then you MUST quote those exact words with their turn [index]. Assistant turns carry no authority.",
      ...(distilled
        ? ["Parts of this range were already distilled at wake time: prefer reinforce/refine/retire over add for anything already covered below."]
        : []),
      "",
      "Agent charter:",
      charterText(graph, rootId(graph)),
      "",
      "Categories (each line shows what that category wants learned):",
      serializeOutline(graph),
      "",
      "Already known (target these ids for reinforce/refine/retire):",
      existingLearnings(graph),
      "",
      `Transcript ${transcript.id}, turns ${from}–${from + window.length - 1}:`,
      ...lines,
    ].join("\n");

    if (!deps.llm.extract) throw new Error("runReplay requires an LlmConnector with extract()");
    const extracted = (await deps.llm.extract({ text, schema })) as { candidates?: ReplayCandidate[] };
    for (const c of extracted.candidates ?? []) {
      if (!c.text?.trim()) continue;
      if (c.kind !== "add" && (!c.targetNodeId || !knownIds.includes(c.targetNodeId))) continue;
      out.push({ ...c, transcriptId: transcript.id });
    }
  }
  return out;
}

interface OpsBuild {
  ops: MutationOp[];
  evidence: OpEvidence[];
  pendingBring: Map<string, string[]>;
  report: Pick<ReplayReport, "added" | "reinforced" | "refined" | "degradesApplied" | "degradesDropped">;
}

function buildReplayOps(deps: MemoryDeps, doc: GraphDoc, graph: Graph, candidates: ReplayCandidate[]): OpsBuild {
  const ops: MutationOp[] = [];
  const evidence: OpEvidence[] = [];
  const pendingBring = new Map<string, string[]>();
  const knownIds = new Set(graph.dfs().map((n) => n.id));
  const touched = new Set<string>();
  const added: ReplayReport["added"] = [];
  const reinforced: ReplayReport["reinforced"] = [];
  const refined: ReplayReport["refined"] = [];
  const degradesApplied: ReplayReport["degradesApplied"] = [];
  const at = nowIso(deps);

  const cite = (c: ReplayCandidate): void => {
    if (c.quote?.trim() && c.transcriptId && typeof c.turnIndex === "number") {
      evidence.push({ opIndex: ops.length - 1, quote: c.quote.trim(), transcriptId: c.transcriptId, turnIndex: c.turnIndex });
    }
  };
  const bumpFeedback = (nodeId: string, text: string): void => {
    const count = graph.get(nodeId).props?.["feedbackCount"];
    ops.push({
      op: "updateNode",
      id: nodeId,
      patch: { props: { feedbackCount: (typeof count === "number" ? count : 1) + 1, reinforcedAt: at } },
    });
    reinforced.push({ nodeId, text });
  };

  for (const c of candidates) {
    const target = c.targetNodeId;
    if (c.kind !== "add" && (target === undefined || touched.has(target))) continue; // one op per node per replay

    if (c.kind === "reinforce" && target) {
      touched.add(target);
      bumpFeedback(target, c.text);
      continue;
    }
    if (c.kind === "refine" && target) {
      touched.add(target);
      const slot = Object.keys(promptTemplate(graph.get(target))?.slots ?? { knowledge: 1 })[0]!;
      // the gate decides mechanically: a refine that grows the text passes
      // free; one that shortens it is a degrade needing the citation
      ops.push({
        op: "updateNode",
        id: target,
        patch: { prompt: { slots: { [slot]: c.text.trim() } }, props: { updatedAt: at } },
      });
      cite(c);
      refined.push({ nodeId: target, text: c.text.trim() });
      if (c.quote && c.transcriptId) {
        degradesApplied.push({ nodeId: target, kind: "refine", quote: c.quote, transcriptId: c.transcriptId });
      }
      continue;
    }
    if (c.kind === "retire" && target) {
      touched.add(target);
      // intent op only — the full removal set is expanded post-gate
      ops.push({ op: "deleteNode", id: target, orphans: "cascade" });
      cite(c);
      if (c.quote && c.transcriptId) {
        degradesApplied.push({ nodeId: target, kind: "retire", quote: c.quote, transcriptId: c.transcriptId });
      }
      continue;
    }

    // add — with the same dedup backstop as harvest: a near-duplicate becomes
    // reinforcement of the existing rule, never a second node
    const categoryId = c.categoryId && knownIds.has(c.categoryId) ? c.categoryId : null;
    if (!categoryId) continue;
    const dupe = findNodes(graph, c.text.toLowerCase().slice(0, 40), { field: "prompt", subtreeId: categoryId }).filter(
      (n) => n.routable === false
    );
    if (dupe.length > 0) {
      if (!touched.has(dupe[0]!.id)) {
        touched.add(dupe[0]!.id);
        bumpFeedback(dupe[0]!.id, c.text);
      }
      continue;
    }
    const { ops: saveOps, nodeId } = saveLearningOps(graph, knownIds, pendingBring, categoryId, categoryId, c.text.trim(), {
      source: "replay",
      ...(c.transcriptId ? { transcriptId: c.transcriptId } : {}),
      learnedAt: at,
    });
    ops.push(...saveOps);
    added.push({ nodeId, text: c.text.trim(), categoryId });
  }

  return {
    ops,
    evidence,
    pendingBring,
    report: { added, reinforced, refined, degradesApplied, degradesDropped: [] },
  };
}

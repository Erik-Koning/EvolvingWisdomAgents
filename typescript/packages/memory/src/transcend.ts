// The transcendence engine: governed evolution of the root charter. Two
// proposal sources — accumulated philosophy-conflict pressure from sleep
// passes, and explicit identity edicts. Every proposal is a lifecycle
// CHANGESET (createdBy "amendment", drift/rationale/charterHash in meta) so
// growth and amendments share one persistence and one approval surface;
// commit remains human-gated at any score, and the drift cap + a semantic-
// inversion verifier bound each step. Rejected proposals stay on file as
// discarded changesets with meta.rejected.
import {
  Graph,
  addOps,
  createChangeset,
  discardChangeset,
  promptTemplate,
  validateChangeset,
  type Changeset,
  type GraphDoc,
  type MutationOp,
  type Slot,
} from "@apgraph/core";
import { depNow, type MemoryDeps } from "./deps.js";
import { charterFromSlots, charterHash, charterText, learnedText, rootId } from "./ops.js";
import { resolvePolicy, type AmendableSlot, type MemoryPolicy } from "./policy.js";
import { getEngineState, nowIso, putEngineState, weighPressure, type LedgerCitation } from "./state.js";

export interface ProposalOutcome {
  /** The draft changeset awaiting the human gate (validated = committable). */
  changeset: Changeset | null;
  rejected?: {
    reason: "disabled" | "cooldown" | "existing-draft" | "drift" | "inversion" | "no-amendment";
    detail?: string;
  };
}

interface AmendmentDraft {
  amendments?: Array<{ slot: AmendableSlot; revisedText: string; rationale: string }>;
  label?: string;
}

export interface AmendmentMeta {
  kind: "amendment";
  source: "pressure" | "edict";
  label: string;
  rationale: string;
  changes: Record<string, { old: string; next: string }>;
  drift: Record<string, number>;
  charterHash: string;
  /** Ledger evidence; `citation` is a mechanically verified user quote. */
  evidence: Array<{ nodeId?: string; note: string; citation?: LedgerCitation }>;
  /** Identity odometer: similarity(genesis charter, charter) before and after
   * this amendment, so the human gate sees the journey, not just the step. */
  odometer?: { before: number; after: number; reviewFloor: number };
  rejected?: { reason: string; detail?: string };
}

const isAmendment = (cs: Changeset): boolean => (cs.meta as AmendmentMeta | undefined)?.kind === "amendment";

export async function listAmendmentDrafts(deps: MemoryDeps): Promise<Changeset[]> {
  const all = await deps.changesets.list();
  return all.filter((cs) => isAmendment(cs) && (cs.status === "draft" || cs.status === "validated"));
}

/** Similarity between old and new charter text: cosine when embeddings are
 * bound; otherwise a normalized-Levenshtein proxy (documented as crude). */
export async function driftSimilarity(deps: MemoryDeps, oldText: string, newText: string): Promise<number> {
  if (deps.embeddings) {
    const [a, b] = await deps.embeddings.embed([oldText, newText]);
    return cosine(a!, b!);
  }
  return 1 - levenshtein(oldText, newText) / Math.max(oldText.length, newText.length, 1);
}

/** Pressure-path gate: called at the end of every sleep. Draft only. */
export async function maybeProposeFromPressure(
  deps: MemoryDeps,
  doc: GraphDoc,
  policy: MemoryPolicy
): Promise<ProposalOutcome> {
  const t = policy.transcendence;
  if (t.score <= 0 || t.amendableSlots.length === 0) return { changeset: null, rejected: { reason: "disabled" } };
  const state = await getEngineState(deps);
  const open = state.pressure.filter((p) => p.status === "open");
  // cited conflicts weigh 1; uncorroborated inference weighs inferredWeight —
  // model-only evidence must be more sustained to petition the charter
  if (weighPressure(open, t.inferredWeight) < t.pressureThreshold) return { changeset: null };
  const lastAmend = [state.lastAmendProposedAt, state.lastAmendAt]
    .filter((x): x is string => x !== null)
    .map(Date.parse)
    .sort((a, b) => b - a)[0];
  if (lastAmend !== undefined && depNow(deps) - lastAmend < t.cooldownMs) {
    return { changeset: null, rejected: { reason: "cooldown" } };
  }
  if ((await listAmendmentDrafts(deps)).length > 0) {
    return { changeset: null, rejected: { reason: "existing-draft" } };
  }

  const graph = new Graph(doc);
  const evidence = open.map((p) => ({
    nodeId: p.nodeId,
    note: [
      p.note,
      graph.has(p.nodeId) ? `— rule text: "${learnedText(graph, p.nodeId)}"` : "",
      p.citation ? `— user said: "${p.citation.quote}"` : "— (inferred; no verified user quote)",
    ]
      .filter(Boolean)
      .join(" "),
    ...(p.citation ? { citation: p.citation } : {}),
  }));
  const outcome = await proposeAmendment(deps, doc, policy, "pressure", evidence);
  if (outcome.changeset) {
    const next = await getEngineState(deps);
    next.lastAmendProposedAt = nowIso(deps);
    await putEngineState(deps, next);
  }
  return outcome;
}

/** Edict path: an explicit identity instruction. Draft only. */
export async function proposeFromEdict(deps: MemoryDeps, doc: GraphDoc, instruction: string): Promise<ProposalOutcome> {
  const policy = resolvePolicy(doc);
  if (policy.transcendence.score <= 0 || policy.transcendence.amendableSlots.length === 0) {
    return { changeset: null, rejected: { reason: "disabled" } };
  }
  if ((await listAmendmentDrafts(deps)).length > 0) {
    return { changeset: null, rejected: { reason: "existing-draft" } };
  }
  const outcome = await proposeAmendment(deps, doc, policy, "edict", [{ note: `Identity edict: ${instruction}` }]);
  if (outcome.changeset) {
    const state = await getEngineState(deps);
    state.lastAmendProposedAt = nowIso(deps);
    await putEngineState(deps, state);
  }
  return outcome;
}

async function proposeAmendment(
  deps: MemoryDeps,
  doc: GraphDoc,
  policy: MemoryPolicy,
  source: "pressure" | "edict",
  evidence: Array<{ nodeId?: string; note: string }>
): Promise<ProposalOutcome> {
  const t = policy.transcendence;
  const graph = new Graph(doc);
  const root = rootId(graph);
  const slots = promptTemplate(graph.get(root))?.slots ?? {};
  const amendable = t.amendableSlots.filter((s) => typeof slots[s] === "string" && slots[s]!.length > 0);
  if (amendable.length === 0)
    return { changeset: null, rejected: { reason: "disabled", detail: "no amendable slots present" } };

  const schema = {
    type: "object",
    required: ["amendments", "label"],
    properties: {
      amendments: {
        type: "array",
        items: {
          type: "object",
          required: ["slot", "revisedText", "rationale"],
          properties: {
            slot: { type: "string", enum: amendable },
            revisedText: {
              type: "string",
              description: "The COMPLETE revised text for this slot — minimal change, identity preserved.",
            },
            rationale: { type: "string" },
          },
        },
      },
      label: { type: "string", description: "≤10-word summary of the amendment." },
    },
  };

  const text = [
    "You govern amendments to an AI agent's charter (its identity and standing philosophy). Amendments must be MINIMAL and CONSERVATIVE: preserve the existing identity, change only what the evidence genuinely requires. If the evidence does not justify amending the charter, return an empty amendments array.",
    "",
    "Current charter (only these slots may be amended):",
    ...amendable.map((s) => `--- ${s} ---\n${slots[s]}`),
    "",
    source === "pressure"
      ? "Evidence: learned rules that repeatedly conflict with this charter (the lived pattern has diverged from the stated philosophy):"
      : "Evidence: an explicit instruction from the user about the agent's identity:",
    ...evidence.map((e) => `- ${e.note}`),
  ].join("\n");

  if (!deps.llm.extract) throw new Error("proposeAmendment requires an LlmConnector with extract()");
  const draft = (await deps.llm.extract({ text, schema })) as AmendmentDraft;
  const amendments = (draft.amendments ?? []).filter(
    (a) => amendable.includes(a.slot) && a.revisedText?.trim() && a.revisedText.trim() !== slots[a.slot]
  );
  if (amendments.length === 0) return { changeset: null, rejected: { reason: "no-amendment" } };

  // drift cap: identity moves in small measurable steps or not at all
  const drift: Record<string, number> = {};
  for (const a of amendments) {
    drift[a.slot] = await driftSimilarity(deps, slots[a.slot]!, a.revisedText.trim());
  }

  // identity odometer: cumulative distance from the genesis charter (captured
  // on first contact) — per-step caps bound the step, this shows the journey
  const currentCharter = charterText(graph, root);
  const stateForGenesis = await getEngineState(deps);
  if (stateForGenesis.genesisCharter === null) {
    stateForGenesis.genesisCharter = currentCharter;
    await putEngineState(deps, stateForGenesis);
  }
  const genesis = stateForGenesis.genesisCharter;
  const proposedSlots: Partial<Record<Slot, string>> = { ...slots };
  for (const a of amendments) proposedSlots[a.slot] = a.revisedText.trim();
  const odometer = {
    before: await driftSimilarity(deps, genesis, currentCharter),
    after: await driftSimilarity(deps, genesis, charterFromSlots(proposedSlots)),
    reviewFloor: t.reviewFloor,
  };
  const ops: MutationOp[] = [
    {
      op: "updateNode",
      id: root,
      patch: {
        prompt: { slots: Object.fromEntries(amendments.map((a) => [a.slot, a.revisedText.trim()])) },
        props: { amendedAt: nowIso(deps), amendmentLabel: draft.label ?? "charter amendment" },
      },
    },
  ];
  const meta: AmendmentMeta = {
    kind: "amendment",
    source,
    label: draft.label ?? "charter amendment",
    rationale: amendments.map((a) => `${a.slot}: ${a.rationale}`).join(" · "),
    changes: Object.fromEntries(amendments.map((a) => [a.slot, { old: slots[a.slot]!, next: a.revisedText.trim() }])),
    drift,
    charterHash: charterHash(currentCharter),
    evidence,
    odometer,
  };
  let cs = createChangeset(doc, "amendment", `amend-${depNow(deps).toString(36)}`);
  cs = addOps(cs, ops);
  cs = { ...cs, createdAt: nowIso(deps) };

  const reject = async (reason: "drift" | "inversion", detail: string): Promise<ProposalOutcome> => {
    // kept on file for the audit trail: the system tried to move too far
    const rejected = { ...discardChangeset(cs), meta: { ...meta, rejected: { reason, detail } } };
    await deps.changesets.put(rejected);
    return { changeset: null, rejected: { reason, detail } };
  };

  const violation = Object.entries(drift).find(([, sim]) => sim < t.driftFloor);
  if (violation) {
    return reject(
      "drift",
      `${violation[0]} similarity ${violation[1]!.toFixed(2)} < floor ${t.driftFloor} (score ${t.score})`
    );
  }

  // semantic-inversion check: distance metrics underweight negation ("never
  // upsell" → "always upsell" is a tiny edit) — one focused verifier call
  // guards the failure mode the drift cap structurally cannot see
  const inversion = (await deps.llm.extract({
    text: [
      "Compare each ORIGINAL/REVISED pair. Does any revision NEGATE, INVERT, or reverse a commitment the original makes (e.g. 'never X' becoming 'X is fine')? Rewording and additions are not inversions.",
      ...amendments.map((a) => `--- ${a.slot} ---\nORIGINAL: ${slots[a.slot]}\nREVISED: ${a.revisedText.trim()}`),
    ].join("\n"),
    schema: {
      type: "object",
      required: ["inverts"],
      properties: {
        inverts: { type: "boolean" },
        note: { type: "string", description: "Which commitment gets inverted, if any." },
      },
    },
  })) as { inverts?: boolean; note?: string };
  if (inversion.inverts === true) {
    return reject("inversion", inversion.note ?? "revision inverts a charter commitment");
  }

  // validate (dry apply) so the draft is committable via the standard
  // lifecycle: apg_commit_changeset / commitChangeset behind the human gate
  cs = await validateChangeset(doc, { ...cs, meta: meta as unknown as Record<string, unknown> }, {});
  await deps.changesets.put(cs);
  return { changeset: cs };
}

/**
 * Charter-staleness re-check the host MUST run before committing an amendment
 * changeset: a draft whose charter moved underneath it never applies. Returns
 * the invalidated (discarded) changeset when stale, null when safe to commit.
 */
export async function revalidateAmendment(deps: MemoryDeps, cs: Changeset, freshDoc: GraphDoc): Promise<Changeset | null> {
  const meta = cs.meta as AmendmentMeta | undefined;
  if (meta?.kind !== "amendment") return null;
  const graph = new Graph(freshDoc);
  if (charterHash(charterText(graph, rootId(graph))) === meta.charterHash) return null;
  const invalidated = {
    ...discardChangeset(cs),
    meta: { ...meta, rejected: { reason: "invalidated", detail: "charter changed since drafting" } },
  };
  await deps.changesets.put(invalidated);
  return invalidated;
}

/** After a successful amendment commit: consume evidence, stamp lastAmendAt,
 * and advance the identity odometer (trail entry + live cumulative).
 * identityHash is left stale ON PURPOSE so the next sleep runs an
 * identity-aware (reconsolidation) review of all rules. */
export async function finalizeAmendment(deps: MemoryDeps, cs: Changeset): Promise<void> {
  const meta = cs.meta as AmendmentMeta | undefined;
  if (meta?.kind !== "amendment") return;
  const state = await getEngineState(deps);
  const evidenceIds = new Set(meta.evidence.map((e) => e.nodeId).filter(Boolean));
  state.pressure = state.pressure.map((p) =>
    p.status === "open" && evidenceIds.has(p.nodeId) ? { ...p, status: "consumed" as const } : p
  );
  state.lastAmendAt = nowIso(deps);

  // identity odometer: measure the committed charter against genesis
  const doc = await deps.store.load(deps.graphId);
  const graph = new Graph(doc);
  const charter = charterText(graph, rootId(graph));
  if (state.genesisCharter === null) state.genesisCharter = charter; // late capture: odometer starts here
  const cumulative = await driftSimilarity(deps, state.genesisCharter, charter);
  state.identityCumulative = cumulative;
  const { reviewFloor } = resolvePolicy(doc).transcendence;
  state.identityTrail = [
    ...state.identityTrail,
    {
      at: nowIso(deps),
      label: meta.label,
      stepDrift: meta.drift,
      cumulative,
      ...(cumulative < reviewFloor ? { reviewRecommended: true } : {}),
    },
  ];
  await putEngineState(deps, state);
}

/** Human rejection: charter stands, evidence dismissed (no instant re-proposal). */
export async function dismissAmendment(deps: MemoryDeps, cs: Changeset): Promise<Changeset> {
  const meta = cs.meta as AmendmentMeta | undefined;
  if (meta?.kind !== "amendment") throw new Error(`Changeset ${cs.id} is not an amendment proposal`);
  const state = await getEngineState(deps);
  const evidenceIds = new Set(meta.evidence.map((e) => e.nodeId).filter(Boolean));
  state.pressure = state.pressure.map((p) =>
    p.status === "open" && evidenceIds.has(p.nodeId) ? { ...p, status: "dismissed" as const } : p
  );
  await putEngineState(deps, state);
  const rejected = {
    ...discardChangeset(cs),
    meta: { ...meta, rejected: { reason: "human", detail: "rejected at the human gate" } },
  };
  await deps.changesets.put(rejected);
  return rejected;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i, ...new Array<number>(n)];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n]!;
}

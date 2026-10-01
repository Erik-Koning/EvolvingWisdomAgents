// The transcendence engine: governed evolution of the root charter (the
// agent's identity / life philosophy). Two proposal sources — accumulated
// philosophy-conflict pressure from sleep passes, and explicit identity
// edicts from feedback. Every proposal is a DRAFT changeset gated by:
// the transcendence score (which slots may amend at all), an embedding
// drift cap (identity moves in small, measurable steps), a cooldown, and
// mandatory human approval. The score never enables auto-commit.
import { Graph, applyChangeset, promptTemplate, type GraphDoc, type LlmConnector, type MutationOp } from "@apgraph/core";
import type { AgentConfig, AmendableSlot, MemoryPolicy } from "./agents";
import { getAgent, memoryPolicy } from "./agents";
import {
  getAgentState,
  getProposal,
  listProposals,
  loadAgentDocFresh,
  loadAgentGraph,
  putAgentState,
  putProposal,
  saveAgentDocUnlocked,
  withAgentLock,
  type AmendmentProposal,
} from "./store";
import { llm as defaultLlm, embeddingsConnector } from "./llm";
import { charterHash, charterText, learnedText } from "./wisdom";

export interface ProposalOutcome {
  proposal: AmendmentProposal | null;
  rejected?: {
    reason: "disabled" | "cooldown" | "existing-draft" | "drift" | "inversion" | "no-amendment";
    detail?: string;
  };
}

interface AmendmentDraft {
  amendments?: Array<{ slot: AmendableSlot; revisedText: string; rationale: string }>;
  label?: string;
}

/** Similarity between old and new charter text: cosine when a vector key is
 * bound; otherwise a normalized-Levenshtein proxy (documented as crude). */
export async function driftSimilarity(oldText: string, newText: string): Promise<number> {
  const embeddings = embeddingsConnector();
  if (embeddings) {
    const [a, b] = await embeddings.embed([oldText, newText]);
    return cosine(a!, b!);
  }
  return 1 - levenshtein(oldText, newText) / Math.max(oldText.length, newText.length, 1);
}

/** Pressure-path gate: called at the end of every sleep. Draft only. */
export async function maybeProposeFromPressure(
  agent: AgentConfig,
  doc: GraphDoc,
  policy: MemoryPolicy,
  llm: LlmConnector = defaultLlm,
): Promise<ProposalOutcome> {
  const t = policy.transcendence;
  if (t.score <= 0 || t.amendableSlots.length === 0) return { proposal: null, rejected: { reason: "disabled" } };
  const state = getAgentState(agent.id);
  const open = state.pressure.filter((p) => p.status === "open");
  if (open.length < t.pressureThreshold) return { proposal: null };
  const lastAmend = [state.lastAmendProposedAt, state.lastAmendAt]
    .filter((x): x is string => x !== null)
    .map(Date.parse)
    .sort((a, b) => b - a)[0];
  if (lastAmend !== undefined && Date.now() - lastAmend < t.cooldownMs) {
    return { proposal: null, rejected: { reason: "cooldown" } };
  }
  if (listProposals(agent.id, "draft").length > 0) {
    return { proposal: null, rejected: { reason: "existing-draft" } };
  }

  const graph = new Graph(doc);
  const evidence = open.map((p) => ({
    nodeId: p.nodeId,
    note: `${p.note}${graph.has(p.nodeId) ? ` — rule text: "${learnedText(graph, p.nodeId)}"` : ""}`,
  }));
  const outcome = await proposeAmendment(agent, doc, policy, "pressure", evidence, llm);
  if (outcome.proposal) {
    const next = getAgentState(agent.id);
    next.lastAmendProposedAt = new Date().toISOString();
    putAgentState(agent.id, next);
  }
  return outcome;
}

/** Edict path: an explicit identity instruction from feedback. Draft only. */
export async function proposeFromEdict(
  agent: AgentConfig,
  doc: GraphDoc,
  instruction: string,
  llm: LlmConnector = defaultLlm,
): Promise<ProposalOutcome> {
  const policy = memoryPolicy(agent, doc.meta);
  if (policy.transcendence.score <= 0 || policy.transcendence.amendableSlots.length === 0) {
    return { proposal: null, rejected: { reason: "disabled" } };
  }
  if (listProposals(agent.id, "draft").length > 0) {
    return { proposal: null, rejected: { reason: "existing-draft" } };
  }
  const outcome = await proposeAmendment(agent, doc, policy, "edict", [{ note: `Customer edict: ${instruction}` }], llm);
  if (outcome.proposal) {
    const state = getAgentState(agent.id);
    state.lastAmendProposedAt = new Date().toISOString();
    putAgentState(agent.id, state);
  }
  return outcome;
}

async function proposeAmendment(
  agent: AgentConfig,
  doc: GraphDoc,
  policy: MemoryPolicy,
  source: "pressure" | "edict",
  evidence: Array<{ nodeId?: string; note: string }>,
  llm: LlmConnector,
): Promise<ProposalOutcome> {
  const t = policy.transcendence;
  const graph = new Graph(doc);
  const root = graph.get(agent.rootId);
  const slots = promptTemplate(root)?.slots ?? {};
  const amendable = t.amendableSlots.filter((s) => typeof slots[s] === "string" && slots[s]!.length > 0);
  if (amendable.length === 0) return { proposal: null, rejected: { reason: "disabled", detail: "no amendable slots present" } };

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

  if (!llm.extract) throw new Error("proposeAmendment requires an LlmConnector with extract()");
  const draft = (await llm.extract({ text, schema })) as AmendmentDraft;
  const amendments = (draft.amendments ?? []).filter(
    (a) => amendable.includes(a.slot) && a.revisedText?.trim() && a.revisedText.trim() !== slots[a.slot],
  );
  if (amendments.length === 0) return { proposal: null, rejected: { reason: "no-amendment" } };

  // drift cap: identity moves in small measurable steps or not at all
  const drift: Record<string, number> = {};
  for (const a of amendments) {
    drift[a.slot] = await driftSimilarity(slots[a.slot]!, a.revisedText.trim());
  }
  const id = `amend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const changes = Object.fromEntries(
    amendments.map((a) => [a.slot, { old: slots[a.slot]!, next: a.revisedText.trim() }]),
  );
  const base: Omit<AmendmentProposal, "status"> = {
    id,
    agentId: agent.id,
    source,
    ops: [
      {
        op: "updateNode",
        id: agent.rootId,
        patch: {
          prompt: { slots: Object.fromEntries(amendments.map((a) => [a.slot, a.revisedText.trim()])) },
          props: { amendedAt: new Date().toISOString(), amendmentLabel: draft.label ?? "charter amendment" },
        },
      } satisfies MutationOp,
    ],
    changes,
    rationale: amendments.map((a) => `${a.slot}: ${a.rationale}`).join(" · "),
    label: draft.label ?? "charter amendment",
    evidence,
    drift,
    fromVersion: doc.version,
    charterHash: charterHash(charterText(graph, agent.rootId)),
    at: new Date().toISOString(),
  };

  const violation = Object.entries(drift).find(([, sim]) => sim < t.driftFloor);
  if (violation) {
    const rejected: AmendmentProposal = { ...base, status: "rejected", resolvedAt: new Date().toISOString() };
    putProposal(rejected); // kept for the audit trail: the system tried to move too far
    return {
      proposal: null,
      rejected: {
        reason: "drift",
        detail: `${violation[0]} similarity ${violation[1]!.toFixed(2)} < floor ${t.driftFloor} (score ${t.score})`,
      },
    };
  }

  // semantic-inversion check: distance metrics underweight negation ("never
  // upsell" → "always upsell" is a tiny edit) — one focused verifier call
  // guards the failure mode the drift cap structurally cannot see
  const inversion = (await llm.extract!({
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
    const rejected: AmendmentProposal = { ...base, status: "rejected", resolvedAt: new Date().toISOString() };
    putProposal(rejected);
    return {
      proposal: null,
      rejected: { reason: "inversion", detail: inversion.note ?? "revision inverts a charter commitment" },
    };
  }

  const proposal: AmendmentProposal = { ...base, status: "draft" };
  putProposal(proposal);
  return { proposal };
}

/** Human gate: apply the draft under lock, unless the charter moved since. */
export async function approveAmendment(id: string): Promise<AmendmentProposal> {
  const proposal = getProposal(id);
  if (!proposal || proposal.status !== "draft") throw new Error(`No draft proposal: ${id}`);
  const agent = getAgent(proposal.agentId);
  return withAgentLock(agent.id, async () => {
    const fresh = await loadAgentDocFresh(agent);
    const freshGraph = new Graph(fresh);
    if (charterHash(charterText(freshGraph, agent.rootId)) !== proposal.charterHash) {
      const invalidated: AmendmentProposal = { ...proposal, status: "invalidated", resolvedAt: new Date().toISOString() };
      putProposal(invalidated);
      return invalidated; // charter changed since drafting — conservative refusal
    }
    const next = applyChangeset(fresh, proposal.ops);
    await saveAgentDocUnlocked(agent, next, {
      actor: "amendment",
      summary: `charter amendment: ${proposal.label}`,
      expectedVersion: fresh.version,
    });
    const state = getAgentState(agent.id);
    const evidenceIds = new Set(proposal.evidence.map((e) => e.nodeId).filter(Boolean));
    state.pressure = state.pressure.map((p) =>
      p.status === "open" && evidenceIds.has(p.nodeId) ? { ...p, status: "consumed" } : p,
    );
    state.lastAmendAt = new Date().toISOString();
    // identityHash left stale ON PURPOSE: the next sleep detects the charter
    // change and runs an identity-aware (reconsolidation) review
    putAgentState(agent.id, state);
    const approved: AmendmentProposal = { ...proposal, status: "approved", resolvedAt: new Date().toISOString() };
    putProposal(approved);
    return approved;
  });
}

/** Human gate: charter stands, evidence dismissed (no instant re-proposal). */
export function rejectAmendment(id: string): AmendmentProposal {
  const proposal = getProposal(id);
  if (!proposal || proposal.status !== "draft") throw new Error(`No draft proposal: ${id}`);
  const state = getAgentState(proposal.agentId);
  const evidenceIds = new Set(proposal.evidence.map((e) => e.nodeId).filter(Boolean));
  state.pressure = state.pressure.map((p) =>
    p.status === "open" && evidenceIds.has(p.nodeId) ? { ...p, status: "dismissed" } : p,
  );
  putAgentState(proposal.agentId, state);
  const rejected: AmendmentProposal = { ...proposal, status: "rejected", resolvedAt: new Date().toISOString() };
  putProposal(rejected);
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

import type { GraphDoc, MutationOp, OpEvidence, PromptTemplate, Transcript } from "@apgraph/schema";

/**
 * The replay evidence gate — the pure half of the "preservation-biased replay"
 * policy (docs/library-roadmap.md): replay may freely add, refine-additively,
 * and reinforce, but an op that DEGRADES stored wisdom passes only with a
 * mechanically verified citation — a verbatim quote from a USER turn of a
 * stored transcript. Uncited degrades are dropped, never applied.
 *
 * Degrade classification over the op algebra:
 * - always degrading: deleteNode, pruneSubtree, mergeNodes, unlinkChoice,
 *   removeEdge, updateGraphConfig, updateRoutingConfig
 * - setBring: degrading iff the new array drops any id currently in the bring
 * - updateNode: degrading iff the patch nulls any key (at any depth) or
 *   replaces an existing prompt slot with strictly shorter text
 * - everything else (addNode, moveNode, graftSubtree, splitNode,
 *   reorderChildren, linkChoice, setEdge): additive
 *
 * Citation verification is mechanical, not model-trusted: the quote must
 * appear (whitespace-normalized, case-sensitive) inside the cited turn's
 * content AND that turn's role must be "user" — assistant turns carry no
 * degrade authority (the agent must not launder its own inferences).
 */
export interface EvidenceGateResult {
  kept: MutationOp[];
  /** Evidence for kept ops, with opIndex re-pointed at positions in `kept`. */
  evidence: OpEvidence[];
  dropped: Array<{ opIndex: number; op: MutationOp; reason: DropReason }>;
}

export type DropReason =
  | "no-citation"
  | "transcript-not-found"
  | "turn-out-of-range"
  | "not-user-turn"
  | "quote-not-found";

const ALWAYS_DEGRADING = new Set([
  "deleteNode",
  "pruneSubtree",
  "mergeNodes",
  "unlinkChoice",
  "removeEdge",
  "updateGraphConfig",
  "updateRoutingConfig",
]);

function slotTexts(prompt: string | PromptTemplate | undefined): Record<string, string> {
  if (prompt === undefined) return {};
  if (typeof prompt === "string") return { task: prompt };
  return { ...(prompt.slots as Record<string, string>) };
}

function patchNullsAnyKey(patch: unknown): boolean {
  if (patch === null) return true;
  if (Array.isArray(patch)) return false; // arrays replace wholesale; not a keyed deletion
  if (typeof patch !== "object") return false;
  return Object.values(patch as Record<string, unknown>).some((v) => patchNullsAnyKey(v));
}

/** Whether an op degrades stored wisdom, judged against the current doc. */
export function isDegradingOp(doc: GraphDoc, op: MutationOp): boolean {
  if (ALWAYS_DEGRADING.has(op.op)) return true;
  if (op.op === "setBring") {
    const node = doc.nodes.find((n) => n.id === op.id);
    const current = node?.bring ?? [];
    const next = new Set(op.bring);
    return current.some((id) => !next.has(id));
  }
  if (op.op === "updateNode") {
    if (patchNullsAnyKey(op.patch)) return true;
    const node = doc.nodes.find((n) => n.id === op.id);
    if (!node) return false; // dangling target fails at apply time, not here
    const patchPrompt = (op.patch as { prompt?: string | PromptTemplate }).prompt;
    if (patchPrompt === undefined) return false;
    const current = slotTexts(node.prompt);
    const next = slotTexts(patchPrompt);
    return Object.entries(next).some(([slot, text]) => {
      const existing = current[slot];
      return typeof existing === "string" && existing.length > 0 && text.length < existing.length;
    });
  }
  return false;
}

const normalizeWs = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Verify one citation against the transcripts. Returns null when it holds,
 * otherwise the most specific failure reason.
 */
export function verifyCitation(evidence: OpEvidence, transcripts: Transcript[]): DropReason | null {
  const transcript = transcripts.find((t) => t.id === evidence.transcriptId);
  if (!transcript) return "transcript-not-found";
  const turn = transcript.turns[evidence.turnIndex];
  if (!turn) return "turn-out-of-range";
  if (turn.role !== "user") return "not-user-turn";
  if (!normalizeWs(turn.content).includes(normalizeWs(evidence.quote))) return "quote-not-found";
  return null;
}

/**
 * Filter a replay op batch through the evidence gate. Additive ops always
 * pass; degrading ops pass only with at least one verified citation. Evidence
 * rows for kept ops are re-indexed to positions in the kept array so the
 * result is self-consistent for changeset assembly.
 */
export function applyEvidenceGate(
  doc: GraphDoc,
  ops: MutationOp[],
  evidence: OpEvidence[] = [],
  transcripts: Transcript[] = []
): EvidenceGateResult {
  const kept: MutationOp[] = [];
  const keptEvidence: OpEvidence[] = [];
  const dropped: EvidenceGateResult["dropped"] = [];

  ops.forEach((op, opIndex) => {
    const citations = evidence.filter((e) => e.opIndex === opIndex);
    if (!isDegradingOp(doc, op)) {
      const at = kept.length;
      kept.push(op);
      keptEvidence.push(...citations.map((e) => ({ ...e, opIndex: at })));
      return;
    }
    if (citations.length === 0) {
      dropped.push({ opIndex, op, reason: "no-citation" });
      return;
    }
    let reason: DropReason = "no-citation";
    const verified = citations.filter((e) => {
      const failure = verifyCitation(e, transcripts);
      if (failure) reason = failure;
      return failure === null;
    });
    if (verified.length === 0) {
      dropped.push({ opIndex, op, reason });
      return;
    }
    const at = kept.length;
    kept.push(op);
    keptEvidence.push(...verified.map((e) => ({ ...e, opIndex: at })));
  });

  return { kept, evidence: keptEvidence, dropped };
}

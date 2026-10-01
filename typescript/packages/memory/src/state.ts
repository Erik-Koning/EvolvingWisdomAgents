// Engine maintenance state, persisted via AgentStateStoreConnector keyed by
// graphId. Deliberately OUTSIDE doc.meta: sleep stamps must never churn graph
// versions or race user CAS writes.
import { StoreConflictError, applyChangeset, type GraphDoc, type MutationOp } from "@apgraph/core";
import { depLock, depNow, emitAudit, type AuditEntry, type MemoryDeps } from "./deps.js";

/** A mechanically verified user-turn quote corroborating a philosophy
 * conflict — same authority rule as the replay evidence gate: the quote must
 * appear verbatim in a USER turn of the cited transcript. */
export interface LedgerCitation {
  transcriptId: string;
  turnIndex: number;
  quote: string;
}

export interface LedgerEntry {
  nodeId: string;
  note: string;
  at: string;
  status: "open" | "consumed" | "dismissed";
  /** Present when the conflict is corroborated by a verified user quote. */
  citation?: LedgerCitation;
  /** True when no citation could be verified — weighs inferredWeight. */
  inferred?: boolean;
}

/** Weighted pressure: cited entries weigh 1, uncited weigh `inferredWeight`
 * (entries predating the citation pass count as inferred). */
export function weighPressure(entries: LedgerEntry[], inferredWeight: number): number {
  return entries.reduce((sum, e) => sum + (e.citation ? 1 : inferredWeight), 0);
}

/** One committed amendment on the identity odometer's trail. */
export interface IdentityTrailEntry {
  at: string;
  label: string;
  /** Per-slot step similarity, from the amendment's drift cap. */
  stepDrift: Record<string, number>;
  /** similarity(genesis charter, charter after this step) — the odometer. */
  cumulative: number;
  /** Cumulative fell below policy.transcendence.reviewFloor. */
  reviewRecommended?: boolean;
}

export interface EngineState {
  lastSleepAt: string | null;
  lastSleepSummary: string | null;
  identityHash: string | null;
  lastAmendProposedAt: string | null;
  lastAmendAt: string | null;
  pressure: LedgerEntry[];
  /** Charter text at first engine contact — the odometer's fixed origin
   * (best-effort: pre-existing deployments capture on their next pass). */
  genesisCharter: string | null;
  /** Live odometer: similarity(genesis, current charter); null until known. */
  identityCumulative: number | null;
  /** One entry per committed amendment — the identity odometer's trail. */
  identityTrail: IdentityTrailEntry[];
}

const DEFAULT_STATE: EngineState = {
  lastSleepAt: null,
  lastSleepSummary: null,
  identityHash: null,
  lastAmendProposedAt: null,
  lastAmendAt: null,
  pressure: [],
  genesisCharter: null,
  identityCumulative: null,
  identityTrail: [],
};

export async function getEngineState(deps: MemoryDeps): Promise<EngineState> {
  const stored = await deps.state.getState(deps.graphId);
  // structuredClone: DEFAULT_STATE's arrays must never be shared mutable state
  return { ...structuredClone(DEFAULT_STATE), ...(stored ?? {}) } as EngineState;
}

export async function putEngineState(deps: MemoryDeps, state: EngineState): Promise<void> {
  await deps.state.putState(deps.graphId, state as unknown as Record<string, unknown>);
}

export const nowIso = (deps: MemoryDeps): string => new Date(depNow(deps)).toISOString();

/**
 * Commit ops through the safe-write layer: under the engine lock, load fresh,
 * apply, CAS-save, audit. `retry: true` is user-write semantics (re-apply once
 * against the current doc when the base moved); `retry: false` is maintenance
 * semantics (StoreConflictError propagates — the user's write wins).
 */
export async function commitOps(
  deps: MemoryDeps,
  baseVersion: string | undefined,
  ops: MutationOp[],
  meta: { actor: AuditEntry["actor"]; summary: string; retry: boolean }
): Promise<GraphDoc> {
  return depLock(deps)(deps.graphId, async () => {
    const fresh = await deps.store.load(deps.graphId);
    if (fresh.version !== baseVersion && !meta.retry) {
      throw new StoreConflictError(
        `graph ${deps.graphId} moved from ${baseVersion} to ${fresh.version} — maintenance write aborted`
      );
    }
    const next = applyChangeset(fresh, ops);
    await deps.store.save(next, { expectedVersion: fresh.version ?? null });
    emitAudit(deps, {
      actor: meta.actor,
      fromVersion: fresh.version ?? null,
      toVersion: next.version ?? null,
      summary: meta.summary,
    });
    return next;
  });
}

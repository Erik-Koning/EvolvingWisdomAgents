// Everything the engine touches arrives through this bag — no module state,
// no process.env, no filesystem. Hosts wire Memory* stores for tests and
// File*/DB stores for real deployments.
import type {
  AgentStateStoreConnector,
  ChangesetStoreConnector,
  EmbeddingsConnector,
  GraphStoreConnector,
  LlmConnector,
  TranscriptStoreConnector,
} from "@apgraph/core";

export interface AuditEntry {
  actor: "harvest" | "feedback" | "sleep" | "replay" | "amendment" | "manual";
  graphId: string;
  fromVersion: string | null;
  toVersion: string | null;
  summary: string;
  at: string;
}

export interface MemoryDeps {
  /** The graph this engine instance operates on (also keys the agent state). */
  graphId: string;
  store: GraphStoreConnector;
  llm: LlmConnector;
  embeddings?: EmbeddingsConnector;
  transcripts: TranscriptStoreConnector;
  changesets: ChangesetStoreConnector;
  state: AgentStateStoreConnector;
  /** Serializes writers per key. Defaults to an in-process promise-chain lock. */
  lock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  /** Called once per committed write (audit trail is the host's to persist). */
  audit?: (entry: AuditEntry) => void;
  /** Injectable clock (ms since epoch) so tests are deterministic. */
  now?: () => number;
}

const lockTails = new Map<string, Promise<unknown>>();

/** Default in-process lock: per-key promise chain (NOT cross-process). */
export async function inProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = lockTails.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  lockTails.set(
    key,
    run.catch(() => undefined)
  );
  return run;
}

export const depLock = (deps: MemoryDeps) => deps.lock ?? inProcessLock;
export const depNow = (deps: MemoryDeps) => (deps.now ?? Date.now)();

export function emitAudit(deps: MemoryDeps, entry: Omit<AuditEntry, "graphId" | "at">): void {
  deps.audit?.({ ...entry, graphId: deps.graphId, at: new Date(depNow(deps)).toISOString() });
}

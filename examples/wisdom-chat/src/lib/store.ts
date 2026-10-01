import "./env";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { FileChangesetStore, FileGraphStore } from "@apgraph/connectors";
import {
  Graph,
  StoreConflictError,
  applyChangeset,
  normalizeDocument,
  type FeedbackEvent,
  type GraphDoc,
  type MutationOp,
} from "@apgraph/core";
import { getAgent, type AgentConfig, type AgentId, type ContextMode } from "./agents";

// Paths are functions (env-overridable) so tests can point the whole store at
// a temp directory before use.
function dataDir(): string {
  return process.env.WISDOM_DATA_DIR ?? join(process.cwd(), "data");
}
function sessionsDir(): string {
  return join(dataDir(), "sessions");
}
function stateDir(): string {
  return join(dataDir(), "state");
}
function proposalsDir(): string {
  return join(dataDir(), "proposals");
}
function templatesDir(): string {
  return process.env.WISDOM_TEMPLATES_DIR ?? join(process.cwd(), "..", "..", "templates");
}

const stores = new Map<string, FileGraphStore>();
export function graphStore(): FileGraphStore {
  const dir = dataDir();
  let store = stores.get(dir);
  if (!store) {
    store = new FileGraphStore(dir);
    stores.set(dir, store);
  }
  return store;
}

const csStores = new Map<string, FileChangesetStore>();
/** Lifecycle changesets (growth proposals live here as drafts). */
export function changesetStore(): FileChangesetStore {
  const dir = dataDir();
  let store = csStores.get(dir);
  if (!store) {
    store = new FileChangesetStore(dir);
    csStores.set(dir, store);
  }
  return store;
}

export interface ContextStats {
  mode: ContextMode;
  nodeCount: number;
  chars: number;
  matched: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  /** Categories the router matched this message to (user messages only). */
  routedTo?: Array<{ nodeId: string; title?: string; confidence: number }>;
  /** Tools the agent invoked producing this reply (assistant messages, langgraph engine). */
  toolCalls?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** How the system prompt was built for this reply (assistant messages). */
  contextStats?: ContextStats;
}

export interface ChatSession {
  id: string;
  agentId: AgentId;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
  /** Messages before this index have already been harvested. */
  lastHarvestIndex: number;
  contextMode?: ContextMode;
  /** Auto-sleeps up to this timestamp have been surfaced to this session's UI. */
  lastSleepAckAt?: string;
  ended: boolean;
  learned: Array<{ nodeId: string; fact: string; categoryId: string; at: string }>;
}

// ---- safe-write layer: per-agent lock + app-level CAS + audit ----

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export type Actor = "harvest" | "feedback" | "sleep" | "amendment" | "manual";

const lockTails = new Map<string, Promise<unknown>>();

/** Serialize all graph writes for one agent in-process. NOT reentrant. */
export function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockTails.get(agentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  lockTails.set(agentId, run.catch(() => {}));
  return run;
}

interface AuditEntry {
  actor: Actor;
  agentId: string;
  fromVersion: string | undefined;
  toVersion: string | undefined;
  summary: string;
  at: string;
}

function appendAudit(entry: AuditEntry): void {
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(join(dataDir(), "audit.jsonl"), JSON.stringify(entry) + "\n");
}

// version-keyed materialized-graph cache: avoids re-parse/normalize/index per request
const graphCache = new Map<string, { version: string; doc: GraphDoc; graph: Graph }>();

function cacheKey(agent: AgentConfig): string {
  return `${dataDir()}::${agent.graphId}`;
}

/** Latest stored doc, bypassing the cache (for CAS checks). Seeds on first run. */
export async function loadAgentDocFresh(agent: AgentConfig): Promise<GraphDoc> {
  try {
    return await graphStore().load(agent.graphId);
  } catch {
    const seed = JSON.parse(readFileSync(join(templatesDir(), agent.seedFile), "utf8")) as GraphDoc;
    const doc = normalizeDocument(seed);
    await graphStore().save(doc);
    return doc;
  }
}

/** Latest doc + materialized Graph for an agent (cached by version). */
export async function loadAgentGraph(agent: AgentConfig): Promise<{ doc: GraphDoc; graph: Graph }> {
  const cached = graphCache.get(cacheKey(agent));
  const doc = await loadAgentDocFresh(agent);
  const version = doc.version ?? "0";
  if (cached && cached.version === version) return { doc: cached.doc, graph: cached.graph };
  const graph = new Graph(doc);
  graphCache.set(cacheKey(agent), { version, doc, graph });
  return { doc, graph };
}

interface SaveOptions {
  actor: Actor;
  summary: string;
  /** CAS: reject when the stored version no longer matches. */
  expectedVersion?: string;
}

/** Unlocked save+CAS+audit — call ONLY inside withAgentLock. */
export async function saveAgentDocUnlocked(agent: AgentConfig, doc: GraphDoc, opts: SaveOptions): Promise<void> {
  try {
    // CAS is delegated to the store contract (library-level, connector-native)
    await graphStore().save(
      doc,
      opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {},
    );
  } catch (err) {
    if (err instanceof StoreConflictError) throw new ConflictError(err.message);
    throw err;
  }
  graphCache.delete(cacheKey(agent));
  appendAudit({
    actor: opts.actor,
    agentId: agent.id,
    fromVersion: opts.expectedVersion,
    toVersion: doc.version,
    summary: opts.summary,
    at: new Date().toISOString(),
  });
}

/** Locked save: version check + write + cache invalidation + audit, atomically vs other writers. */
export async function saveAgentDoc(agent: AgentConfig, doc: GraphDoc, opts: SaveOptions): Promise<void> {
  return withAgentLock(agent.id, () => saveAgentDocUnlocked(agent, doc, opts));
}

/**
 * Commit a set of ops with user-writes-win semantics: apply against the FRESH
 * doc inside the lock; if the base moved and retry is false → ConflictError
 * (maintenance aborts); with retry (user-initiated, re-runnable ops) the ops
 * re-apply against whatever is current. Returns the committed doc.
 */
export async function commitOps(
  agent: AgentConfig,
  expectedVersion: string | undefined,
  ops: MutationOp[],
  opts: { actor: Actor; summary: string; retry: boolean },
): Promise<GraphDoc> {
  return withAgentLock(agent.id, async () => {
    const fresh = await loadAgentDocFresh(agent);
    if (expectedVersion !== undefined && fresh.version !== expectedVersion && !opts.retry) {
      throw new ConflictError(`graph ${agent.graphId} moved: expected ${expectedVersion}, found ${fresh.version}`);
    }
    const next = applyChangeset(fresh, ops);
    await saveAgentDocUnlocked(agent, next, {
      actor: opts.actor,
      summary: opts.summary,
      expectedVersion: fresh.version,
    });
    return next;
  });
}

export async function listAgentVersions(agent: AgentConfig): Promise<string[]> {
  return graphStore().listVersions(agent.graphId);
}

export async function loadAgentVersion(agent: AgentConfig, version: string): Promise<GraphDoc> {
  return graphStore().load(agent.graphId, version);
}

// ---- agent runtime state (separate from the portable graph) ----

export interface LedgerEntry {
  nodeId: string;
  note: string;
  at: string;
  status: "open" | "consumed" | "dismissed";
}

export interface AgentState {
  lastSleepAt: string | null;
  lastSleepSummary: string | null;
  identityHash: string | null;
  lastAmendProposedAt: string | null;
  lastAmendAt: string | null;
  pressure: LedgerEntry[];
}

const DEFAULT_STATE: AgentState = {
  lastSleepAt: null,
  lastSleepSummary: null,
  identityHash: null,
  lastAmendProposedAt: null,
  lastAmendAt: null,
  pressure: [],
};

function statePath(agentId: string): string {
  return join(stateDir(), `${agentId}.json`);
}

export function getAgentState(agentId: string): AgentState {
  const path = statePath(agentId);
  if (!existsSync(path)) return { ...DEFAULT_STATE, pressure: [] };
  return { ...DEFAULT_STATE, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<AgentState>) };
}

export function putAgentState(agentId: string, state: AgentState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(agentId), JSON.stringify(state, null, 2) + "\n");
}

// ---- amendment proposals (draft changesets, never auto-applied) ----

export interface AmendmentProposal {
  id: string;
  agentId: AgentId;
  source: "pressure" | "edict";
  ops: MutationOp[];
  /** slot → { old, new } for the review UI. */
  changes: Record<string, { old: string; next: string }>;
  rationale: string;
  label: string;
  evidence: Array<{ nodeId?: string; note: string }>;
  drift: Record<string, number>;
  fromVersion: string | undefined;
  charterHash: string;
  status: "draft" | "approved" | "rejected" | "invalidated";
  at: string;
  resolvedAt?: string;
}

function proposalPath(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid proposal id: ${id}`);
  return join(proposalsDir(), `${id}.json`);
}

export function putProposal(p: AmendmentProposal): void {
  mkdirSync(proposalsDir(), { recursive: true });
  writeFileSync(proposalPath(p.id), JSON.stringify(p, null, 2) + "\n");
}

export function getProposal(id: string): AmendmentProposal | null {
  const path = proposalPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as AmendmentProposal;
}

export function listProposals(agentId?: AgentId, status?: AmendmentProposal["status"]): AmendmentProposal[] {
  if (!existsSync(proposalsDir())) return [];
  return readdirSync(proposalsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(proposalsDir(), f), "utf8")) as AmendmentProposal)
    .filter((p) => (agentId === undefined || p.agentId === agentId) && (status === undefined || p.status === status))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---- detail event logs (audit.jsonl is the unified mutation ledger) ----

export function recordFeedbackEvent(event: FeedbackEvent): void {
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(join(dataDir(), "feedback.jsonl"), JSON.stringify(event) + "\n");
}

export function recordConsolidationEvent(entry: Record<string, unknown>): void {
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(join(dataDir(), "consolidations.jsonl"), JSON.stringify(entry) + "\n");
}

// ---- chat sessions (plain JSON files) ----

function sessionPath(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
  return join(sessionsDir(), `${id}.json`);
}

export function createSession(agentId: AgentId): ChatSession {
  mkdirSync(sessionsDir(), { recursive: true });
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const session: ChatSession = {
    id,
    agentId,
    title: "New chat",
    createdAt: new Date().toISOString(),
    messages: [],
    lastHarvestIndex: 0,
    ended: false,
    learned: [],
  };
  saveSession(session);
  return session;
}

export function getSession(id: string): ChatSession | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  const session = JSON.parse(readFileSync(path, "utf8")) as ChatSession;
  session.agentId = getAgent(session.agentId).id; // legacy sessions default to sage
  return session;
}

export function saveSession(session: ChatSession): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2) + "\n");
}

export function listSessions(agentId?: AgentId): Array<Pick<ChatSession, "id" | "agentId" | "title" | "createdAt" | "ended">> {
  if (!existsSync(sessionsDir())) return [];
  return readdirSync(sessionsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(sessionsDir(), f), "utf8")) as ChatSession)
    .map((s) => ({ ...s, agentId: getAgent(s.agentId).id }))
    .filter((s) => agentId === undefined || s.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, agentId: aid, title, createdAt, ended }) => ({ id, agentId: aid, title, createdAt, ended }));
}

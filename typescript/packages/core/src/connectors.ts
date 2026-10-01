import type {
  Changeset,
  ComposedPrompt,
  GraphDoc,
  GraphLayer,
  JsonSchemaFragment,
  ModelHints,
  RoutingMatch,
  SessionState,
  Transcript,
  TranscriptTurn,
  UserOverlay,
  FeedbackEvent,
} from "@apgraph/schema";

// ---- driver interfaces (the OS analogy: connectors are drivers) ----

export interface LlmConnector {
  classify(input: {
    query: string;
    outline: string;
    schema: JsonSchemaFragment;
    multi: boolean;
    hints?: ModelHints;
  }): Promise<RoutingMatch[]>;
  /** Structured extraction for opportunistic fill. Returns extracted vars. */
  extract?(input: {
    text: string;
    schema: JsonSchemaFragment;
  }): Promise<Record<string, unknown>>;
  /** Deterministic token counting; kernel falls back to ceil(codepoints/4). */
  countTokens?(text: string): number;
  generate?(input: {
    prompt: ComposedPrompt;
    query: string;
    /** Prior turns for multi-turn chat, oldest first; query is the new user turn. */
    history?: ChatTurn[];
  }): Promise<{ text: string }>;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EmbeddingsConnector {
  embed(texts: string[]): Promise<number[][]>;
}

/** CAS violation on save: the stored latest no longer matches expectations. */
export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export interface SaveOptions {
  /**
   * Compare-and-swap: a string must equal the stored latest's version;
   * null means the graph must not exist yet (create-only). Violations throw
   * StoreConflictError. Omit for unconditional save.
   */
  expectedVersion?: string | null;
}

export interface GraphStoreConnector {
  load(graphId: string, version?: string): Promise<GraphDoc>;
  save(doc: GraphDoc, opts?: SaveOptions): Promise<void>;
  listVersions(graphId: string): Promise<string[]>;
}

export interface ChangesetStoreConnector {
  put(cs: Changeset): Promise<void>;
  get(id: string): Promise<Changeset | null>;
  list(graphId?: string, status?: Changeset["status"]): Promise<Changeset[]>;
}

export class MemoryChangesetStore implements ChangesetStoreConnector {
  private items = new Map<string, Changeset>();
  async put(cs: Changeset): Promise<void> {
    this.items.set(cs.id, structuredClone(cs));
  }
  async get(id: string): Promise<Changeset | null> {
    const cs = this.items.get(id);
    return cs ? structuredClone(cs) : null;
  }
  async list(graphId?: string, status?: Changeset["status"]): Promise<Changeset[]> {
    void graphId; // Changeset carries baseGraphVersion, not graphId — hosts filter via convention
    return [...this.items.values()]
      .filter((c) => status === undefined || c.status === status)
      .map((c) => structuredClone(c));
  }
}

export interface LayerStoreConnector {
  putLayer(layer: GraphLayer): Promise<void>;
  getLayer(layerId: string): Promise<GraphLayer | null>;
  listLayers(graphId: string, scope?: GraphLayer["scope"]): Promise<GraphLayer[]>;
  deleteLayer(layerId: string): Promise<void>;
}

export class MemoryLayerStore implements LayerStoreConnector {
  private layers = new Map<string, GraphLayer>();
  async putLayer(layer: GraphLayer): Promise<void> {
    this.layers.set(layer.layerId, structuredClone(layer));
  }
  async getLayer(layerId: string): Promise<GraphLayer | null> {
    const layer = this.layers.get(layerId);
    return layer ? structuredClone(layer) : null;
  }
  async listLayers(graphId: string, scope?: GraphLayer["scope"]): Promise<GraphLayer[]> {
    return [...this.layers.values()]
      .filter((l) => l.baseGraphId === graphId && (scope === undefined || l.scope === scope))
      .map((l) => structuredClone(l));
  }
  async deleteLayer(layerId: string): Promise<void> {
    this.layers.delete(layerId);
  }
}

export interface SessionStoreConnector {
  get(id: string): Promise<SessionState | null>;
  put(s: SessionState): Promise<void>;
}

export interface TranscriptStoreConnector {
  put(t: Transcript): Promise<void>;
  get(id: string): Promise<Transcript | null>;
  list(graphId?: string): Promise<Transcript[]>;
  /** Appends turns, creating the transcript if missing. Returns the updated transcript. */
  appendTurns(id: string, turns: TranscriptTurn[]): Promise<Transcript>;
}

export class MemoryTranscriptStore implements TranscriptStoreConnector {
  private items = new Map<string, Transcript>();
  async put(t: Transcript): Promise<void> {
    this.items.set(t.id, structuredClone(t));
  }
  async get(id: string): Promise<Transcript | null> {
    const t = this.items.get(id);
    return t ? structuredClone(t) : null;
  }
  async list(graphId?: string): Promise<Transcript[]> {
    return [...this.items.values()]
      .filter((t) => graphId === undefined || t.graphId === graphId)
      .map((t) => structuredClone(t));
  }
  async appendTurns(id: string, turns: TranscriptTurn[]): Promise<Transcript> {
    const existing = this.items.get(id) ?? { id, turns: [] };
    existing.turns = [...existing.turns, ...turns.map((t) => structuredClone(t))];
    this.items.set(id, existing);
    return structuredClone(existing);
  }
}

/** Small KV home for maintenance state (pressure ledger, lastSleepAt, identityHash) — kept OUT of doc.meta so sleep stamps never churn graph versions or race user CAS writes. */
export interface AgentStateStoreConnector {
  getState(agentId: string): Promise<Record<string, unknown> | null>;
  putState(agentId: string, state: Record<string, unknown>): Promise<void>;
}

export class MemoryAgentStateStore implements AgentStateStoreConnector {
  private items = new Map<string, Record<string, unknown>>();
  async getState(agentId: string): Promise<Record<string, unknown> | null> {
    const s = this.items.get(agentId);
    return s ? structuredClone(s) : null;
  }
  async putState(agentId: string, state: Record<string, unknown>): Promise<void> {
    this.items.set(agentId, structuredClone(state));
  }
}

export interface MemoryConnector {
  recall(userId: string, query: string): Promise<Record<string, unknown>>;
  remember?(userId: string, facts: Record<string, unknown>): Promise<void>;
  recallOverlay?(userId: string, path: string[]): Promise<UserOverlay[]>;
  recordFeedback?(ev: FeedbackEvent): Promise<void>;
}

export interface ToolsConnector {
  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: unknown }>;
  list(): Promise<Array<{ name: string; description?: string }>>;
}

export interface HandoffConnector {
  open(ticket: { nodeId: string; queue?: string; vars: Record<string, unknown>; draft?: string }): Promise<{ ticketId: string }>;
}

export interface TelemetryConnector {
  event(name: string, attrs: Record<string, unknown>): void;
}

export interface Connectors {
  llm?: LlmConnector;
  embeddings?: EmbeddingsConnector;
  store?: GraphStoreConnector;
  session?: SessionStoreConnector;
  transcripts?: TranscriptStoreConnector;
  state?: AgentStateStoreConnector;
  memory?: MemoryConnector;
  tools?: ToolsConnector;
  handoff?: HandoffConnector;
  telemetry?: TelemetryConnector;
}

// ---- host registry ("driver missing" is a load error, per the OS analogy) ----

type ConnectorFactory = (config: Record<string, unknown>) => unknown;
const registry = new Map<string, ConnectorFactory>();

export function registerConnector(name: string, factory: ConnectorFactory): void {
  registry.set(name, factory);
}

export function bindConnectors(doc: GraphDoc): Connectors {
  const bound: Record<string, unknown> = {};
  for (const [role, decl] of Object.entries(doc.connectors ?? {})) {
    if (decl.use === "none") continue;
    const factory = registry.get(decl.use);
    if (!factory) throw new Error(`Driver missing: no connector registered for "${decl.use}" (role "${role}")`);
    bound[role] = factory(decl.config ?? {});
  }
  return bound as Connectors;
}

// ---- shipped in-memory/mock implementations ----

/** Scripted classifier/extractor/generator: consumes queued responses in order (fixtures). */
export class ScriptedLlm implements LlmConnector {
  private classifyQueue: RoutingMatch[][];
  private extractQueue: Array<Record<string, unknown>>;
  private generateQueue: string[];
  constructor(
    script: {
      classify?: Array<{ matches: RoutingMatch[] }>;
      extract?: Array<{ vars: Record<string, unknown> }>;
      generate?: string[];
    } = {},
  ) {
    this.classifyQueue = (script.classify ?? []).map((c) => c.matches);
    this.extractQueue = (script.extract ?? []).map((e) => e.vars);
    this.generateQueue = [...(script.generate ?? [])];
  }
  async classify(): Promise<RoutingMatch[]> {
    const next = this.classifyQueue.shift();
    if (!next) throw new Error("ScriptedLlm: classify queue exhausted");
    return next;
  }
  async extract(): Promise<Record<string, unknown>> {
    const next = this.extractQueue.shift();
    if (!next) throw new Error("ScriptedLlm: extract queue exhausted");
    return next;
  }
  async generate(): Promise<{ text: string }> {
    const next = this.generateQueue.shift();
    if (next === undefined) throw new Error("ScriptedLlm: generate queue exhausted");
    return { text: next };
  }
}

/** Exact-text → vector map. A missing text is a fixture bug and raises. */
export class MapEmbeddings implements EmbeddingsConnector {
  constructor(private vectors: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = this.vectors[t];
      if (!v) throw new Error(`MapEmbeddings: no vector for text: ${JSON.stringify(t)}`);
      return v;
    });
  }
}

/** Scripted tools connector keyed by tool name. */
export class ScriptedTools implements ToolsConnector {
  constructor(private responses: Record<string, { ok: boolean; result: unknown }>) {}
  async call(name: string): Promise<{ ok: boolean; result: unknown }> {
    const r = this.responses[name];
    if (!r) throw new Error(`ScriptedTools: no scripted response for tool: ${name}`);
    return r;
  }
  async list() {
    return Object.keys(this.responses).map((name) => ({ name }));
  }
}

export class MemorySessionStore implements SessionStoreConnector {
  private sessions = new Map<string, SessionState>();
  async get(id: string): Promise<SessionState | null> {
    return this.sessions.get(id) ?? null;
  }
  async put(s: SessionState): Promise<void> {
    this.sessions.set(s.sessionId, s);
  }
}

export class MemoryGraphStore implements GraphStoreConnector {
  private docs = new Map<string, Map<string, GraphDoc>>();
  async load(graphId: string, version?: string): Promise<GraphDoc> {
    const versions = this.docs.get(graphId);
    if (!versions || versions.size === 0) throw new Error(`MemoryGraphStore: unknown graph ${graphId}`);
    if (version) {
      const doc = versions.get(version);
      if (!doc) throw new Error(`MemoryGraphStore: unknown version ${version} of ${graphId}`);
      return doc;
    }
    return [...versions.values()][versions.size - 1]!;
  }
  async save(doc: GraphDoc, opts: SaveOptions = {}): Promise<void> {
    if (opts.expectedVersion !== undefined) {
      const versions = this.docs.get(doc.graphId);
      const latest = versions && versions.size > 0 ? [...versions.values()][versions.size - 1]!.version : undefined;
      if (opts.expectedVersion === null && latest !== undefined) {
        throw new StoreConflictError(`graph ${doc.graphId} already exists (latest ${latest})`);
      }
      if (opts.expectedVersion !== null && latest !== opts.expectedVersion) {
        throw new StoreConflictError(
          `graph ${doc.graphId} moved: expected ${opts.expectedVersion}, found ${latest}`,
        );
      }
    }
    const versions = this.docs.get(doc.graphId) ?? new Map<string, GraphDoc>();
    // delete-then-set so "latest" is always the most recently saved, even
    // when re-saving an existing version key (Map keeps first-insert order)
    versions.delete(doc.version ?? "0");
    versions.set(doc.version ?? "0", structuredClone(doc));
    this.docs.set(doc.graphId, versions);
  }
  async listVersions(graphId: string): Promise<string[]> {
    return [...(this.docs.get(graphId)?.keys() ?? [])];
  }
}

/** Pinned token-count fallback: ceil(Unicode code points / 4). */
export function countTokensFallback(text: string): number {
  return Math.ceil([...text].length / 4);
}

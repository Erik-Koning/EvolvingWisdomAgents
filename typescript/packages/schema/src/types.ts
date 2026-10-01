// Projection of /schema/apg.schema.json (normative). Keep 1:1 with the JSON
// Schema and with python/packages/apg-core/src/apg_core/types.py.

export type NodeId = string;
export type JsonSchemaFragment = Record<string, unknown>;

export type NodeType = "category" | "decision" | "action" | "answer";

export const SLOTS = [
  "persona",
  "task",
  "constraints",
  "knowledge",
  "examples",
  "outputFormat",
  "queryRewrite",
] as const;
export type Slot = (typeof SLOTS)[number];

/** Slots a contextOnly bring / user overlay may contribute to. */
export const CONTEXT_ONLY_SLOTS: readonly Slot[] = ["knowledge", "constraints", "examples"];

export type MergeMode = "override" | "prepend" | "append" | "merge";

export interface PromptTemplate {
  slots: Partial<Record<Slot, string>>;
  variables?: VariableSpec[];
  format?: "mustache" | "f-string";
}

export interface CompositionRule {
  mode?: Partial<Record<Slot, MergeMode>>;
  defaultMode?: MergeMode;
  priority?: number;
}

export interface VariableSpec {
  name: string;
  required: boolean;
  default?: string;
  source?: "user" | "session" | "tenant" | "memory";
  schema?: JsonSchemaFragment;
  elicitationPrompt?: string;
}

export interface DecisionChoice {
  label: string;
  value: string;
  next: NodeId;
}

export interface DecisionSpec {
  question: string;
  saveAs?: string;
  choices: DecisionChoice[];
  freeform?: { classifyInto: NodeId[] };
  guard?: string;
  timeoutNext?: NodeId;
}

export interface ActionSpec {
  tool: string;
  args?: Record<string, unknown>;
  argsFromVars?: string[];
  onSuccess: NodeId;
  onError: NodeId;
  resultSchema?: JsonSchemaFragment;
  saveResultAs?: string;
}

export interface EscalationPolicy {
  mode: "none" | "suggest" | "draft" | "require";
  queue?: string;
  sla?: { firstResponseMins?: number };
  collectBeforeHandoff?: VariableSpec[];
  escalateBelowConfidence?: number;
  resumeNode?: NodeId;
}

export interface NodeMetadata {
  version?: string;
  author?: string;
  updatedAt?: string;
  evalScore?: number;
  avgTokenCost?: number;
  modelCompatibility?: string[];
  status?: "draft" | "staging" | "production" | "pruned";
  tenantId?: string;
  tags?: string[];
}

export interface ModelHints {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ApgNode {
  id: NodeId;
  slug?: string;
  parentId: NodeId | null;
  type: NodeType;
  title?: string;
  description?: string;
  aliases?: string[];
  props?: Record<string, unknown>;
  routingOverride?: { descriptor?: string[]; embedText?: string[] };
  routable?: boolean;
  /** Pinned nodes are protected from removal ops (delete/prune/merge-victim) unless forced. */
  pinned?: boolean;

  prompt?: string | PromptTemplate;
  composition?: CompositionRule;
  fewShot?: Array<{ input: string; output: string }>;
  outputSchema?: JsonSchemaFragment;

  bring?: NodeId[];
  recursiveBring?: boolean;
  bringMode?: "full" | "contextOnly";
  maxBringDepth?: number;

  decision?: DecisionSpec;
  action?: ActionSpec;
  escalation?: EscalationPolicy;
  collect?: VariableSpec[];
  fillPolicy?: "explicit" | "opportunistic";
  entryCondition?: string;
  exitCondition?: string;
  visitPolicy?: "once" | "repeatable" | "loopUntilValid";
  skipCondition?: string;
  fallbackNodeId?: NodeId;
  isFallback?: boolean;

  toolAllowlist?: string[];
  modelOverride?: ModelHints;

  embedding?: number[];
  metadata?: NodeMetadata;
}

export type EdgeKind = "child" | "seeAlso" | "aliasOf" | "bring" | "choice" | "fallback";

export interface Edge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
}

export type Profile = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

/**
 * Opt-in embedding fast path: when the shortlist's top similarity is decisive
 * (≥ minSimilarity, and ahead of the runner-up by ≥ minMargin), routing skips
 * the LLM classify call entirely and returns that single match with reason
 * "embedding" and confidence = cosine similarity. minConfidence governs only
 * the classify path; the bypass has its own two gates.
 */
export interface EmbedBypass {
  minSimilarity: number;
  minMargin: number;
}

export interface RoutingDefaults {
  minConfidence?: number;
  allowMulti?: boolean;
  shortlistK?: number;
  descriptor?: string[];
  embedText?: string[];
  embedBypass?: EmbedBypass | null;
}

export interface GraphDefaults {
  composition?: CompositionRule;
  routing?: RoutingDefaults;
  budget?: { maxPromptTokens?: number };
  model?: ModelHints;
}

export interface ConnectorDecl {
  use: string;
  config?: Record<string, unknown>;
}

export interface GraphDoc {
  $schema?: string;
  schemaVersion: string;
  graphId: string;
  version?: string;
  profile?: Profile;
  meta?: { title?: string; tenantId?: string; tags?: string[]; [k: string]: unknown };
  defaults?: GraphDefaults;
  connectors?: Record<string, ConnectorDecl>;
  variables?: VariableSpec[];
  $include?: string[];
  edges?: Edge[];
  nodes: ApgNode[];
}

// ---- runtime results ----

export interface RoutingMatch {
  nodeId: NodeId;
  confidence: number;
  reason?: string;
}

export interface RoutingResult {
  matches: RoutingMatch[];
  strategy: "single" | "multi";
  fallbackUsed: boolean;
  broughtNodes?: NodeId[];
  shortlist?: NodeId[];
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheHit?: boolean;
}

export interface ComposedPrompt {
  slots: Partial<Record<Slot, string>>;
  text: string;
  /** Nodes with at least one surviving fragment, in first-contribution order (usage telemetry). */
  contributors: NodeId[];
  rewrittenQuery?: string;
  truncated: Array<{ nodeId: NodeId; slot: Slot }>;
  unresolved: Array<{ nodeId: NodeId; variable: string }>;
  outputSchema?: JsonSchemaFragment;
  modelHints?: ModelHints;
  toolAllowlist?: string[];
}

export interface SessionState {
  sessionId: string;
  mode: "routing" | "walking" | "awaitingHuman";
  currentNodeId?: NodeId;
  vars: Record<string, unknown>;
  visited: Record<NodeId, number>;
  pendingHuman?: { ticketId: string; nodeId: NodeId; since: string };
  stepCount: number;
  history?: Array<{ at: string; nodeId: NodeId; event: string }>;
}

export interface UserOverlay {
  userId: string;
  nodeId: NodeId;
  digest: Partial<Record<"constraints" | "knowledge" | "examples", string>>;
  evidence: { feedbackCount: number; lastAt: string };
  version: string;
}

export interface FeedbackEvent {
  userId: string;
  sessionId: string;
  nodeId: NodeId;
  routingResultId?: string;
  signal: "thumbsUp" | "thumbsDown" | "taskSuccess" | "taskFail" | "evalScore";
  score?: number;
  comment?: string;
  at: string;
}

// ---- mutation algebra ----

export type MutationOp =
  | { op: "addNode"; parentId: NodeId; node: ApgNode; position?: number }
  | { op: "updateNode"; id: NodeId; patch: Record<string, unknown> }
  | { op: "moveNode"; id: NodeId; newParentId: NodeId; position?: number }
  | { op: "deleteNode"; id: NodeId; orphans: "cascade" | "reparent"; force?: boolean }
  | { op: "pruneSubtree"; id: NodeId; force?: boolean }
  | { op: "graftSubtree"; parentId: NodeId; nodes: ApgNode[] }
  | { op: "mergeNodes"; ids: NodeId[]; intoId: NodeId; force?: boolean }
  | { op: "splitNode"; id: NodeId; partitions: Array<{ node: ApgNode; takes: string[] }> }
  | { op: "reorderChildren"; parentId: NodeId; order: NodeId[] }
  | { op: "setBring"; id: NodeId; bring: NodeId[]; recursiveBring?: boolean }
  | { op: "linkChoice"; decisionId: NodeId; choice: DecisionChoice }
  | { op: "unlinkChoice"; decisionId: NodeId; value: string }
  | { op: "setEdge"; edge: Edge }
  | { op: "removeEdge"; edge: Edge }
  | { op: "updateGraphConfig"; patch: Partial<Pick<GraphDoc, "defaults" | "variables" | "meta">> }
  | { op: "updateRoutingConfig"; patch: { descriptor?: string[]; embedText?: string[] } };

// ---- routing regression (the evolution brake system) ----

export interface LabeledQuery {
  query: string;
  /** The node this query must route to (within topK). */
  expected: NodeId;
}

export interface RegressionReport {
  total: number;
  passed: number;
  /** passed/total; 1 when total is 0. */
  passRate: number;
  failed: Array<{ query: string; expected: NodeId; got: NodeId | null; confidence?: number }>;
  /** Failures whose winner is one of the changeset's focus nodes (traffic steal). */
  stolen: Array<{ query: string; expected: NodeId; stolenBy: NodeId }>;
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: NodeId;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface Changeset {
  id: string;
  baseGraphVersion: string;
  ops: MutationOp[];
  status: "draft" | "validated" | "approved" | "committed" | "discarded";
  createdBy: string;
  validation?: ValidationReport;
  regression?: Record<string, unknown>;
  /** Per-op citations backing degrading ops (see OpEvidence / the replay evidence gate). */
  evidence?: OpEvidence[];
  /** Open extension point (amendment proposals store drift/charterHash/rationale here). */
  meta?: Record<string, unknown>;
  createdAt?: string;
}

/** One turn of a recorded conversation. `meta` is an open bag for app extras (tool calls, routing badges). */
export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
  at?: string;
  meta?: Record<string, unknown>;
}

/**
 * A durably stored conversation — the raw-episode source for wake-path harvest
 * and offline replay. Watermarks are turn counts: turns[i] for i < mark are done.
 */
export interface Transcript {
  id: string;
  graphId?: string;
  agentId?: string;
  title?: string;
  createdAt?: string;
  turns: TranscriptTurn[];
  /** Turns below this index have been distilled by wake-path harvest. */
  harvestedUpTo?: number;
  /** Turns below this index have been re-processed by replay. */
  replayedUpTo?: number;
  ended?: boolean;
}

/**
 * A citation attached to one op of a changeset. The evidence gate verifies the
 * quote appears verbatim (whitespace-normalized) in the cited turn AND that the
 * turn is a USER turn — degrading ops without a verified citation are dropped.
 */
export interface OpEvidence {
  opIndex: number;
  quote: string;
  transcriptId: string;
  turnIndex: number;
}

export interface LayerConflict {
  opIndex: number;
  reason: string;
  droppedAt: string;
}

export interface GraphLayer {
  layerId: string;
  baseGraphId: string;
  baseVersion: string;
  scope: "tenant" | "user" | "session";
  ownerId: string;
  ops: MutationOp[];
  version: string;
  conflicts?: LayerConflict[];
}

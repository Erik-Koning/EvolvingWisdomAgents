export * from "@apgraph/schema";

export { Graph, nodeField, promptTemplate, ROUTING_DEFAULTS, RESERVED_KEYS } from "./graph.js";
export { loadGraph, normalizeDocument, materializeEdges } from "./loader.js";
export type { LoadOptions } from "./loader.js";
export { serializeOutline, embedText, cleanText } from "./outline.js";
export { evalExpr, evalCondition, parseExpr } from "./expr.js";
export { route } from "./router.js";
export type { RouteOptions } from "./router.js";
export { resolveBring } from "./bring.js";
export type { BringResolution } from "./bring.js";
export { compose, mergeVars } from "./compose.js";
export type { ComposeOptions } from "./compose.js";
export { sessionStep, newSession } from "./session.js";
export type { SessionInput, SessionEffect, StepResult } from "./session.js";
export { validateGraph, detectRequiredProfile } from "./validator.js";
export {
  applyOp,
  applyChangeset,
  createChangeset,
  materializeLayers,
  rebaseLayer,
  loadWithLayers,
  bumpVersion,
  routeCacheKey,
  deepMergeInto,
} from "./mutation.js";
export type { MaterializeResult } from "./mutation.js";
export {
  addOps,
  approveChangeset,
  changesetFocusNodes,
  commitChangeset,
  discardChangeset,
  validateChangeset,
} from "./lifecycle.js";
export type { ValidateChangesetOptions } from "./lifecycle.js";
export { miniValidate } from "./minischema.js";
export { findNodes, listPropertyKeys } from "./search.js";
export type { FindNodesOptions } from "./search.js";
export { precomputeEmbeddings } from "./embed.js";
export type { PrecomputeOptions } from "./embed.js";
export { evalRouting, assertRegression, labeledFromMeta } from "./regress.js";
export type { EvalRoutingOptions } from "./regress.js";
export { cosineSimilarity, clusterBySimilarity, medoid, buildSplitOps } from "./evolve.js";
export type { ClusterOptions, SplitGroup } from "./evolve.js";
export { applyEvidenceGate, isDegradingOp, verifyCitation } from "./replay-gate.js";
export type { EvidenceGateResult, DropReason } from "./replay-gate.js";
export {
  registerConnector,
  bindConnectors,
  StoreConflictError,
  MemoryChangesetStore,
  MemoryLayerStore,
  MemoryTranscriptStore,
  MemoryAgentStateStore,
  ScriptedLlm,
  MapEmbeddings,
  ScriptedTools,
  MemorySessionStore,
  MemoryGraphStore,
  countTokensFallback,
} from "./connectors.js";
export type {
  ChatTurn,
  Connectors,
  LlmConnector,
  EmbeddingsConnector,
  GraphStoreConnector,
  SaveOptions,
  ChangesetStoreConnector,
  LayerStoreConnector,
  SessionStoreConnector,
  TranscriptStoreConnector,
  AgentStateStoreConnector,
  MemoryConnector,
  ToolsConnector,
  HandoffConnector,
  TelemetryConnector,
} from "./connectors.js";

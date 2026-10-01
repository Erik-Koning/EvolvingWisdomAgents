export { inProcessLock } from "./deps.js";
export type { AuditEntry, MemoryDeps } from "./deps.js";
export { defaultPolicy, resolvePolicy, transcendencePolicy } from "./policy.js";
export type {
  AmendableSlot,
  GrowthPolicy,
  MemoryPolicy,
  PolicyOverride,
  ReplayPolicy,
  SleepPolicy,
  TranscendencePolicy,
} from "./policy.js";
export {
  bagOfWordsVectors,
  bringOps,
  categories,
  charterFromSlots,
  charterHash,
  charterText,
  existingLearnings,
  learnedText,
  learningLine,
  removalOps,
  rootId,
  saveLearningOps,
  storeSlot,
  uniqueId,
} from "./ops.js";
export { commitOps, getEngineState, putEngineState, weighPressure } from "./state.js";
export type { EngineState, IdentityTrailEntry, LedgerCitation, LedgerEntry } from "./state.js";
export { buildConsolidationOps, citeConflict, consolidateCategory, consolidationStatus, runSleep } from "./sleep.js";
export type { CategoryReview, CategorySummary, SleepOptions, SleepResult } from "./sleep.js";
export { maybeGrow } from "./grow.js";
export type { GrowthResult } from "./grow.js";
export { runReplay } from "./replay.js";
export type { ReplayOptions, ReplayReport } from "./replay.js";
export {
  dismissAmendment,
  driftSimilarity,
  finalizeAmendment,
  listAmendmentDrafts,
  maybeProposeFromPressure,
  proposeFromEdict,
  revalidateAmendment,
} from "./transcend.js";
export type { AmendmentMeta, ProposalOutcome } from "./transcend.js";
export { digestFeedback, harvestTurns } from "./digest.js";
export type { FeedbackResult, HarvestResult } from "./digest.js";

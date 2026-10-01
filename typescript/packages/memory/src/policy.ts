// Tunable dials with orchestrated defaults. The graph is the portable
// program, so a graph tunes its own memory behavior via doc.meta.memory;
// hosts pass code-level overrides on top when they must.
import type { GraphDoc } from "@apgraph/core";

export type AmendableSlot = "persona" | "task" | "constraints";

export interface SleepPolicy {
  /** Rules per category before consolidation qualifies. */
  threshold: number;
  /** Minimum gap between automatic sleeps (manual bypasses). */
  cooldownMs: number;
}

export interface GrowthPolicy {
  /** Misfit-pool residents before deep sleep considers a split. */
  min: number;
  /** Single-link cosine threshold with real embeddings. */
  semanticThreshold: number;
  /** Single-link cosine threshold for the bag-of-words fallback. */
  lexicalThreshold: number;
  /** Smallest cluster worth naming. */
  minSize: number;
}

export interface TranscendencePolicy {
  /** 0 = the charter is a constitution; 1 = identity is just slow memory. */
  score: number;
  /** Root slots amendment proposals may touch (derived from score). */
  amendableSlots: AmendableSlot[];
  /** Weighted open pressure required before a pressure proposal fires. */
  pressureThreshold: number;
  /** Minimum similarity(old, new) per amended slot — the drift cap. */
  driftFloor: number;
  /** Minimum gap between amendment proposals/commits. */
  cooldownMs: number;
  /**
   * Weight of an uncorroborated (inferred) pressure entry toward the
   * threshold; entries with a verified user-turn citation weigh 1. Model-only
   * inference must be more sustained to petition the charter.
   */
  inferredWeight: number;
  /**
   * Identity-odometer band: when similarity(genesis charter, current charter)
   * falls below this, a constitutional review is flagged — surfaced to the
   * human, never blocking. Per-step movement stays bounded by driftFloor.
   */
  reviewFloor: number;
}

export interface ReplayPolicy {
  /** Max turns fed to one replay extract call (long transcripts are chunked). */
  windowTurns: number;
}

export interface MemoryPolicy {
  sleep: SleepPolicy;
  growth: GrowthPolicy;
  transcendence: TranscendencePolicy;
  replay: ReplayPolicy;
}

/** Cited conflicts weigh 1; uncorroborated inference weighs half by default. */
const INFERRED_WEIGHT = 0.5;
/** Default identity-odometer band for the constitutional-review flag. */
const REVIEW_FLOOR = 0.5;

/** Derive the transcendence dials from the headline score (each overridable). */
export function transcendencePolicy(score: number, cooldownMs = 900_000): TranscendencePolicy {
  const s = Math.min(1, Math.max(0, score));
  const inferredWeight = INFERRED_WEIGHT;
  const reviewFloor = REVIEW_FLOOR;
  const shared = { cooldownMs, inferredWeight, reviewFloor };
  if (s === 0) return { score: s, amendableSlots: [], pressureThreshold: Infinity, driftFloor: 1, ...shared };
  if (s <= 0.34)
    return { score: s, amendableSlots: ["constraints"], pressureThreshold: 8, driftFloor: 0.9, ...shared };
  if (s <= 0.67)
    return { score: s, amendableSlots: ["constraints", "task"], pressureThreshold: 5, driftFloor: 0.7, ...shared };
  return {
    score: s,
    amendableSlots: ["constraints", "task", "persona"],
    pressureThreshold: 3,
    driftFloor: 0.5,
    ...shared,
  };
}

export function defaultPolicy(): MemoryPolicy {
  return {
    sleep: { threshold: 6, cooldownMs: 600_000 },
    growth: { min: 6, semanticThreshold: 0.75, lexicalThreshold: 0.35, minSize: 3 },
    transcendence: transcendencePolicy(0),
    replay: { windowTurns: 40 },
  };
}

/**
 * Effective policy: defaults ⊕ doc.meta.memory ⊕ host override. A
 * transcendence.score override re-derives the dials before explicit
 * per-dial overrides land on top.
 */
export function resolvePolicy(doc: GraphDoc, override: PolicyOverride = {}): MemoryPolicy {
  const base = defaultPolicy();
  const meta = ((doc.meta ?? {})["memory"] ?? {}) as PolicyOverride;
  return [meta, override].reduce<MemoryPolicy>((acc, layer) => {
    const score = layer.transcendence?.score;
    const transcendence = {
      ...(score !== undefined ? transcendencePolicy(score, acc.transcendence.cooldownMs) : acc.transcendence),
      ...layer.transcendence,
    };
    return {
      sleep: { ...acc.sleep, ...layer.sleep },
      growth: { ...acc.growth, ...layer.growth },
      transcendence,
      replay: { ...acc.replay, ...layer.replay },
    };
  }, base);
}

export type PolicyOverride = Partial<{
  sleep: Partial<SleepPolicy>;
  growth: Partial<GrowthPolicy>;
  transcendence: Partial<TranscendencePolicy>;
  replay: Partial<ReplayPolicy>;
}>;

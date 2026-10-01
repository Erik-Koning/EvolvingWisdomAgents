// Agent registry: each agent is its own wisdom graph + engine. Sage learns by
// transcript harvest; the repair shop is a LangGraph agent tuned by explicit
// feedback. Context mode decides how the graph becomes the system prompt:
// "full" = compose the root (recursive brings = everything), "routed" = the
// per-message routing result picks the branches (root rides along as a
// secondary target so root-anchored global preferences still load).
export type AgentId = "sage" | "shop";
export type ContextMode = "full" | "routed";

export type AmendableSlot = "constraints" | "task" | "persona";

export interface SleepPolicy {
  /** Rules per category before consolidation qualifies. */
  threshold: number;
  /** Bedtime trigger: consolidate after a session ends. */
  onSessionEnd: boolean;
  /** Sleep-pressure trigger: consolidate after this much idle time (null = off). */
  idleMs: number | null;
  /** Minimum gap between automatic sleeps (manual bypasses). */
  cooldownMs: number;
}

export interface TranscendencePolicy {
  /** 0 = the charter is a constitution; 1 = identity is just slow memory. */
  score: number;
  /** Root slots amendment proposals may touch (derived from score). */
  amendableSlots: AmendableSlot[];
  /** Open philosophy-conflicts required before a pressure proposal fires. */
  pressureThreshold: number;
  /** Minimum cosine(old, new) per amended slot — the drift cap. */
  driftFloor: number;
  /** Minimum gap between amendment proposals/commits. */
  cooldownMs: number;
}

export interface MemoryPolicy {
  sleep: SleepPolicy;
  transcendence: TranscendencePolicy;
}

/** Derive the transcendence dials from the headline score (each overridable). */
export function transcendencePolicy(score: number): TranscendencePolicy {
  const s = Math.min(1, Math.max(0, score));
  const cooldownMs = envMs("AMEND_COOLDOWN_MS") ?? 900_000;
  if (s === 0) return { score: s, amendableSlots: [], pressureThreshold: Infinity, driftFloor: 1, cooldownMs };
  if (s <= 0.34) return { score: s, amendableSlots: ["constraints"], pressureThreshold: 8, driftFloor: 0.9, cooldownMs };
  if (s <= 0.67) return { score: s, amendableSlots: ["constraints", "task"], pressureThreshold: 5, driftFloor: 0.7, cooldownMs };
  return { score: s, amendableSlots: ["constraints", "task", "persona"], pressureThreshold: 3, driftFloor: 0.5, cooldownMs };
}

function envMs(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function defaultSleepPolicy(): SleepPolicy {
  return {
    threshold: 6,
    onSessionEnd: true,
    idleMs: envMs("SLEEP_IDLE_MS") ?? 120_000,
    cooldownMs: envMs("SLEEP_COOLDOWN_MS") ?? 600_000,
  };
}

/**
 * Effective policy: agent defaults ⊕ graph meta.memory overrides (the graph is
 * the portable program, so a graph may tune its own memory behavior).
 */
export function memoryPolicy(agent: AgentConfig, meta?: Record<string, unknown>): MemoryPolicy {
  const base: MemoryPolicy = {
    sleep: defaultSleepPolicy(),
    transcendence: transcendencePolicy(agent.transcendence),
  };
  const override = (meta?.["memory"] ?? {}) as Partial<{
    sleep: Partial<SleepPolicy>;
    transcendence: Partial<TranscendencePolicy> & { score?: number };
  }>;
  const score = override.transcendence?.score;
  const transcendence = {
    ...(score !== undefined ? transcendencePolicy(score) : base.transcendence),
    ...override.transcendence,
  };
  return {
    sleep: { ...base.sleep, ...override.sleep },
    transcendence,
  };
}

export interface AgentConfig {
  id: AgentId;
  label: string;
  graphId: string;
  seedFile: string;
  rootId: string;
  engine: "native" | "langgraph";
  /** Transcript harvest cadence; null = feedback-driven only. */
  harvestEvery: number | null;
  defaultContextMode: ContextMode;
  supportsFeedback: boolean;
  /** Headline transcendence score (0..1); dials derive via transcendencePolicy. */
  transcendence: number;
}

export const AGENTS: Record<AgentId, AgentConfig> = {
  sage: {
    id: "sage",
    label: "Sage",
    graphId: "wisdom-profile",
    seedFile: "wisdom-profile.apg.json",
    rootId: "wisdom",
    engine: "native",
    harvestEvery: 5,
    defaultContextMode: "full",
    supportsFeedback: false,
    transcendence: 0.6,
  },
  shop: {
    id: "shop",
    label: "Repair Shop",
    graphId: "repair-shop",
    seedFile: "repair-shop.apg.json",
    rootId: "shop",
    engine: "langgraph",
    harvestEvery: null,
    defaultContextMode: "routed",
    supportsFeedback: true,
    transcendence: 0.1,
  },
};

export function getAgent(id: string | undefined | null): AgentConfig {
  const agent = AGENTS[(id ?? "sage") as AgentId];
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

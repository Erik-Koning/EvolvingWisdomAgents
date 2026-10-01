// Chat pipeline, per agent: route the message (badges + selective context),
// compose the system prompt from that agent's wisdom graph, generate (native
// Anthropic or LangGraph engine), and harvest on the agent's cadence.
import { compose, route, type ChatTurn } from "@apgraph/core";
import { getAgent, type AgentConfig, type AgentId, type ContextMode } from "./agents";
import {
  createSession,
  getAgentState,
  getSession,
  loadAgentGraph,
  saveSession,
  type ChatSession,
  type ContextStats,
} from "./store";
import { llm, routingConnectors } from "./llm";
import { shopReply } from "./shop-agent";
import { categories, harvest, type HarvestResult } from "./wisdom";

export interface ReplyResult {
  session: ChatSession;
  reply: string;
  routedTo: Array<{ nodeId: string; title?: string; confidence: number }>;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  contextStats: ContextStats;
  harvested: HarvestResult | null;
  /** An automatic sleep ran between messages — surface it once. */
  autoSleep: string | null;
}

export async function reply(
  agentId: AgentId,
  sessionId: string | undefined,
  message: string,
  contextModeOverride?: ContextMode,
): Promise<ReplyResult> {
  const agent = getAgent(agentId);
  const session = sessionId ? getSession(sessionId) : createSession(agent.id);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  if (session.ended) throw new Error("Session has ended — start a new chat");
  if (session.agentId !== agent.id) throw new Error(`Session belongs to agent ${session.agentId}`);
  if (contextModeOverride) session.contextMode = contextModeOverride;

  const { graph } = await loadAgentGraph(agent);

  // 1. route: which categories does this message touch? (badges + retrieval)
  const routing = await route(message, graph, { connectors: routingConnectors() });
  const routedTo = routing.fallbackUsed
    ? []
    : routing.matches.map((m) => ({
        nodeId: m.nodeId,
        title: graph.get(m.nodeId).title,
        confidence: m.confidence,
      }));

  // 2. compose the system prompt.
  //    "routed": matched categories carry the context; the root rides along as
  //    a secondary target so root-anchored global preferences still load
  //    (fixtures 56/57 pin both sides of that rule).
  //    "full": root as primary PLUS every category as a secondary target — a
  //    true superset. Root's own brings cover only global preferences (they
  //    must, for routed selectivity), so task-anchored rules only compose in
  //    full mode by targeting the categories themselves (known-concerns #1).
  const mode: ContextMode = session.contextMode ?? agent.defaultContextMode;
  const targets =
    mode === "routed" && routedTo.length > 0
      ? [...routing.matches.map((m) => m.nodeId), agent.rootId]
      : [agent.rootId, ...categories(graph)];
  const composed = compose(graph, targets);
  const contextStats: ContextStats = {
    mode,
    nodeCount: composed.contributors.length,
    chars: composed.text.length,
    matched: routedTo.map((r) => r.nodeId),
  };

  // 3. generate via the agent's engine
  let text: string;
  let toolCalls: ReplyResult["toolCalls"] = [];
  if (agent.engine === "langgraph") {
    const result = await shopReply(composed, session.messages, message);
    text = result.text;
    toolCalls = result.toolCalls;
  } else {
    const history: ChatTurn[] = session.messages.map((m) => ({ role: m.role, content: m.content }));
    text = (await llm.generate({ prompt: composed, query: message, history })).text;
  }

  const now = new Date().toISOString();
  session.messages.push({ role: "user", content: message, at: now, routedTo });
  session.messages.push({ role: "assistant", content: text, at: new Date().toISOString(), toolCalls, contextStats });
  if (session.title === "New chat") {
    session.title = message.length > 40 ? `${message.slice(0, 40)}…` : message;
  }

  // 4. transcript harvest on the agent's cadence (feedback-driven agents skip)
  let harvested: HarvestResult | null = null;
  if (agent.harvestEvery !== null && session.messages.length - session.lastHarvestIndex >= agent.harvestEvery) {
    harvested = await runHarvest(agent, session);
  }

  // 5. surface any automatic sleep that ran since this session last heard
  //    about one (baseline = session creation, so pre-session sleeps stay quiet)
  const state = getAgentState(agent.id);
  let autoSleep: string | null = null;
  const ackBase = session.lastSleepAckAt ?? session.createdAt;
  if (state.lastSleepAt && state.lastSleepAt > ackBase) {
    autoSleep = state.lastSleepSummary;
    session.lastSleepAckAt = state.lastSleepAt;
  }

  saveSession(session);
  return { session, reply: text, routedTo, toolCalls, contextStats, harvested, autoSleep };
}

export async function endSession(sessionId: string): Promise<{ session: ChatSession; harvested: HarvestResult | null }> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  const agent = getAgent(session.agentId);
  let harvested: HarvestResult | null = null;
  if (!session.ended) {
    if (agent.harvestEvery !== null) harvested = await runHarvest(agent, session);
    session.ended = true;
    saveSession(session);
  }
  return { session, harvested };
}

async function runHarvest(agent: AgentConfig, session: ChatSession): Promise<HarvestResult | null> {
  const { doc, graph } = await loadAgentGraph(agent);
  const result = await harvest(agent, session, doc, graph);
  session.lastHarvestIndex = session.messages.length;
  if (result) {
    const at = new Date().toISOString();
    session.learned.push(...result.learned.map((l) => ({ ...l, at })));
  }
  return result;
}


// The ⚖ Compare benchmark engine: the same vet-clinic chatbot run two ways.
//
// - monolith: one prebuilt mega system prompt (persona + policies + ALL
//   knowledge) — zero library calls in the request path. buildMonolith() is a
//   plain flattener, deliberately independent of compose(), so this arm is
//   genuinely "no library"; deriving it from the same template guarantees
//   content parity.
// - graph: route(user message) via one classify call, then compose(matched
//   categories + root) — the scoped prompt. The routing call's latency IS the
//   library's measured cost and is reported separately.
//
// Everything else is identical: same LangGraph agent, same VET_MODEL, same
// tools, same shared history. The graph here is READ-ONLY — no harvest,
// feedback, or sleep ever runs on this page (benchmark purity).
import "./env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Graph,
  compose,
  countTokensFallback,
  normalizeDocument,
  precomputeEmbeddings,
  promptTemplate,
  route,
  type Connectors,
  type GraphDoc,
} from "@apgraph/core";
import { AnthropicLlm } from "@apgraph/connectors";
import { embeddingsConnector, routingConnectors } from "./llm";
import { costUsd } from "./pricing";
import { vetAgentRunner, type CompareRunner } from "./compare-agent";
import {
  createCompareSession,
  getCompareSession,
  saveCompareSession,
  type CompareMetrics,
  type CompareMode,
  type CompareSession,
} from "./compare-store";

const TEMPLATE_FILE = "vet-clinic.apg.json";

// Routing gets its own SMALL classify model: route() uses whatever the
// connector instance defaults to, so a dedicated Haiku instance cuts the
// route call from ~3.5s (Sonnet) to well under 1.5s — no library changes.
// Generation still uses VET_MODEL (Sonnet) identically in both arms. The
// per-call onUsage sink makes routing cost MEASURED, not estimated; and when
// an embeddings connector is bound, the template's routing.embedBypass lets a
// decisive shortlist top-1 skip the classify call entirely (reason
// "embedding" on the match).
export const ROUTING_MODEL = "claude-haiku-4-5-20251001";

interface RouteUsage {
  inputTokens: number;
  outputTokens: number;
}

function fastRoutingConnectors(sink: RouteUsage): ReturnType<typeof routingConnectors> {
  const llm = new AnthropicLlm({
    model: ROUTING_MODEL,
    onUsage: (u) => {
      sink.inputTokens += u.inputTokens;
      sink.outputTokens += u.outputTokens;
    },
  });
  return { ...routingConnectors(), llm };
}

function templatesDir(): string {
  return process.env["WISDOM_TEMPLATES_DIR"] ?? join(process.cwd(), "..", "..", "templates");
}

interface VetBench {
  doc: GraphDoc;
  graph: Graph;
  monolith: string;
  rootId: string;
}

let cached: VetBench | null = null;

export function loadVetBench(): VetBench {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(templatesDir(), TEMPLATE_FILE), "utf8")) as GraphDoc;
  const doc = normalizeDocument(raw);
  const graph = new Graph(doc);
  const root = graph.dfs().find((n) => n.parentId === null);
  if (!root) throw new Error("vet-clinic template has no root node");
  cached = { doc, graph, monolith: buildMonolith(graph), rootId: root.id };
  return cached;
}

// One-time in-memory embedding precompute (only when an embeddings connector
// is bound): stored node vectors mean each route embeds ONLY the query, and
// the template's routing.embedBypass can then skip the classify call outright.
let embeddingsReady: Promise<void> | null = null;

function ensureVetEmbeddings(): Promise<void> {
  embeddingsReady ??= (async () => {
    const embeddings = embeddingsConnector();
    if (!embeddings || !cached) return;
    try {
      const vectored = await precomputeEmbeddings(cached.doc, embeddings);
      if (vectored !== cached.doc) {
        cached.doc = vectored;
        cached.graph = new Graph(vectored);
      }
    } catch {
      /* embeddings are an optimization — routing still works without them */
    }
  })();
  return embeddingsReady;
}

/** Test hook: drop the cache (e.g. after switching WISDOM_TEMPLATES_DIR). */
export function resetVetBench(): void {
  cached = null;
  embeddingsReady = null;
}

/** Every slot's text in canonical order — exhaustive so monolith/graph
 * content parity is structural, not dependent on which slots authors used. */
const SLOT_ORDER = ["persona", "task", "knowledge", "constraints", "examples"] as const;

function allSlotTexts(graph: Graph, id: string): string[] {
  const slots = promptTemplate(graph.get(id))?.slots ?? {};
  return SLOT_ORDER.map((s) => slots[s]).filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * Flatten the whole graph into one master system prompt — plain markdown,
 * independent of compose(): headers per category, every brought leaf's text
 * verbatim. This is what a hand-maintained mega-prompt would look like.
 */
export function buildMonolith(graph: Graph): string {
  const root = graph.dfs().find((n) => n.parentId === null);
  if (!root) throw new Error("graph has no root");
  const lines: string[] = [`# ${root.title ?? root.id}`];
  for (const text of allSlotTexts(graph, root.id)) lines.push("", text);

  for (const category of graph.dfs()) {
    if (category.routable === false || category.parentId === null) continue;
    lines.push("", `## ${category.title ?? category.id}`);
    for (const text of allSlotTexts(graph, category.id)) lines.push("", text);
    for (const leafId of category.bring ?? []) {
      if (!graph.has(leafId)) continue;
      for (const text of allSlotTexts(graph, leafId)) lines.push("", `- ${text}`);
    }
  }
  return lines.join("\n");
}

export function vetMeta(): {
  monolithChars: number;
  monolithTokensEst: number;
  graphStats: { nodes: number; categories: number; leaves: number };
} {
  const { graph, monolith } = loadVetBench();
  const nodes = graph.dfs();
  return {
    monolithChars: monolith.length,
    monolithTokensEst: countTokensFallback(monolith),
    graphStats: {
      nodes: nodes.length,
      categories: nodes.filter((n) => n.routable !== false && n.parentId !== null).length,
      leaves: nodes.filter((n) => n.routable === false && n.parentId !== null).length,
    },
  };
}

export interface CompareReplyOptions {
  runner?: CompareRunner;
  connectors?: Connectors;
  runBoth?: boolean;
}

export async function compareReply(
  sessionId: string | undefined,
  message: string,
  mode: CompareMode,
  opts: CompareReplyOptions = {}
): Promise<{
  session: CompareSession;
  active: { reply: string; metrics: CompareMetrics };
  alt?: { reply: string; metrics: CompareMetrics };
}> {
  const bench = loadVetBench();
  await ensureVetEmbeddings();
  const runner = opts.runner ?? vetAgentRunner;
  const session = (sessionId ? getCompareSession(sessionId) : null) ?? createCompareSession();
  // one history snapshot BEFORE this turn — both arms see identical context
  const history = session.messages.map((m) => ({ role: m.role, content: m.content }));
  const allowlist = bench.graph.get(bench.rootId).toolAllowlist;

  const buildArm = async (armMode: CompareMode): Promise<{ reply: string; metrics: CompareMetrics }> => {
    let promptText = bench.monolith;
    let routeMs: number | undefined;
    let composeMs: number | undefined;
    let routedTo: CompareMetrics["routedTo"];
    let truncatedCount = 0;
    let routeMethod: CompareMetrics["routeMethod"];
    const routeUsage: RouteUsage = { inputTokens: 0, outputTokens: 0 };

    if (armMode === "graph") {
      const t0 = performance.now();
      const routing = await route(message, bench.graph, {
        connectors: opts.connectors ?? fastRoutingConnectors(routeUsage),
      });
      routeMs = Math.round(performance.now() - t0);
      routeMethod = routing.matches[0]?.reason === "embedding" ? "embedding" : "classify";
      const targets = routing.fallbackUsed
        ? [bench.rootId]
        : [...routing.matches.map((m) => m.nodeId), bench.rootId];
      routedTo = routing.fallbackUsed
        ? [{ nodeId: bench.rootId, confidence: 0, fallback: true }]
        : routing.matches.map((m) => ({
            nodeId: m.nodeId,
            title: bench.graph.has(m.nodeId) ? bench.graph.get(m.nodeId).title : undefined,
            confidence: m.confidence,
          }));
      const t1 = performance.now();
      const composed = compose(bench.graph, targets, { query: message });
      composeMs = Math.round(performance.now() - t1);
      promptText = composed.text;
      truncatedCount = composed.truncated.length;
    }

    const run = await runner({ promptText, history, message, toolAllowlist: allowlist });
    const metrics: CompareMetrics = {
      mode: armMode,
      ...(routeMs !== undefined
        ? {
            routeMs,
            routeModel: opts.connectors ? "custom" : ROUTING_MODEL,
            routeMethod,
            routeInputTokens: routeUsage.inputTokens,
            routeOutputTokens: routeUsage.outputTokens,
            routeCostUsd: costUsd(routeUsage.inputTokens, routeUsage.outputTokens, ROUTING_MODEL),
          }
        : {}),
      ...(composeMs !== undefined ? { composeMs } : {}),
      generateMs: run.generateMs,
      totalMs: (routeMs ?? 0) + (composeMs ?? 0) + run.generateMs,
      promptChars: promptText.length,
      promptTokensEst: countTokensFallback(promptText),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      firstInputTokens: run.firstInputTokens,
      llmCalls: run.llmCalls,
      toolCalls: run.toolCalls,
      ...(routedTo !== undefined ? { routedTo } : {}),
      truncatedCount,
      promptText,
    };
    return { reply: run.text, metrics };
  };

  let active: { reply: string; metrics: CompareMetrics };
  let alt: { reply: string; metrics: CompareMetrics } | undefined;
  if (opts.runBoth) {
    const other: CompareMode = mode === "graph" ? "monolith" : "graph";
    [active, alt] = await Promise.all([buildArm(mode), buildArm(other)]);
  } else {
    active = await buildArm(mode);
  }

  const at = new Date().toISOString();
  session.messages.push({ role: "user", content: message, at });
  session.messages.push({
    role: "assistant",
    content: active.reply,
    at: new Date().toISOString(),
    mode,
    metrics: active.metrics,
    ...(alt ? { alt: { reply: alt.reply, metrics: alt.metrics } } : {}),
  });
  if (session.title === "New comparison") {
    session.title = message.length > 48 ? `${message.slice(0, 48)}…` : message;
  }
  saveCompareSession(session);

  return { session, active, ...(alt ? { alt } : {}) };
}

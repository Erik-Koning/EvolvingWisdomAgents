import type { ApgNode, DecisionChoice, NodeId, SessionState, VariableSpec } from "@apgraph/schema";
import { Graph } from "./graph.js";
import { evalCondition, evalExpr } from "./expr.js";
import { miniValidate } from "./minischema.js";
import { serializeOutline } from "./outline.js";
import { promptTemplate } from "./graph.js";
import type { Connectors } from "./connectors.js";

export type SessionInput =
  | { kind: "enter"; nodeId: NodeId }
  | { kind: "user"; text: string }
  | { kind: "choice"; value: string }
  | { kind: "humanAnswer"; text: string };

export type SessionEffect =
  | { kind: "ask"; nodeId: NodeId; question: string; choices?: Array<{ label: string; value: string }> }
  | { kind: "elicit"; nodeId: NodeId; variable: string; prompt: string }
  | { kind: "say"; nodeId: NodeId; text: string }
  | { kind: "toolCall"; nodeId: NodeId; tool: string; ok: boolean }
  | { kind: "escalate"; nodeId: NodeId; ticketId: string; queue?: string }
  | { kind: "composeReady"; nodeId: NodeId }
  | { kind: "humanSaid"; nodeId: NodeId; text: string }
  | { kind: "walkComplete" }
  | { kind: "reroute" };

export interface StepResult {
  session: SessionState;
  effects: SessionEffect[];
}

const STEP_LIMIT = 100;

export function newSession(sessionId: string): SessionState {
  return { sessionId, mode: "routing", vars: {}, visited: {}, stepCount: 0 };
}

/**
 * Deterministic session stepping (§7.6): zero-LLM traversal of flow edges,
 * except scoped freeform mini-classification and opportunistic fill, both of
 * which go through the llm connector.
 */
export async function sessionStep(
  graph: Graph,
  session: SessionState,
  input: SessionInput,
  connectors: Connectors = {},
): Promise<StepResult> {
  const s: SessionState = structuredClone(session);
  const effects: SessionEffect[] = [];
  let pending: SessionInput | null = input;

  const record = (nodeId: NodeId, event: string) => {
    s.history = s.history ?? [];
    s.history.push({ at: `#${s.stepCount}`, nodeId, event });
  };

  const arrive = (nodeId: NodeId, event: string) => {
    s.currentNodeId = nodeId;
    s.visited[nodeId] = (s.visited[nodeId] ?? 0) + 1;
    s.stepCount += 1;
    record(nodeId, event);
  };

  // ---- awaitingHuman: only a human answer moves the session ----
  if (s.mode === "awaitingHuman") {
    if (pending?.kind !== "humanAnswer") return { session: s, effects };
    const held = s.pendingHuman;
    delete s.pendingHuman;
    const heldNode = held ? graph.get(held.nodeId) : undefined;
    if (held) effects.push({ kind: "humanSaid", nodeId: held.nodeId, text: pending.text });
    const resume = heldNode?.escalation?.resumeNode;
    if (resume && graph.has(resume)) {
      s.mode = "walking";
      arrive(resume, "resume");
      pending = null;
    } else {
      s.mode = "routing";
      delete s.currentNodeId;
      effects.push({ kind: "walkComplete" });
      return { session: s, effects };
    }
  } else if (pending?.kind === "enter") {
    if (!graph.has(pending.nodeId)) {
      // stale/unknown target (e.g. the graph mutated since routing): reroute
      s.mode = "routing";
      effects.push({ kind: "reroute" });
      return { session: s, effects };
    }
    s.mode = "walking";
    arrive(pending.nodeId, "enter");
    pending = null;
  }

  if (s.mode !== "walking" || s.currentNodeId === undefined || !graph.has(s.currentNodeId)) {
    s.mode = "routing";
    effects.push({ kind: "reroute" });
    return { session: s, effects };
  }

  // ---- opportunistic fill: scan free text once against open schemas ----
  if (pending?.kind === "user") {
    const node = graph.get(s.currentNodeId);
    const policy = node.fillPolicy ?? "opportunistic";
    if (policy === "opportunistic" && connectors.llm?.extract) {
      const schema = openVarsSchema(node);
      if (schema) {
        const extracted = await connectors.llm.extract({ text: pending.text, schema });
        for (const [k, v] of Object.entries(extracted)) {
          if (!(k in s.vars) && v !== null && v !== undefined) s.vars[k] = v;
        }
      }
    }
  }

  // ---- walk loop: auto-advance until user input is needed or terminal ----
  let iterations = 0;
  const divertedOnce = new Set<NodeId>();
  while (iterations++ < STEP_LIMIT && s.stepCount <= STEP_LIMIT) {
    const node = graph.get(s.currentNodeId!);

    // visitPolicy "once": a revisit diverts to the nearest fallback, else ends
    // the walk; a divert cycle within one step (once-nodes whose fallbacks
    // point at each other) also ends the walk instead of burning the limit
    if (node.visitPolicy === "once" && (s.visited[node.id] ?? 0) > 1) {
      const fb = nearestFallback(graph, node.id);
      if (fb && fb !== node.id && !divertedOnce.has(node.id)) {
        divertedOnce.add(node.id);
        arrive(fb, "onceRevisit");
        continue;
      }
      s.mode = "routing";
      delete s.currentNodeId;
      effects.push({ kind: "walkComplete" });
      break;
    }

    // entry gate
    if (node.entryCondition && !evalCondition(node.entryCondition, s.vars)) {
      const fb = nearestFallback(graph, node.id);
      if (fb) {
        arrive(fb, "entryConditionFallback");
        continue;
      }
      s.mode = "routing";
      effects.push({ kind: "reroute" });
      break;
    }

    // mandatory human gate
    if (node.escalation?.mode === "require" && !s.pendingHuman) {
      const missing = missingVars(node.escalation.collectBeforeHandoff ?? [], s.vars);
      if (missing) {
        const consumed = tryExplicitFill(node, missing, pending, s, effects);
        if (consumed) pending = null;
        const still = missingVars(node.escalation.collectBeforeHandoff ?? [], s.vars);
        if (still) {
          if (!effects.some((e) => e.kind === "elicit")) {
            effects.push({
              kind: "elicit",
              nodeId: node.id,
              variable: still.name,
              prompt: still.elicitationPrompt ?? `Please provide ${still.name}`,
            });
          }
          break;
        }
      }
      const ticketId = `ticket-${node.id}-${s.stepCount}`;
      s.mode = "awaitingHuman";
      s.pendingHuman = { ticketId, nodeId: node.id, since: `#${s.stepCount}` };
      if (connectors.handoff) {
        await connectors.handoff.open({ nodeId: node.id, queue: node.escalation.queue, vars: s.vars });
      }
      const effect: SessionEffect = { kind: "escalate", nodeId: node.id, ticketId };
      if (node.escalation.queue !== undefined) effect.queue = node.escalation.queue;
      effects.push(effect);
      record(node.id, "escalate");
      break;
    }

    // intake
    const skipping = node.skipCondition ? evalCondition(node.skipCondition, s.vars) : false;
    if (node.collect && !skipping) {
      const missing = missingVars(node.collect, s.vars);
      if (missing) {
        const consumed = tryExplicitFill(node, missing, pending, s, effects);
        if (consumed) pending = null;
        const still = missingVars(node.collect, s.vars);
        if (still) {
          if (!effects.some((e) => e.kind === "elicit")) {
            effects.push({
              kind: "elicit",
              nodeId: node.id,
              variable: still.name,
              prompt: still.elicitationPrompt ?? `Please provide ${still.name}`,
            });
          }
          break;
        }
      }
    }

    if (node.type === "decision") {
      const d = node.decision!;
      if (skipping) {
        const next = d.timeoutNext ?? d.choices[0]!.next;
        arrive(next, "skip");
        continue;
      }
      // 1. already answered: saveAs var matches a choice
      const known = d.saveAs !== undefined ? s.vars[d.saveAs] : undefined;
      const knownChoice = d.choices.find((c) => c.value === known);
      if (knownChoice) {
        if (!leaveAllowed(node, s, effects)) break;
        arrive(knownChoice.next, `choice:${knownChoice.value}`);
        continue;
      }
      // 2. guard expression resolving to a choice value
      if (d.guard) {
        const g = evalExpr(d.guard, s.vars);
        const guardChoice = typeof g === "string" ? d.choices.find((c) => c.value === g) : undefined;
        if (guardChoice) {
          if (d.saveAs) s.vars[d.saveAs] = guardChoice.value;
          if (!leaveAllowed(node, s, effects)) break;
          arrive(guardChoice.next, `guard:${guardChoice.value}`);
          continue;
        }
      }
      // 3. explicit user input
      if (pending && (pending.kind === "choice" || pending.kind === "user")) {
        const text = pending.kind === "choice" ? pending.value : pending.text;
        const match = matchChoice(d.choices, text);
        if (match) {
          pending = null;
          if (d.saveAs) s.vars[d.saveAs] = match.value;
          if (!leaveAllowed(node, s, effects)) break;
          arrive(match.next, `choice:${match.value}`);
          continue;
        }
        // 4. scoped freeform mini-classification
        if (pending.kind === "user" && d.freeform && connectors.llm) {
          const scope = d.freeform.classifyInto.filter((id) => graph.has(id));
          const outline = serializeOutline(graph, scope);
          const raw = await connectors.llm.classify({
            query: pending.text,
            outline,
            schema: {},
            multi: false,
          });
          pending = null;
          const gated = raw
            .filter((m) => scope.includes(m.nodeId))
            .filter((m) => m.confidence >= graph.routing().minConfidence)
            .sort((a, b) => (b.confidence !== a.confidence ? b.confidence - a.confidence : graph.compareNodes(a.nodeId, b.nodeId)));
          if (gated.length > 0) {
            arrive(gated[0]!.nodeId, "freeform");
            continue;
          }
        }
      }
      effects.push({
        kind: "ask",
        nodeId: node.id,
        question: d.question,
        choices: d.choices.map((c) => ({ label: c.label, value: c.value })),
      });
      break;
    }

    if (node.type === "action") {
      const a = node.action!;
      const allow = effectiveAllowlist(graph, node.id);
      let ok = false;
      let result: unknown = null;
      if (allow !== undefined && !allow.includes(a.tool)) {
        ok = false;
      } else {
        if (!connectors.tools) throw new Error("Driver missing: tools connector is required for action nodes");
        const args: Record<string, unknown> = { ...(a.args ?? {}) };
        for (const name of a.argsFromVars ?? []) args[name] = s.vars[name];
        const r = await connectors.tools.call(a.tool, args);
        ok = r.ok && (a.resultSchema ? miniValidate(r.result, a.resultSchema).length === 0 : true);
        result = r.result;
      }
      if (ok && a.saveResultAs) s.vars[a.saveResultAs] = result;
      effects.push({ kind: "toolCall", nodeId: node.id, tool: a.tool, ok });
      arrive(ok ? a.onSuccess : a.onError, ok ? "onSuccess" : "onError");
      continue;
    }

    if (node.type === "answer") {
      const template = promptTemplate(node);
      const text = renderAnswer(template?.slots.task ?? "", node, s.vars);
      effects.push({ kind: "say", nodeId: node.id, text });
      record(node.id, "say");
      s.mode = "routing";
      delete s.currentNodeId;
      effects.push({ kind: "walkComplete" });
      break;
    }

    // category: exitCondition gates the exit to composition (loopUntilValid intake)
    if (!leaveAllowed(node, s, effects)) break;
    effects.push({ kind: "composeReady", nodeId: node.id });
    s.mode = "routing";
    break;
  }

  if (s.stepCount > STEP_LIMIT) {
    s.mode = "routing";
    delete s.currentNodeId;
    effects.push({ kind: "walkComplete" });
  }
  return { session: s, effects };
}

/** exitCondition gates leaving; visitPolicy "once" gates re-entry downstream. */
function leaveAllowed(node: ApgNode, s: SessionState, effects: SessionEffect[]): boolean {
  if (node.exitCondition && !evalCondition(node.exitCondition, s.vars)) {
    effects.push({
      kind: "elicit",
      nodeId: node.id,
      variable: node.exitCondition,
      prompt: `Exit condition not met: ${node.exitCondition}`,
    });
    return false;
  }
  return true;
}

function matchChoice(choices: DecisionChoice[], text: string): DecisionChoice | undefined {
  const t = text.trim().toLowerCase();
  return choices.find((c) => c.value.toLowerCase() === t) ?? choices.find((c) => c.label.toLowerCase() === t);
}

function missingVars(specs: VariableSpec[], vars: Record<string, unknown>): VariableSpec | undefined {
  return specs.find((spec) => spec.required && !(spec.name in vars));
}

/** explicit fill: consume the raw user text as the first pending variable. */
function tryExplicitFill(
  node: ApgNode,
  spec: VariableSpec,
  pending: SessionInput | null,
  s: SessionState,
  effects: SessionEffect[],
): boolean {
  if (!pending || pending.kind !== "user") return false;
  if ((node.fillPolicy ?? "opportunistic") !== "explicit") return false;
  const value: unknown = pending.text;
  if (spec.schema && miniValidate(coerce(value, spec.schema), spec.schema).length > 0) {
    effects.push({
      kind: "elicit",
      nodeId: node.id,
      variable: spec.name,
      prompt: spec.elicitationPrompt ?? `Please provide ${spec.name}`,
    });
    return true;
  }
  s.vars[spec.name] = spec.schema ? coerce(value, spec.schema) : value;
  return true;
}

// Pinned: only plain decimal literals coerce — keeps JS Number() and Python
// float() from disagreeing on hex, underscores, "nan"/"inf", etc.
const NUMERIC_LITERAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function coerce(value: unknown, schema: Record<string, unknown>): unknown {
  if (typeof value === "string" && (schema["type"] === "number" || schema["type"] === "integer")) {
    const trimmed = value.trim();
    if (NUMERIC_LITERAL_RE.test(trimmed)) return Number(trimmed);
  }
  return value;
}

function nearestFallback(graph: Graph, id: NodeId): NodeId | undefined {
  const path = graph.pathTo(id);
  for (let i = path.length - 1; i >= 0; i--) {
    const fb = path[i]!.fallbackNodeId;
    if (fb && graph.has(fb) && !graph.isPruned(fb)) return fb;
  }
  return undefined;
}

function effectiveAllowlist(graph: Graph, id: NodeId): string[] | undefined {
  let allow: string[] | undefined;
  for (const node of graph.pathTo(id)) {
    if (!node.toolAllowlist) continue;
    allow = allow === undefined ? [...node.toolAllowlist] : allow.filter((t) => node.toolAllowlist!.includes(t));
  }
  return allow;
}

/** Union mini-schema of everything the current node could learn from free text. */
function openVarsSchema(node: ApgNode): Record<string, unknown> | null {
  const properties: Record<string, unknown> = {};
  for (const spec of [...(node.collect ?? []), ...(node.escalation?.collectBeforeHandoff ?? [])]) {
    properties[spec.name] = spec.schema ?? { type: "string" };
  }
  const d = node.decision;
  if (d?.saveAs) {
    properties[d.saveAs] = { enum: d.choices.map((c) => c.value) };
  }
  if (Object.keys(properties).length === 0) return null;
  return { type: "object", properties };
}

const MUSTACHE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

function renderAnswer(raw: string, node: ApgNode, vars: Record<string, unknown>): string {
  return raw.replace(MUSTACHE_RE, (_m, name: string) => {
    let cur: unknown;
    if (name.startsWith("props.")) {
      cur = dig(node.props ?? {}, name.slice("props.".length));
    } else {
      cur = dig(vars, name);
    }
    if (cur === undefined || cur === null) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

function dig(bag: Record<string, unknown>, path: string): unknown {
  let cur: unknown = bag;
  for (const part of path.split(".")) {
    if (cur !== null && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

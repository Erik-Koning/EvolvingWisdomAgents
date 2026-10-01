#!/usr/bin/env node
// apg validate|outline|tree|route|compose|walk — thin shell over @apgraph/core.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  Graph,
  loadGraph,
  normalizeDocument,
  validateGraph,
  serializeOutline,
  route,
  compose,
  sessionStep,
  newSession,
  ScriptedTools,
  type ApgNode,
  type Connectors,
  type GraphDoc,
  type SessionEffect,
  type SessionInput,
} from "@apgraph/core";
import { validateDocument } from "@apgraph/schema";
import { AnthropicLlm, LexicalLlm } from "@apgraph/connectors";

function usage(): never {
  console.error(
    [
      "usage:",
      "  apg validate <graph.apg.json>                    schema + semantic validation report",
      "  apg outline  <graph.apg.json>                    canonical routing outline",
      "  apg tree     <graph.apg.json>                    human tree view (types, flags, brings)",
      "  apg route    <graph.apg.json> <query> [--live]   route + compose (--live = Anthropic API)",
      "  apg compose  <graph.apg.json> <nodeId> [--var name=value ...]",
      "  apg walk     <graph.apg.json> <nodeId> [--tools <mocks.json>]   interactive flow REPL",
    ].join("\n"),
  );
  process.exit(1);
}

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) usage();

function parseVars(args: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--var") continue;
    const pair = args[++i];
    const eq = pair?.indexOf("=") ?? -1;
    if (!pair || eq <= 0) {
      console.error(`apg: malformed --var ${pair ?? "(missing)"} — expected --var name=value`);
      process.exit(1);
    }
    vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return vars;
}

const raw = JSON.parse(readFileSync(file, "utf8")) as GraphDoc;

switch (cmd) {
  case "validate": {
    const schemaResult = validateDocument(raw);
    // normalize can throw before the validator runs (e.g. no root); fall back
    // to validating the raw doc so structural errors report instead of crash
    let report;
    try {
      report = validateGraph(normalizeDocument(raw));
    } catch {
      report = validateGraph(raw);
    }
    console.log(JSON.stringify({ schema: schemaResult, semantic: report }, null, 2));
    process.exit(schemaResult.valid && report.valid ? 0 : 1);
  }
  case "outline": {
    console.log(serializeOutline(loadGraph(file)));
    break;
  }
  case "tree": {
    const graph = loadGraph(file);
    printTree(graph, graph.rootId, "", true, true);
    const nodes = graph.dfs();
    const routable = nodes.filter((n) => n.routable !== false).length;
    console.log(`\n${nodes.length} nodes (${routable} routable) · profile ${graph.doc.profile}`);
    break;
  }
  case "route": {
    const query = rest.filter((a) => !a.startsWith("--"))[0];
    if (!query) usage();
    const graph = loadGraph(file);
    const live = rest.includes("--live");
    const connectors: Connectors = live ? { llm: new AnthropicLlm() } : { llm: new LexicalLlm(graph) };
    if (!live) console.error("(demo lexical classifier — pass --live with ANTHROPIC_API_KEY for real routing)");
    const routing = await route(query, graph, { connectors });
    const prompt = compose(graph, routing.matches.map((m) => m.nodeId), { query });
    console.log(JSON.stringify({ routing, prompt }, null, 2));
    break;
  }
  case "compose": {
    const nodeId = rest.filter((a) => !a.startsWith("--"))[0];
    if (!nodeId) usage();
    const graph = loadGraph(file);
    console.log(JSON.stringify(compose(graph, [nodeId], { vars: parseVars(rest) }), null, 2));
    break;
  }
  case "walk": {
    const nodeId = rest.filter((a) => !a.startsWith("--"))[0];
    if (!nodeId) usage();
    await walk(loadGraph(file), nodeId, rest);
    break;
  }
  default:
    usage();
}

function printTree(graph: Graph, id: string, prefix: string, isLast: boolean, isRoot: boolean): void {
  const node = graph.get(id);
  const flags = describeNode(node);
  const label = `${node.id}${node.title ? `  ${node.title}` : ""}${flags ? `  ${flags}` : ""}`;
  if (isRoot) {
    console.log(label);
  } else {
    console.log(`${prefix}${isLast ? "└─ " : "├─ "}${label}`);
  }
  const children = graph.childrenOf.get(id) ?? [];
  children.forEach((child, i) => {
    printTree(graph, child, isRoot ? "" : prefix + (isLast ? "   " : "│  "), i === children.length - 1, false);
  });
}

function describeNode(node: ApgNode): string {
  const flags: string[] = [];
  if (node.type !== "category") flags.push(node.type);
  if (node.routable === false) flags.push("knowledge");
  if (node.isFallback) flags.push("fallback");
  if (node.escalation) flags.push(`escalation:${node.escalation.mode}`);
  if (node.bring?.length) flags.push(`brings:${node.bring.length}`);
  if (node.collect?.length) flags.push(`collects:${node.collect.length}`);
  return flags.length > 0 ? `[${flags.join(", ")}]` : "";
}

/**
 * Buffering line reader: readline drops lines that arrive while no question
 * is pending, which breaks piped stdin — buffer everything instead.
 */
function lineReader(): { next: (prompt: string) => Promise<string | null>; close: () => void } {
  const rl = createInterface({ input: process.stdin });
  const buffered: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return {
    next: (prompt: string) => {
      process.stdout.write(prompt);
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    close: () => rl.close(),
  };
}

async function walk(graph: Graph, startNodeId: string, args: string[]): Promise<void> {
  const toolsFlag = args.indexOf("--tools");
  const connectors: Connectors = {};
  if (toolsFlag >= 0 && args[toolsFlag + 1]) {
    connectors.tools = new ScriptedTools(JSON.parse(readFileSync(args[toolsFlag + 1]!, "utf8")));
  }
  const reader = lineReader();
  let session = newSession("cli");
  let input: SessionInput = { kind: "enter", nodeId: startNodeId };

  for (;;) {
    const { session: next, effects } = await sessionStep(graph, session, input, connectors);
    session = next;
    let awaitingChoice: Array<{ label: string; value: string }> | undefined;
    let done = false;
    for (const effect of effects) {
      done = renderEffect(effect) || done;
      if (effect.kind === "ask") awaitingChoice = effect.choices;
    }
    if (done || session.mode === "awaitingHuman") break;
    const line = (await reader.next("> "))?.trim();
    if (line === undefined || line === null || line === "" || line === "/quit") break;
    // choice replies match by value/label; anything else flows through as user text
    const isChoice = awaitingChoice?.some(
      (c) => c.value === line.toLowerCase() || c.label.toLowerCase() === line.toLowerCase(),
    );
    input = isChoice ? { kind: "choice", value: line } : { kind: "user", text: line };
  }
  reader.close();
}

/** Render one effect; returns true when the walk is over. */
function renderEffect(effect: SessionEffect): boolean {
  switch (effect.kind) {
    case "ask":
      console.log(`\n${effect.question}`);
      for (const c of effect.choices ?? []) console.log(`  [${c.value}] ${c.label}`);
      return false;
    case "elicit":
      console.log(`\n${effect.prompt}`);
      return false;
    case "say":
      console.log(`\n${effect.text}`);
      return false;
    case "toolCall":
      console.log(`\n(tool ${effect.tool} → ${effect.ok ? "ok" : "error"})`);
      return false;
    case "escalate":
      console.log(`\n(escalated: ticket ${effect.ticketId}${effect.queue ? ` in queue ${effect.queue}` : ""})`);
      return true;
    case "composeReady":
      console.log(`\n(intake complete at ${effect.nodeId} — ready to compose)`);
      return true;
    case "walkComplete":
      console.log("\n(walk complete)");
      return true;
    case "reroute":
      console.log("\n(rerouting — this input belongs elsewhere)");
      return true;
    default:
      return false;
  }
}

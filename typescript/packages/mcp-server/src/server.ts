import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  Graph,
  loadGraph,
  serializeOutline,
  validateGraph,
  resolveBring,
  compose,
  route,
  findNodes,
  listPropertyKeys,
  newSession,
  sessionStep,
  ScriptedTools,
  MemoryAgentStateStore,
  MemoryChangesetStore,
  MemoryGraphStore,
  MemoryTranscriptStore,
  addOps,
  approveChangeset,
  commitChangeset,
  createChangeset,
  discardChangeset,
  labeledFromMeta,
  validateChangeset,
  type ApgNode,
  type Changeset,
  type Connectors,
  type GraphDoc,
  type MutationOp,
  type SessionInput,
  type SessionState,
  type TranscriptTurn,
} from "@apgraph/core";
import { FileAgentStateStore, FileChangesetStore, FileGraphStore, FileTranscriptStore, LexicalLlm } from "@apgraph/connectors";
import {
  consolidationStatus,
  digestFeedback,
  finalizeAmendment,
  getEngineState,
  harvestTurns,
  listAmendmentDrafts,
  resolvePolicy,
  revalidateAmendment,
  runReplay,
  runSleep,
  weighPressure,
  type MemoryDeps,
} from "@apgraph/memory";

export { LexicalLlm };

export interface ApgServerOptions {
  graphPath: string;
  /** Optional real connectors; defaults to the lexical demo classifier. */
  connectors?: Connectors;
  /** Scripted tool responses for action nodes (the --tools mocks.json flag). */
  toolMocks?: Record<string, { ok: boolean; result: unknown }>;
  /**
   * Persistence root (the --data-dir flag). When set, graph versions,
   * changesets, transcripts, engine state, and audit.jsonl live under this
   * directory and survive restarts; graphPath is only the first-run seed.
   * Without it every store is in-memory (the original behavior).
   */
  dataDir?: string;
}

export async function createApgServer(opts: ApgServerOptions): Promise<McpServer> {
  const template = loadGraph(opts.graphPath);
  const graphId = template.doc.graphId;

  const store = opts.dataDir ? new FileGraphStore(opts.dataDir) : new MemoryGraphStore();
  const changesets = opts.dataDir ? new FileChangesetStore(opts.dataDir) : new MemoryChangesetStore();
  const transcripts = opts.dataDir ? new FileTranscriptStore(opts.dataDir) : new MemoryTranscriptStore();
  const stateStore = opts.dataDir ? new FileAgentStateStore(opts.dataDir) : new MemoryAgentStateStore();
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });

  // store-first load; the graphPath template seeds an empty store on first run
  let doc: GraphDoc;
  try {
    doc = await store.load(graphId);
  } catch {
    doc = template.doc;
    await store.save(doc, { expectedVersion: null });
  }
  let graph = new Graph(doc); // reassigned whenever a write lands in the store

  const connectors: Connectors = { llm: new LexicalLlm(graph), ...(opts.connectors ?? {}) };
  if (opts.toolMocks && !connectors.tools) connectors.tools = new ScriptedTools(opts.toolMocks);
  const sessions = new Map<string, SessionState>();
  let changesetCounter = 0;
  let transcriptCounter = 0;

  const deps: MemoryDeps = {
    graphId,
    store,
    llm: connectors.llm!,
    ...(connectors.embeddings ? { embeddings: connectors.embeddings } : {}),
    transcripts,
    changesets,
    state: stateStore,
    ...(opts.dataDir
      ? { audit: (e: unknown) => appendFileSync(join(opts.dataDir!, "audit.jsonl"), JSON.stringify(e) + "\n") }
      : {}),
  };

  /** Fire a list-changed notification, swallowing sync throws AND async
   * rejections (e.g. not connected yet). */
  const notify = (fn: () => unknown): void => {
    try {
      (fn() as Promise<void> | undefined)?.catch?.(() => undefined);
    } catch {
      /* not connected */
    }
  };

  /** Re-materialize the served graph after any store write + notify clients.
   * The prompts notification only fires when prompts were registered — a
   * graph with no routable prompt nodes never declares that capability. */
  let promptsRegistered = false;
  const refreshGraph = async (): Promise<void> => {
    graph = new Graph(await store.load(graphId));
    notify(() => server.sendResourceListChanged());
    if (promptsRegistered) notify(() => server.sendPromptListChanged());
  };

  const server = new McpServer({ name: "apg", version: "0.1.0" });

  const nodeJson = (node: ApgNode) => JSON.stringify(node, null, 2);
  // structuredContent must be an object per the MCP spec — arrays wrap as {items}
  const ok = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: (Array.isArray(payload) ? { items: payload } : payload) as Record<string, unknown>,
  });

  // ---- resources ----
  server.registerResource(
    "graph-tree",
    "apg://graph/tree",
    { title: "Graph outline", description: "Canonical routing outline (descriptor text only)", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: serializeOutline(graph) }] }),
  );
  server.registerResource(
    "node",
    new ResourceTemplate("apg://node/{id}", { list: undefined }),
    { title: "Node descriptor", description: "Titles, descriptions, and relations of one node", mimeType: "application/json" },
    async (uri, vars) => {
      const id = String(vars["id"]);
      if (!graph.has(id)) throw new Error(`Unknown node id: ${id}`);
      return { contents: [{ uri: uri.href, text: nodeJson(graph.get(id)) }] };
    },
  );

  // ---- routing ----
  server.registerTool(
    "route_query",
    {
      description:
        "Route a query through the graph (embedding shortlist → outline → classification → confidence gate) and compose the final prompt for the matched path plus its brought context.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const routing = await route(query, graph, { connectors });
      const prompt = compose(graph, routing.matches.map((m) => m.nodeId), { query });
      return ok({ routing, prompt });
    },
  );

  // ---- read toolkit ----
  server.registerTool(
    "apg_get_node",
    { description: "Fetch one node by id.", inputSchema: { id: z.string() } },
    async ({ id }) => ok(graph.get(id)),
  );
  server.registerTool(
    "apg_get_children",
    { description: "List a node's children in authored sibling order.", inputSchema: { id: z.string() } },
    async ({ id }) => ok(graph.children(id)),
  );
  server.registerTool(
    "apg_get_ancestors",
    { description: "Root-to-node path.", inputSchema: { id: z.string() } },
    async ({ id }) => ok(graph.pathTo(id)),
  );
  server.registerTool(
    "apg_find_nodes",
    {
      description: "Substring search over descriptor fields and props. Pass `field` (reserved key or props.* path) to scope the search.",
      inputSchema: { query: z.string(), field: z.string().optional() },
    },
    async ({ query, field }) => {
      const hits = findNodes(graph, query, field ? { field } : {});
      return ok(hits.map((n) => ({ id: n.id, title: n.title, description: n.description })));
    },
  );
  server.registerTool(
    "apg_list_property_keys",
    {
      description: "Union of props.* keys in use (with counts) so an agent landing on an unfamiliar graph learns its vocabulary before searching.",
      inputSchema: { subtreeId: z.string().optional() },
    },
    async ({ subtreeId }) => ok({ keys: listPropertyKeys(graph, subtreeId) }),
  );
  server.registerTool(
    "apg_resolve_bring",
    { description: "Companion-context expansion for a node (BFS, cycle-safe, depth-capped).", inputSchema: { id: z.string() } },
    async ({ id }) => ok(resolveBring(graph, id)),
  );
  server.registerTool(
    "apg_validate_graph",
    { description: "Structural + semantic validation report for the loaded graph.", inputSchema: {} },
    async () => ok(validateGraph(graph.doc)),
  );
  // ---- session walking (decision/action/answer flows over MCP) ----
  server.registerTool(
    "apg_session_step",
    {
      description:
        "Walk the graph's conversational flows deterministically. input.kind: \"enter\" (nodeId) starts a walk at a decision/action/answer node; \"choice\" (value) answers a decision; \"user\" (text) is free text (opportunistic fill / freeform classification); \"humanAnswer\" (text) resumes an escalated session. Returns the updated session and effects (ask/elicit/say/toolCall/escalate/composeReady/walkComplete/reroute). Sessions persist in server memory by sessionId.",
      inputSchema: {
        sessionId: z.string().optional(),
        input: z.object({
          kind: z.enum(["enter", "choice", "user", "humanAnswer"]),
          nodeId: z.string().optional(),
          value: z.string().optional(),
          text: z.string().optional(),
        }),
      },
    },
    async ({ sessionId, input }) => {
      const id = sessionId ?? "default";
      const session = sessions.get(id) ?? newSession(id);
      const result = await sessionStep(graph, session, input as SessionInput, connectors);
      sessions.set(id, result.session);
      return ok({ session: result.session, effects: result.effects });
    },
  );
  server.registerTool(
    "apg_compose_preview",
    {
      description: "Compose the prompt for a specific node (path + brings) without routing.",
      inputSchema: { id: z.string(), vars: z.record(z.string()).optional() },
    },
    async ({ id, vars }) => ok(compose(graph, [id], { vars })),
  );

  // ---- changeset lifecycle: the L5 mutation surface, human-gated ----
  const requireChangeset = async (id: string): Promise<Changeset> => {
    const cs = await changesets.get(id);
    if (!cs) throw new Error(`Unknown changeset: ${id}`);
    return cs;
  };

  server.registerTool(
    "apg_create_changeset",
    { description: "Open a draft changeset against the current graph version.", inputSchema: { createdBy: z.string().optional() } },
    async ({ createdBy }) => {
      const cs = createChangeset(graph.doc, createdBy ?? "mcp-client", `cs-${++changesetCounter}`);
      await changesets.put(cs);
      return ok(cs);
    },
  );
  server.registerTool(
    "apg_add_ops",
    {
      description: "Append MutationOps to a draft changeset (see changeset.schema.json for the op algebra).",
      inputSchema: { id: z.string(), ops: z.array(z.record(z.unknown())) },
    },
    async ({ id, ops }) => {
      const cs = addOps(await requireChangeset(id), ops as unknown as MutationOp[]);
      await changesets.put(cs);
      return ok(cs);
    },
  );
  server.registerTool(
    "apg_validate_changeset",
    {
      description:
        "Dry-apply + structural validation + the routing-regression gate against the graph's meta.regression labeled set (traffic-steal checked). Status becomes 'validated' only when everything passes.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const labeled = labeledFromMeta(graph);
      const cs = await validateChangeset(graph.doc, await requireChangeset(id), {
        ...(labeled.length > 0 ? { labeled, connectors } : {}),
      });
      await changesets.put(cs);
      return ok(cs);
    },
  );
  server.registerTool(
    "apg_commit_changeset",
    {
      description:
        "Commit a changeset. 'approved' commits directly; 'validated' triggers a human approval elicitation — the server enforces the human gate, not the client's goodwill.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      let cs = await requireChangeset(id);
      // amendment drafts get a charter-staleness re-check: a proposal whose
      // charter moved underneath it never applies (conservative refusal)
      const invalidated = await revalidateAmendment(deps, cs, graph.doc);
      if (invalidated) {
        return ok({ committed: false, reason: "invalidated — charter changed since drafting", changeset: invalidated });
      }
      if (cs.status === "validated") {
        const caps = server.server.getClientCapabilities();
        if (!caps?.elicitation) {
          throw new Error("Commit requires prior approval (apg_approve_changeset) — this client does not support elicitation");
        }
        const summary = cs.ops.map((o) => o.op).join(", ");
        const answer = await server.server.elicitInput({
          message: `Commit changeset ${cs.id} (${cs.ops.length} ops: ${summary})?`,
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", description: "Approve and commit this changeset" } },
            required: ["confirm"],
          },
        });
        if (answer.action !== "accept" || (answer.content as { confirm?: boolean })?.confirm !== true) {
          return ok({ committed: false, reason: "declined by human gate", changeset: cs });
        }
        cs = approveChangeset(cs);
      }
      const { doc: next, changeset } = commitChangeset(graph.doc, cs);
      await store.save(next, { expectedVersion: graph.doc.version ?? null });
      await changesets.put(changeset);
      await finalizeAmendment(deps, changeset); // no-op for non-amendments
      await refreshGraph();
      return ok({ committed: true, version: next.version, changeset });
    },
  );
  server.registerTool(
    "apg_approve_changeset",
    { description: "Approve a validated changeset (out-of-band human approval path).", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const cs = approveChangeset(await requireChangeset(id));
      await changesets.put(cs);
      return ok(cs);
    },
  );
  server.registerTool(
    "apg_discard_changeset",
    { description: "Discard a draft/validated/approved changeset.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const cs = discardChangeset(await requireChangeset(id));
      await changesets.put(cs);
      return ok(cs);
    },
  );
  server.registerTool(
    "apg_list_changesets",
    { description: "List changesets, optionally by status.", inputSchema: { status: z.enum(["draft", "validated", "approved", "committed", "discarded"]).optional() } },
    async ({ status }) => ok(await changesets.list(undefined, status)),
  );

  // ---- the memory engine: transcripts, replay, sleep, wake-path digest ----
  server.registerTool(
    "apg_log_turns",
    {
      description:
        "Append conversation turns to a stored transcript (created on first append) — the raw-episode source for apg_harvest and apg_replay. Returns the transcript id and watermarks.",
      inputSchema: {
        transcriptId: z.string().optional(),
        turns: z.array(
          z.object({ role: z.enum(["user", "assistant"]), content: z.string(), at: z.string().optional() })
        ),
      },
    },
    async ({ transcriptId, turns }) => {
      const id = transcriptId ?? `t-${++transcriptCounter}-${Date.now().toString(36)}`;
      if (!(await transcripts.get(id))) {
        await transcripts.put({ id, graphId, createdAt: new Date().toISOString(), turns: [] });
      }
      const t = await transcripts.appendTurns(id, turns as TranscriptTurn[]);
      return ok({
        transcriptId: t.id,
        turnCount: t.turns.length,
        harvestedUpTo: t.harvestedUpTo ?? 0,
        replayedUpTo: t.replayedUpTo ?? 0,
      });
    },
  );
  server.registerTool(
    "apg_list_transcripts",
    { description: "List stored transcripts with their harvest/replay watermarks.", inputSchema: {} },
    async () =>
      ok({
        transcripts: (await transcripts.list(graphId)).map((t) => ({
          id: t.id,
          title: t.title,
          turnCount: t.turns.length,
          harvestedUpTo: t.harvestedUpTo ?? 0,
          replayedUpTo: t.replayedUpTo ?? 0,
          ended: t.ended ?? false,
        })),
      }),
  );
  server.registerTool(
    "apg_get_transcript",
    { description: "Fetch one stored transcript in full.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const t = await transcripts.get(id);
      if (!t) throw new Error(`Unknown transcript: ${id}`);
      return ok(t);
    },
  );
  server.registerTool(
    "apg_harvest",
    {
      description:
        "Wake-path digest: distill the un-harvested tail of a transcript into graph learnings (refine-over-add, dedup backstop) and advance its harvest watermark. Commits with user-write semantics.",
      inputSchema: { transcriptId: z.string() },
    },
    async ({ transcriptId }) => {
      const result = await harvestTurns(deps, transcriptId);
      if (result) await refreshGraph();
      return ok(result ?? { learned: [], updated: [], version: null });
    },
  );
  server.registerTool(
    "apg_replay",
    {
      description:
        "Transcript replay (EXPLICIT trigger — never scheduled by the server; wire your own cron to this tool). Re-reads stored transcripts with hindsight and commits a preservation-biased batch: adds/reinforcements/refinements apply freely, degrades apply ONLY with a mechanically verified quote from a USER turn (uncited degrades drop to the pressure ledger). Always finishes with the sleep pass. dryRun extracts and gates without committing.",
      inputSchema: {
        transcriptIds: z.array(z.string()).optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ transcriptIds, dryRun }) => {
      const report = await runReplay(deps, {
        ...(transcriptIds ? { transcriptIds } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
      });
      if (!report.dryRun) await refreshGraph();
      return ok(report);
    },
  );
  server.registerTool(
    "apg_sleep",
    {
      description:
        "Run the sleep pass now (an MCP call is a deliberate trigger, so the cooldown is bypassed; the per-category threshold still gates). Growth drafts surface as changesets for apg_commit_changeset.",
      inputSchema: {},
    },
    async () => {
      const result = await runSleep(deps, { manual: true });
      if (result.ran) await refreshGraph();
      return ok(result);
    },
  );
  server.registerTool(
    "apg_feedback",
    {
      description:
        "Teach the agent: one comment becomes standing adjustments (add / refine / retire) in one atomic changeset, committed with user-write semantics. identity=true routes the comment to the charter-amendment path instead of classification.",
      inputSchema: { comment: z.string(), identity: z.boolean().optional(), context: z.string().optional() },
    },
    async ({ comment, identity, context }) => {
      const result = await digestFeedback(deps, comment, {
        ...(identity !== undefined ? { identity } : {}),
        ...(context !== undefined ? { context } : {}),
      });
      if (result.version) await refreshGraph();
      return ok(result);
    },
  );
  server.registerTool(
    "apg_memory_status",
    {
      description:
        "The memory engine's dashboard: per-category counts vs the sleep threshold, misfit-pool size vs the growth minimum, open pressure, last sleep, pending transcripts, and draft proposals awaiting the human gate.",
      inputSchema: {},
    },
    async () => {
      const policy = resolvePolicy(graph.doc);
      const status = consolidationStatus(graph, policy.sleep.threshold);
      const state = await getEngineState(deps);
      const pool = graph.dfs().find((n) => n.isFallback === true && n.routable !== false);
      const all = await transcripts.list(graphId);
      const drafts = [
        ...(await listAmendmentDrafts(deps)).map((cs) => ({ id: cs.id, status: cs.status, kind: "amendment" })),
        ...(await changesets.list(undefined, "validated"))
          .filter((cs) => (cs.meta as { kind?: string } | undefined)?.kind !== "amendment")
          .map((cs) => ({ id: cs.id, status: cs.status, kind: cs.createdBy === "deep-sleep" ? "growth" : "other" })),
      ];
      return ok({
        version: graph.doc.version,
        policy,
        consolidation: status,
        pool: pool ? { id: pool.id, size: (pool.bring ?? []).length, growthMin: policy.growth.min } : null,
        pressure: (() => {
          const open = state.pressure.filter((p) => p.status === "open");
          return {
            open: open.length,
            cited: open.filter((p) => p.citation !== undefined).length,
            weighted: weighPressure(open, policy.transcendence.inferredWeight),
            threshold: policy.transcendence.pressureThreshold,
            total: state.pressure.length,
          };
        })(),
        identity: {
          cumulative: state.identityCumulative,
          amendments: state.identityTrail.length,
          lastAmendmentLabel: state.identityTrail.at(-1)?.label ?? null,
          reviewRecommended:
            state.identityCumulative !== null && state.identityCumulative < policy.transcendence.reviewFloor,
          genesisCaptured: state.genesisCharter !== null,
        },
        lastSleepAt: state.lastSleepAt,
        lastSleepSummary: state.lastSleepSummary,
        transcripts: all.map((t) => ({ id: t.id, unharvested: t.turns.length - (t.harvestedUpTo ?? 0), unreplayed: t.turns.length - (t.replayedUpTo ?? 0) })),
        drafts,
      });
    },
  );

  // ---- routable nodes as MCP prompts ----
  // Named by node.id: globally unique by contract. Slugs are only unique
  // among siblings, so slug-named prompts would collide across branches.
  for (const node of graph.dfs()) {
    if (node.routable === false || node.prompt === undefined) continue;
    promptsRegistered = true;
    server.registerPrompt(
      node.id,
      {
        title: node.title ?? node.id,
        description: node.description ?? "",
        argsSchema: {},
      },
      async () => {
        const composed = compose(graph, [node.id], {});
        return {
          messages: [{ role: "user" as const, content: { type: "text" as const, text: composed.text } }],
        };
      },
    );
  }

  return server;
}

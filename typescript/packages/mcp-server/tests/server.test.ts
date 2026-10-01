import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApgServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "..", "..", "..", "..", "templates");
const l0 = join(templates, "l0-prompt-switcher.apg.json");
const l3 = join(templates, "l3-triage-flows.apg.json");

async function connected(opts: Parameters<typeof createApgServer>[0] = { graphPath: l0 }) {
  const server = await createApgServer(opts);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("apg mcp server", () => {
  it("lists the apg toolkit", async () => {
    const client = await connected();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("route_query");
    expect(names).toContain("apg_get_node");
    expect(names).toContain("apg_validate_graph");
    expect(names).toContain("apg_list_property_keys");
  });

  it("serves the canonical outline as a resource", async () => {
    const client = await connected();
    const res = await client.readResource({ uri: "apg://graph/tree" });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain("root: Assistant — General assistant");
    expect(text).toContain("  travel: Travel — Trips, destinations, itineraries");
  });

  it("routes and composes via route_query (lexical demo classifier)", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "route_query",
      arguments: { query: "plan a trip with great destinations and itineraries" },
    });
    const payload = result.structuredContent as {
      routing: { matches: Array<{ nodeId: string }> };
      prompt: { text: string };
    };
    expect(payload.routing.matches[0]?.nodeId).toBe("travel");
    expect(payload.prompt.text).toContain("You are a helpful assistant.");
    expect(payload.prompt.text).toContain("Never default to the most popular destination.");
  });

  it("changeset lifecycle over MCP: elicitation-gated commit (accept, decline, no-capability)", async () => {
    const callRaw = (client: Client, name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const call = async (client: Client, name: string, args: Record<string, unknown>) =>
      (await callRaw(client, name, args)).structuredContent as Record<string, unknown>;

    // client WITH elicitation, accepting
    const accepting = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
    accepting.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true } }));
    {
      const server = await createApgServer({ graphPath: l0 });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), accepting.connect(ct)]);
      const cs = await call(accepting, "apg_create_changeset", {});
      await call(accepting, "apg_add_ops", {
        id: cs.id,
        ops: [{ op: "addNode", parentId: "root", node: { id: "cooking", parentId: "root", title: "Cooking", description: "Recipes and food" } }],
      });
      const validated = await call(accepting, "apg_validate_changeset", { id: cs.id });
      expect(validated.status).toBe("validated");
      const commit = await call(accepting, "apg_commit_changeset", { id: cs.id });
      expect(commit.committed).toBe(true);
      const node = await call(accepting, "apg_get_node", { id: "cooking" });
      expect(node.title).toBe("Cooking");
    }

    // client WITH elicitation, declining — nothing commits
    const declining = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
    declining.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    {
      const server = await createApgServer({ graphPath: l0 });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), declining.connect(ct)]);
      const cs = await call(declining, "apg_create_changeset", {});
      await call(declining, "apg_add_ops", {
        id: cs.id,
        ops: [{ op: "addNode", parentId: "root", node: { id: "x", parentId: "root", title: "X", description: "x" } }],
      });
      await call(declining, "apg_validate_changeset", { id: cs.id });
      const commit = await call(declining, "apg_commit_changeset", { id: cs.id });
      expect(commit.committed).toBe(false);
      expect((await callRaw(declining, "apg_get_node", { id: "x" })).isError).toBe(true);
    }

    // client WITHOUT elicitation: commit refused until out-of-band approval
    const plain = await connected();
    const cs = await call(plain, "apg_create_changeset", {});
    await call(plain, "apg_add_ops", {
      id: cs.id,
      ops: [{ op: "addNode", parentId: "root", node: { id: "y", parentId: "root", title: "Y", description: "y" } }],
    });
    await call(plain, "apg_validate_changeset", { id: cs.id });
    const refused = await callRaw(plain, "apg_commit_changeset", { id: cs.id });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("elicitation");
    await call(plain, "apg_approve_changeset", { id: cs.id });
    const committed = await call(plain, "apg_commit_changeset", { id: cs.id });
    expect(committed.committed).toBe(true);
  });

  it("walks a decision flow via apg_session_step", async () => {
    const client = await connected({
      graphPath: l3,
      toolMocks: { checkWarranty: { ok: true, result: { inWarranty: true } } },
    });
    const step = async (input: Record<string, unknown>) => {
      const r = await client.callTool({
        name: "apg_session_step",
        arguments: { sessionId: "walk-test", input },
      });
      return r.structuredContent as { session: { mode: string }; effects: Array<{ kind: string; [k: string]: unknown }> };
    };

    const enter = await step({ kind: "enter", nodeId: "wont-start" });
    expect(enter.effects[0]).toMatchObject({ kind: "ask", nodeId: "wont-start" });

    const powered = await step({ kind: "choice", value: "yes" });
    expect(powered.effects[0]).toMatchObject({ kind: "ask", nodeId: "screen-check" });

    const cracked = await step({ kind: "choice", value: "yes" });
    expect(cracked.effects[0]).toMatchObject({ kind: "elicit", variable: "serialNumber" });

    const serial = await step({ kind: "user", text: "SN-77" });
    expect(serial.effects.map((e) => e.kind)).toEqual(["toolCall", "say", "walkComplete"]);
    expect(serial.session.mode).toBe("routing");
  });

  it("starts cleanly on a graph with duplicate sibling-scoped slugs (prompts named by id)", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dup = join(mkdtempSync(join(tmpdir(), "apg-")), "dup.apg.json");
    writeFileSync(
      dup,
      JSON.stringify({
        schemaVersion: "1.0",
        graphId: "dup-slugs",
        profile: "L0",
        nodes: [
          { id: "root", parentId: null, title: "R", description: "r", prompt: "Root." },
          { id: "a", parentId: "root", slug: "faq", title: "A", description: "a", prompt: "A." },
          { id: "b", parentId: "root", title: "B", description: "b" },
          { id: "b-faq", parentId: "b", slug: "faq", title: "B FAQ", description: "b faq", prompt: "B." },
        ],
      }),
    );
    const client = await connected({ graphPath: dup });
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((p) => p.name).sort();
    expect(names).toEqual(["a", "b-faq", "root"]);
  });

  it("exposes routable nodes as MCP prompts", async () => {
    const client = await connected();
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((p) => p.name);
    expect(names).toContain("travel");
    const got = await client.getPrompt({ name: "travel", arguments: {} });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toContain("You are a helpful assistant.");
  });
});

describe("memory engine over MCP", () => {
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>;

  it("log_turns → replay commits the gated batch, drops uncited degrades, persists across restarts", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { ScriptedLlm } = await import("@apgraph/core");
    const dataDir = mkdtempSync(join(tmpdir(), "apg-mcp-mem-"));

    // wisdom-profile has categories with props.learn + a misfit pool
    const wisdom = join(templates, "wisdom-profile.apg.json");
    const llm = new ScriptedLlm({
      extract: [
        {
          vars: {
            candidates: [
              { kind: "add", text: "Started learning the cello this spring.", categoryId: "interests" },
              { kind: "retire", text: "uncited attempt", targetNodeId: "goals" },
            ],
          },
        },
      ],
    });
    const client = await connected({ graphPath: wisdom, dataDir, connectors: { llm } });

    const logged = await call(client, "apg_log_turns", {
      turns: [
        { role: "user", content: "I picked up the cello this spring" },
        { role: "assistant", content: "wonderful" },
      ],
    });
    expect(logged.turnCount).toBe(2);

    const report = await call(client, "apg_replay", {});
    expect(report.ran).toBe(true);
    expect((report.added as unknown[]).length).toBe(1);
    expect(report.degradesDropped).toMatchObject([{ reason: "no-citation" }]);
    // replay always ends with sleep (threshold-gated to a skip here is fine)
    expect(report.sleep).not.toBe(null);

    const status = await call(client, "apg_memory_status");
    expect((status.pressure as { open: number }).open).toBe(1);
    expect(
      (status.transcripts as Array<{ unreplayed: number }>).every((t) => t.unreplayed === 0)
    ).toBe(true);

    // a NEW server on the same dataDir sees the committed learning — persistence is real
    const reopened = await connected({ graphPath: wisdom, dataDir, connectors: { llm } });
    const found = await call(reopened, "apg_find_nodes", { query: "cello", field: "prompt" });
    expect((found.items as Array<{ id: string }>).length).toBeGreaterThan(0);
    const transcriptsAgain = await call(reopened, "apg_list_transcripts");
    expect((transcriptsAgain.transcripts as unknown[]).length).toBe(1);
  });

  it("apg_harvest distills the tail and apg_feedback refines, both visible in the served graph", async () => {
    const { ScriptedLlm } = await import("@apgraph/core");
    const wisdom = join(templates, "wisdom-profile.apg.json");
    const llm = new ScriptedLlm({
      classify: [{ matches: [{ nodeId: "interests", confidence: 0.9 }] }], // feedback scoping route
      extract: [
        { vars: { facts: [{ fact: "Grows heirloom tomatoes.", categoryId: "interests" }] } }, // harvest
        {
          vars: {
            adjustments: [
              {
                instruction: "Grows heirloom tomatoes and trades seedlings locally.",
                categoryId: "interests",
                action: "refine",
                updateOfNodeId: "kn-interests-1",
              },
            ],
          },
        },
      ],
    });
    const client = await connected({ graphPath: wisdom, connectors: { llm } });

    const logged = await call(client, "apg_log_turns", {
      turns: [{ role: "user", content: "my tomatoes are thriving" }],
    });
    const harvest = await call(client, "apg_harvest", { transcriptId: logged.transcriptId as string });
    expect((harvest.learned as Array<{ nodeId: string }>)[0]?.nodeId).toBe("kn-interests-1");

    const feedback = await call(client, "apg_feedback", { comment: "he also trades seedlings" });
    expect((feedback.refined as unknown[]).length).toBe(1);
    const node = await call(client, "apg_get_node", { id: "kn-interests-1" });
    expect(JSON.stringify(node)).toContain("trades seedlings");
  });
});

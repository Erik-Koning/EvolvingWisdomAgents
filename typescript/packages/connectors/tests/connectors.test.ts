import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicLlm } from "../src/anthropic.js";
import { FileGraphStore } from "../src/file-store.js";
import type { GraphDoc } from "@apgraph/core";

function mockFetch(response: unknown, capture: { url?: string; body?: Record<string, unknown> }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.body = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response;
  }) as typeof fetch;
}

describe("AnthropicLlm", () => {
  it("classify forces the classify tool with the kernel's schema and parses tool_use", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const llm = new AnthropicLlm({
      apiKey: "test-key",
      model: "claude-sonnet-5",
      fetchImpl: mockFetch(
        { content: [{ type: "tool_use", input: { matches: [{ nodeId: "travel", confidence: 0.9 }] } }] },
        capture,
      ),
    });
    const schema = { type: "object", required: ["matches"] };
    const matches = await llm.classify({ query: "plan a trip", outline: "root: R", schema, multi: true });
    expect(matches).toEqual([{ nodeId: "travel", confidence: 0.9 }]);
    expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
    expect(capture.body).toMatchObject({
      model: "claude-sonnet-5",
      tool_choice: { type: "tool", name: "classify" },
      tools: [{ name: "classify", input_schema: schema }],
    });
    expect((capture.body!["messages"] as Array<{ content: string }>)[0]!.content).toContain("plan a trip");
  });

  it("reports measured token usage per request via onUsage", async () => {
    const usages: Array<{ inputTokens: number; outputTokens: number; model: string }> = [];
    const llm = new AnthropicLlm({
      apiKey: "test-key",
      model: "claude-haiku-4-5-20251001",
      onUsage: (u) => usages.push(u),
      fetchImpl: mockFetch(
        {
          content: [{ type: "tool_use", input: { matches: [] } }],
          usage: { input_tokens: 1234, output_tokens: 56 },
        },
        {},
      ),
    });
    await llm.classify({ query: "q", outline: "root: R", schema: { type: "object" }, multi: true });
    expect(usages).toEqual([{ inputTokens: 1234, outputTokens: 56, model: "claude-haiku-4-5-20251001" }]);
  });

  it("generate sends system + history + query and joins text blocks", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const llm = new AnthropicLlm({
      apiKey: "test-key",
      fetchImpl: mockFetch(
        { content: [{ type: "text", text: "Hello " }, { type: "text", text: "Erik!" }] },
        capture,
      ),
    });
    const prompt = {
      slots: { persona: "You are Sage." },
      text: "You are Sage.",
      truncated: [],
      unresolved: [],
      modelHints: { model: "claude-sonnet-5", temperature: 0.6 },
    };
    const out = await llm.generate({
      prompt,
      query: "How are you?",
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hey there" },
      ],
    });
    expect(out.text).toBe("Hello Erik!");
    expect(capture.body).toMatchObject({
      model: "claude-sonnet-5",
      temperature: 0.6,
      system: "You are Sage.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hey there" },
        { role: "user", content: "How are you?" },
      ],
    });
    expect(capture.body!["tools"]).toBeUndefined();
  });

  it("errors clearly without an API key and on non-tool responses", async () => {
    const bare = new AnthropicLlm({ apiKey: "", fetchImpl: mockFetch({}, {}) });
    await expect(bare.classify({ query: "q", outline: "", schema: {}, multi: true })).rejects.toThrow(
      "no API key",
    );
    const noTool = new AnthropicLlm({ apiKey: "k", fetchImpl: mockFetch({ content: [{ type: "text" }] }, {}) });
    await expect(noTool.classify({ query: "q", outline: "", schema: {}, multi: true })).rejects.toThrow(
      "no tool_use",
    );
  });
});

describe("embeddings connectors", () => {
  it("VoyageEmbeddings shapes the request and re-orders by index", async () => {
    const { VoyageEmbeddings } = await import("../src/embeddings.js");
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const emb = new VoyageEmbeddings({
      apiKey: "vk",
      inputType: "document",
      fetchImpl: mockFetch(
        { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] },
        capture,
      ),
    });
    const vecs = await emb.embed(["alpha", "beta"]);
    expect(vecs).toEqual([[1, 0], [0, 1]]);
    expect(capture.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(capture.body).toMatchObject({ input: ["alpha", "beta"], model: "voyage-3-lite", input_type: "document" });
  });

  it("OpenAIEmbeddings passes dimensions and errors without a key", async () => {
    const { OpenAIEmbeddings } = await import("../src/embeddings.js");
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const emb = new OpenAIEmbeddings({
      apiKey: "ok",
      dimensions: 512,
      fetchImpl: mockFetch({ data: [{ index: 0, embedding: [0.5] }] }, capture),
    });
    expect(await emb.embed(["x"])).toEqual([[0.5]]);
    expect(capture.url).toBe("https://api.openai.com/v1/embeddings");
    expect(capture.body).toMatchObject({ model: "text-embedding-3-small", dimensions: 512 });

    const bare = new OpenAIEmbeddings({ apiKey: "", fetchImpl: mockFetch({}, {}) });
    await expect(bare.embed(["x"])).rejects.toThrow("OPENAI_API_KEY");
  });
});

describe("file-backed changeset + layer stores", () => {
  it("round-trip with status filtering and id sanitization", async () => {
    const { FileChangesetStore, FileLayerStore } = await import("../src/json-stores.js");
    const dir = mkdtempSync(join(tmpdir(), "apg-json-"));
    const csStore = new FileChangesetStore(dir);
    await csStore.put({ id: "cs-1", baseGraphVersion: "1", ops: [], status: "draft", createdBy: "t" });
    await csStore.put({ id: "cs-2", baseGraphVersion: "1", ops: [], status: "committed", createdBy: "t" });
    expect((await csStore.list(undefined, "draft")).map((c) => c.id)).toEqual(["cs-1"]);
    expect((await csStore.get("cs-2"))?.status).toBe("committed");

    const layerStore = new FileLayerStore(dir);
    await layerStore.putLayer({
      layerId: "user:erik", baseGraphId: "g", baseVersion: "1", scope: "user", ownerId: "erik", version: "u1", ops: [],
    });
    expect((await layerStore.getLayer("user:erik"))?.ownerId).toBe("erik");
    expect((await layerStore.listLayers("g", "user")).length).toBe(1);
    await layerStore.deleteLayer("user:erik");
    expect(await layerStore.getLayer("user:erik")).toBeNull();
    await expect(csStore.get("../../etc/passwd")).rejects.toThrow("Invalid store id");
  });
});

describe("file-backed transcript + agent-state stores", () => {
  it("transcript appendTurns creates, accumulates, and survives a new instance", async () => {
    const { FileTranscriptStore } = await import("../src/json-stores.js");
    const dir = mkdtempSync(join(tmpdir(), "apg-tr-"));
    const store = new FileTranscriptStore(dir);
    await store.appendTurns("t1", [{ role: "user", content: "hi" }]);
    await store.appendTurns("t1", [{ role: "assistant", content: "hello" }]);
    await store.put({ id: "t2", graphId: "other", turns: [] });

    const reopened = new FileTranscriptStore(dir);
    expect((await reopened.get("t1"))?.turns).toHaveLength(2);
    expect((await reopened.list("other")).map((t) => t.id)).toEqual(["t2"]);
    expect(await reopened.list()).toHaveLength(2);
  });

  it("agent state round-trips by agent id", async () => {
    const { FileAgentStateStore } = await import("../src/json-stores.js");
    const store = new FileAgentStateStore(mkdtempSync(join(tmpdir(), "apg-st-")));
    expect(await store.getState("sage")).toBeNull();
    await store.putState("sage", { lastSleepAt: 7, pressure: [{ nodeId: "n", status: "open" }] });
    expect(await store.getState("sage")).toEqual({ lastSleepAt: 7, pressure: [{ nodeId: "n", status: "open" }] });
  });
});

describe("FileGraphStore", () => {
  it("round-trips latest + versioned snapshots", async () => {
    const store = new FileGraphStore(mkdtempSync(join(tmpdir(), "apg-store-")));
    const doc: GraphDoc = {
      schemaVersion: "1.0",
      graphId: "g",
      version: "3",
      nodes: [{ id: "root", parentId: null, type: "category", title: "R", description: "r" }],
    };
    await store.save(doc);
    expect((await store.load("g")).version).toBe("3");
    expect((await store.load("g", "3")).graphId).toBe("g");
    expect(await store.listVersions("g")).toEqual(["3"]);
    await expect(store.load("g", "9")).rejects.toThrow("cannot load");
  });

  it("CAS: rejects a save whose expected version no longer matches the stored latest", async () => {
    const { StoreConflictError } = await import("@apgraph/core");
    const store = new FileGraphStore(mkdtempSync(join(tmpdir(), "apg-cas-")));
    const doc = (version: string): GraphDoc => ({
      schemaVersion: "1.0",
      graphId: "g",
      version,
      nodes: [{ id: "root", parentId: null, type: "category", title: "R", description: "r" }],
    });
    await store.save(doc("1"), { expectedVersion: null });
    await expect(store.save(doc("2"), { expectedVersion: null })).rejects.toThrow(StoreConflictError);
    await expect(store.save(doc("2"), { expectedVersion: "0" })).rejects.toThrow("moved");
    await store.save(doc("2"), { expectedVersion: "1" });
    expect((await store.load("g")).version).toBe("2");
  });

  it("writes atomically: no temp files remain and snapshots never count as versionless files", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "apg-atomic-"));
    const store = new FileGraphStore(dir);
    const doc: GraphDoc = {
      schemaVersion: "1.0",
      graphId: "g",
      version: "1",
      nodes: [{ id: "root", parentId: null, type: "category", title: "R", description: "r" }],
    };
    await store.save(doc);
    await store.save({ ...doc, version: "2" });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["g.apg.json", "g@1.apg.json", "g@2.apg.json"]);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    expect((await store.load("g")).version).toBe("2");
  });
});

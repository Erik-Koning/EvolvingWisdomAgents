// Deterministic tests for the compare engine: stubbed runner (no LangGraph,
// no network), ScriptedLlm for routing, temp data dir for session files.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ScriptedLlm } from "@apgraph/core";
import { compareReply, loadVetBench, resetVetBench } from "./compare";
import { usageFromMessages, type CompareRunner, type RunnerResult } from "./compare-agent";
import { getCompareSession } from "./compare-store";

const envBackup = process.env["WISDOM_DATA_DIR"];

beforeAll(() => {
  process.env["WISDOM_DATA_DIR"] = mkdtempSync(join(tmpdir(), "wisdom-compare-"));
  resetVetBench();
});

afterAll(() => {
  if (envBackup === undefined) delete process.env["WISDOM_DATA_DIR"];
  else process.env["WISDOM_DATA_DIR"] = envBackup;
});

const stubRunner = (overrides: Partial<RunnerResult> = {}): { runner: CompareRunner; calls: Array<Parameters<CompareRunner>[0]> } => {
  const calls: Array<Parameters<CompareRunner>[0]> = [];
  const runner: CompareRunner = async (input) => {
    calls.push(input);
    return {
      text: `stub reply (${input.promptText.length} chars)`,
      toolCalls: [],
      llmCalls: 1,
      inputTokens: Math.round(input.promptText.length / 4),
      outputTokens: 40,
      firstInputTokens: Math.round(input.promptText.length / 4),
      generateMs: 5,
      ...overrides,
    };
  };
  return { runner, calls };
};

describe("compareReply", () => {
  it("monolith mode: no route/compose timings, prompt is the full flattened graph", async () => {
    const { runner } = stubRunner();
    const { session, active } = await compareReply(undefined, "hello there", "monolith", { runner });
    expect(active.metrics.mode).toBe("monolith");
    expect(active.metrics.routeMs).toBeUndefined();
    expect(active.metrics.composeMs).toBeUndefined();
    expect(active.metrics.promptChars).toBe(loadVetBench().monolith.length);
    expect(active.metrics.totalMs).toBe(active.metrics.generateMs);
    expect(active.metrics.truncatedCount).toBe(0);
    // session file persisted under the temp dir
    expect(getCompareSession(session.id)?.messages).toHaveLength(2);
    expect(readdirSync(join(process.env["WISDOM_DATA_DIR"]!, "compare")).length).toBeGreaterThan(0);
  });

  it("graph mode: routes, composes a scoped prompt far smaller than the monolith", async () => {
    const { runner } = stubRunner();
    const llm = new ScriptedLlm({ classify: [{ matches: [{ nodeId: "dogs", confidence: 0.9 }] }] });
    const { active } = await compareReply(undefined, "how much should I feed my labrador puppy", "graph", {
      runner,
      connectors: { llm },
    });
    expect(active.metrics.routeMs).toBeGreaterThanOrEqual(0);
    expect(active.metrics.composeMs).toBeGreaterThanOrEqual(0);
    expect(active.metrics.routedTo).toMatchObject([{ nodeId: "dogs" }]);
    expect(active.metrics.truncatedCount).toBe(0);
    // classify path (no embeddings connector): method recorded, measured
    // routing usage present (zero — ScriptedLlm reports none)
    expect(active.metrics.routeMethod).toBe("classify");
    expect(active.metrics.routeCostUsd).toBe(0);
    const bench = loadVetBench();
    expect(active.metrics.promptChars).toBeLessThan(bench.monolith.length / 3);
    // scoped prompt carries the charter + dogs content, not birds content
    const dogsLeaf = bench.graph.get(bench.graph.get("dogs").bring![0]!);
    const dogsText = (dogsLeaf.prompt as { slots: Record<string, string> }).slots["knowledge"] ??
      (dogsLeaf.prompt as { slots: Record<string, string> }).slots["constraints"]!;
    expect(active.metrics.promptText).toContain(dogsText.slice(0, 60));
    const birdsLeaf = bench.graph.get(bench.graph.get("birds").bring![0]!);
    const birdsText = (birdsLeaf.prompt as { slots: Record<string, string> }).slots["knowledge"] ??
      (birdsLeaf.prompt as { slots: Record<string, string> }).slots["constraints"]!;
    expect(active.metrics.promptText).not.toContain(birdsText.slice(0, 60));
  });

  it("graph fallback: composes the charter alone and flags it", async () => {
    const { runner } = stubRunner();
    const llm = new ScriptedLlm({ classify: [{ matches: [] }] });
    const { active } = await compareReply(undefined, "zzzz nonsense query", "graph", { runner, connectors: { llm } });
    expect(active.metrics.routedTo?.[0]?.fallback).toBe(true);
    const bench = loadVetBench();
    expect(active.metrics.promptChars).toBeLessThan(bench.monolith.length / 5);
  });

  it("runBoth: both arms run on the SAME history, only the active reply joins it", async () => {
    const { runner, calls } = stubRunner();
    const llm = new ScriptedLlm({
      classify: [
        { matches: [{ nodeId: "cats", confidence: 0.85 }] }, // turn 1 graph arm
        { matches: [{ nodeId: "cats", confidence: 0.85 }] }, // turn 2 graph arm
      ],
    });
    const first = await compareReply(undefined, "my cat coughs up hairballs", "graph", {
      runner,
      connectors: { llm },
      runBoth: true,
    });
    expect(first.alt).toBeDefined();
    expect(first.alt!.metrics.mode).toBe("monolith");
    expect(first.session.messages).toHaveLength(2); // user + ONE assistant
    expect(first.session.messages[1]!.alt?.metrics.mode).toBe("monolith");
    // both arms saw the identical (empty) history
    expect(calls[0]!.history).toEqual([]);
    expect(calls[1]!.history).toEqual([]);

    const second = await compareReply(first.session.id, "and what about vaccines", "graph", {
      runner,
      connectors: { llm },
    });
    // follow-up sees exactly the 2-message shared history
    expect(calls[2]!.history).toHaveLength(2);
    expect(calls[2]!.history[1]!.role).toBe("assistant");
    expect(second.session.messages).toHaveLength(4);
  });
});

describe("usageFromMessages", () => {
  it("sums usage across AI turns, keeps the first call's input tokens, collects tool calls", () => {
    const messages = [
      new HumanMessage("q"),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "toxinCheck", args: { substance: "chocolate", species: "dog" }, id: "t1" }],
        usage_metadata: { input_tokens: 9000, output_tokens: 60, total_tokens: 9060 },
      }),
      new AIMessage({
        content: "final answer",
        usage_metadata: { input_tokens: 9200, output_tokens: 180, total_tokens: 9380 },
      }),
    ];
    const usage = usageFromMessages(messages);
    expect(usage.llmCalls).toBe(2);
    expect(usage.firstInputTokens).toBe(9000);
    expect(usage.inputTokens).toBe(18_200);
    expect(usage.outputTokens).toBe(240);
    expect(usage.toolCalls).toEqual([{ tool: "toxinCheck", args: { substance: "chocolate", species: "dog" } }]);
  });
});

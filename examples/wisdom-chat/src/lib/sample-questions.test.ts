// Pins the demo script: every curated sample must keep routing to the
// category whose knowledge it is designed to exercise (offline, lexical
// classifier), and the fallback probe must keep falling back. If a template
// edit breaks a probe, this fails before a demo does.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Graph, normalizeDocument, route, type GraphDoc } from "@apgraph/core";
import { LexicalLlm } from "@apgraph/connectors";
import { SAMPLE_QUESTIONS } from "./sample-questions";
import { PRICING, costUsd, fmtUsd } from "./pricing";
import { VET_MODEL } from "./compare-agent";

const raw = JSON.parse(
  readFileSync(join(process.cwd(), "..", "..", "templates", "vet-clinic.apg.json"), "utf8")
) as GraphDoc;
const graph = new Graph(normalizeDocument(raw));

describe("sample question suite", () => {
  it("has 8 probes, each explaining what it proves", () => {
    expect(SAMPLE_QUESTIONS).toHaveLength(8);
    for (const s of SAMPLE_QUESTIONS) {
      expect(s.question.length).toBeGreaterThan(10);
      expect(s.proves.length).toBeGreaterThan(20);
    }
  });

  for (const s of SAMPLE_QUESTIONS.filter((q) => q.expectCategory !== undefined)) {
    it(`routes: "${s.question.slice(0, 48)}…" → ${s.expectCategory ?? "fallback"}`, async () => {
      const routing = await route(s.question, graph, { connectors: { llm: new LexicalLlm(graph) } });
      if (s.expectCategory === null) {
        expect(routing.fallbackUsed).toBe(true);
      } else {
        expect(routing.fallbackUsed).toBe(false);
        expect(routing.matches.slice(0, 2).map((m) => m.nodeId)).toContain(s.expectCategory);
      }
    });
  }
});

describe("pricing", () => {
  it("computes per-message cost from real token counts", () => {
    // 29,853 in / 357 out on Sonnet — the live monolith baseline
    const mono = costUsd(29_853, 357, VET_MODEL.model);
    expect(mono).toBeCloseTo(0.0949, 3);
    const graphArm = costUsd(6_345, 311, VET_MODEL.model);
    expect(graphArm).toBeCloseTo(0.0237, 3);
    expect(mono / graphArm).toBeGreaterThan(3);
  });

  it("knows the generation and routing models; unknown models fall back to Sonnet rates", () => {
    expect(PRICING[VET_MODEL.model]).toBeDefined();
    expect(PRICING["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(costUsd(1_000_000, 0, "unknown-model")).toBe(3);
  });

  it("formats across magnitudes", () => {
    expect(fmtUsd(0.0037)).toBe("$0.0037");
    expect(fmtUsd(0.095)).toBe("$0.095");
    expect(fmtUsd(2.5)).toBe("$2.50");
    expect(fmtUsd(412.4)).toBe("$412");
  });
});

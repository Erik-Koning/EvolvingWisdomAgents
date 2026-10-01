// The vet-clinic template is the single content source for BOTH benchmark
// arms — these tests pin its validity, its scale, offline routability of the
// regression set, and that the monolith flattener preserves every leaf
// verbatim (content parity is what makes the A/B fair).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Graph,
  assertRegression,
  compose,
  countTokensFallback,
  detectRequiredProfile,
  evalRouting,
  labeledFromMeta,
  normalizeDocument,
  promptTemplate,
  validateGraph,
  type GraphDoc,
} from "@apgraph/core";
import { LexicalLlm } from "@apgraph/connectors";
import { buildMonolith } from "./compare";
import { VET_TOOL_NAMES } from "./vet-tools";

const raw = JSON.parse(
  readFileSync(join(process.cwd(), "..", "..", "templates", "vet-clinic.apg.json"), "utf8")
) as GraphDoc;
const doc = normalizeDocument(raw);
const graph = new Graph(doc);
const categories = graph.dfs().filter((n) => n.routable !== false && n.parentId !== null);
const leaves = graph.dfs().filter((n) => n.routable === false && n.parentId !== null);

describe("vet-clinic template", () => {
  it("validates structurally and stays within profile L3", () => {
    const report = validateGraph(doc);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(["L0", "L1", "L2", "L3"]).toContain(detectRequiredProfile(doc));
  });

  it("is genuinely large: 9 categories, 80+ leaves, 85k+ chars of leaf text", () => {
    expect(categories.length).toBe(9);
    expect(leaves.length).toBeGreaterThanOrEqual(80);
    const leafChars = leaves.reduce((acc, l) => {
      const slots = promptTemplate(l)?.slots ?? {};
      return acc + (slots.knowledge ?? slots.constraints ?? "").length;
    }, 0);
    expect(leafChars).toBeGreaterThan(85_000);
  });

  it("root allowlist matches the vet toolbox exactly (tool parity is structural)", () => {
    const root = graph.dfs().find((n) => n.parentId === null)!;
    expect([...(root.toolAllowlist ?? [])].sort()).toEqual([...VET_TOOL_NAMES].sort());
  });

  it("meta.regression routes home offline with the lexical classifier", async () => {
    const labeled = labeledFromMeta(graph);
    expect(labeled.length).toBeGreaterThanOrEqual(10);
    const report = await evalRouting(graph, labeled, { connectors: { llm: new LexicalLlm(graph) }, topK: 2 });
    assertRegression(report);
  });

  it("never truncates — worst-case all-category compose fits the raised budget", () => {
    const worst = compose(graph, [graph.dfs().find((n) => n.parentId === null)!.id, ...categories.map((c) => c.id)]);
    expect(worst.truncated).toEqual([]);
  });

  it("monolith preserves every leaf verbatim and lands at benchmark scale", () => {
    const monolith = buildMonolith(graph);
    for (const leaf of leaves) {
      const slots = promptTemplate(leaf)?.slots ?? {};
      const text = slots.knowledge ?? slots.constraints ?? "";
      expect(monolith).toContain(text);
    }
    expect(monolith.length).toBeGreaterThan(85_000);
    expect(countTokensFallback(monolith)).toBeGreaterThan(21_000);
  });
});

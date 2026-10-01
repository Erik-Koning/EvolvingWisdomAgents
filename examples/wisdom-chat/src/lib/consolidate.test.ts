// Offline, deterministic test of the consolidation ("sleep") pass: ScriptedLlm
// plays the review call; every graph mutation runs through the real kernel
// (applyChangeset validates the result), so this pins the op-building logic
// end to end without the network.
import { describe, expect, it } from "vitest";
import { Graph, ScriptedLlm, normalizeDocument, type GraphDoc } from "@apgraph/core";
import { buildConsolidationOps, consolidateCategory, consolidationStatus, CONSOLIDATE_MIN } from "./consolidate";

function rule(id: string, text: string, feedbackCount = 1) {
  return {
    id,
    parentId: "style",
    type: "category" as const,
    routable: false,
    prompt: { slots: { constraints: text } },
    props: { source: "feedback", feedbackCount, learnedAt: "2026-07-01" },
  };
}

function seedDoc(): GraphDoc {
  return normalizeDocument({
    schemaVersion: "1.0",
    graphId: "sleep-test",
    version: "1",
    profile: "L1",
    edges: [{ from: "r5", to: "r6", kind: "seeAlso" }],
    nodes: [
      { id: "root", parentId: null, type: "category", title: "R", description: "r", routable: false,
        prompt: { slots: { persona: "P." } }, bring: ["style"], recursiveBring: true },
      { id: "style", parentId: "root", type: "category", title: "Style",
        props: { learn: "tone and format", storeAs: "constraints" },
        bring: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"] },
      rule("r1", "Keep responses brief.", 3),
      rule("r2", "Responses should be short and to the point."),
      rule("r3", "Never use tables."),
      rule("r4", "Tables are fine for parts lists."),
      rule("r5", "Mention the warranty once."),
      rule("r6", "Always give prices in CAD.", 4),
      rule("r7", "Use metric units."),
    ],
  } as GraphDoc);
}

const REVIEW = {
  merges: [{ keepId: "r1", absorbIds: ["r2"], mergedText: "Keep responses brief and to the point.", label: "Brevity" }],
  retires: [{ id: "r3", reason: "contradicted by r4" }, { id: "r5", reason: "stale one-off" }],
  priorities: [{ id: "r6", weight: 5 }, { id: "r1", weight: 3 }],
};

describe("consolidation (sleep) pass", () => {
  it("merges, retires, and re-ranks through one validated changeset", async () => {
    const doc = seedDoc();
    const result = await consolidateCategory(doc, new Graph(doc), "style", new ScriptedLlm({
      extract: [{ vars: REVIEW }],
    }));
    expect(result).not.toBeNull();
    const { doc: next, summary } = result!;
    expect(summary).toMatchObject({ categoryId: "style", merged: 1, retired: 2, reranked: 2 });
    expect(next.version).toBe("1-1");

    const g = new Graph(next);
    // absorbed + retired nodes are gone
    for (const gone of ["r2", "r3", "r5"]) expect(g.has(gone)).toBe(false);
    // merged keeper: new text, summed feedbackCount, label
    const keep = g.get("r1");
    expect((keep.prompt as { slots: Record<string, string> }).slots.constraints).toBe(
      "Keep responses brief and to the point.",
    );
    expect(keep.props?.feedbackCount).toBe(4); // 3 + 1
    expect(keep.props?.label).toBe("Brevity");
    // anchor bring cleaned, survivor order preserved
    expect(g.get("style").bring).toEqual(["r1", "r4", "r6", "r7"]);
    // retired node's seeAlso edge cleaned (else the changeset would have aborted)
    expect((next.edges ?? []).some((e) => e.kind === "seeAlso")).toBe(false);
    // reinforcement mapped onto composition priority: 700 + 25·(w−1), capped 800
    expect(g.get("r6").composition?.priority).toBe(800);
    expect(g.get("r1").composition?.priority).toBe(750);
  });

  it("ignores review entries that reference unknown, non-resident, or consumed nodes", () => {
    const doc = seedDoc();
    const graph = new Graph(doc);
    const { ops, summary } = buildConsolidationOps(graph, doc, "style", {
      merges: [
        { keepId: "ghost", absorbIds: ["r2"], mergedText: "x" },
        { keepId: "r1", absorbIds: ["r1", "style", "r2"], mergedText: "merged" }, // self+non-resident filtered
      ],
      retires: [{ id: "r2" }, { id: "root" }], // r2 already absorbed; root not a resident
      priorities: [{ id: "r2", weight: 5 }, { id: "nope", weight: 5 }],
    });
    expect(summary).toMatchObject({ merged: 1, retired: 0, reranked: 0 });
    expect(ops.filter((o) => o.op === "mergeNodes")).toHaveLength(1);
  });

  it("reports consolidation as recommended at the threshold", () => {
    const graph = new Graph(seedDoc());
    const status = consolidationStatus(graph);
    expect(status.counts["style"]).toBe(7);
    expect(status.counts["style"]).toBeGreaterThanOrEqual(CONSOLIDATE_MIN);
    expect(status.recommended).toBe(true);
  });

  it("returns null when the review finds nothing to do", async () => {
    const doc = seedDoc();
    const result = await consolidateCategory(doc, new Graph(doc), "style", new ScriptedLlm({
      extract: [{ vars: { merges: [], retires: [], priorities: [] } }],
    }));
    expect(result).toBeNull();
  });
});

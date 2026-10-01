import { describe, expect, it } from "vitest";
import {
  Graph,
  applyChangeset,
  buildSplitOps,
  clusterBySimilarity,
  cosineSimilarity,
  medoid,
  normalizeDocument,
  validateGraph,
  type GraphDoc,
} from "../src/index.js";

describe("evolve math", () => {
  it("cosineSimilarity on known vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
  });

  it("greedy single-link clustering is input-order deterministic and drops noise", () => {
    const vectors = [
      [1, 0],
      [0.95, 0.05],
      [0, 1],
      [0.05, 0.95],
      [0.7, 0.7],
    ];
    // hand-derived: sim(v4, v0) = 0.7/0.98995 ≈ 0.707 — at threshold 0.7 the
    // diagonal vector links to BOTH clusters; greedy joins the FIRST (v0's)
    expect(clusterBySimilarity(vectors, { threshold: 0.7, minSize: 2 })).toEqual([
      [0, 1, 4],
      [2, 3],
    ]);
    // at 0.9 the diagonal is a singleton and gets dropped as noise
    expect(clusterBySimilarity(vectors, { threshold: 0.9, minSize: 2 })).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("medoid breaks ties toward the lowest index", () => {
    const vectors = [
      [1, 0],
      [1, 0],
      [0, 1],
    ];
    expect(medoid(vectors, [0, 1])).toBe(0);
  });
});

describe("buildSplitOps", () => {
  const doc = (): GraphDoc =>
    normalizeDocument({
      schemaVersion: "1.0",
      graphId: "grow",
      profile: "L1",
      nodes: [
        { id: "root", parentId: null, type: "category", title: "R", description: "r" },
        { id: "cat", parentId: "root", type: "category", title: "Cat", description: "c",
          bring: ["a", "b", "c", "d"] },
        ...["a", "b", "c", "d"].map((id) => ({
          id, parentId: "cat", type: "category" as const, routable: false,
          prompt: { slots: { knowledge: `Fact ${id}.` } },
        })),
      ],
    });

  it("adds subcategories, moves the taken learnings, and emits authoritative brings", () => {
    const base = doc();
    const graph = new Graph(base);
    const ops = buildSplitOps(graph, "cat", [
      { newCategory: { id: "cat-x", parentId: "cat", type: "category", title: "X", description: "x" }, take: ["a", "b"] },
      { newCategory: { id: "cat-y", parentId: "cat", type: "category", title: "Y", description: "y" }, take: ["c"] },
    ]);
    expect(ops.map((o) => o.op)).toEqual([
      "addNode", "moveNode", "moveNode", "setBring",
      "addNode", "moveNode", "setBring",
      "setBring",
    ]);
    const next = applyChangeset(base, ops);
    const g = new Graph(next);
    expect(g.get("a").parentId).toBe("cat-x");
    expect(g.get("cat-x").bring).toEqual(["a", "b"]);
    expect(g.get("cat-y").bring).toEqual(["c"]);
    expect(g.get("cat").bring).toEqual(["d"]);
    expect(validateGraph(next).valid).toBe(true);
  });

  it("rejects duplicate ids and filters overlapping takes", () => {
    const base = doc();
    const graph = new Graph(base);
    expect(() =>
      buildSplitOps(graph, "cat", [
        { newCategory: { id: "cat", parentId: "cat", type: "category", title: "dup", description: "d" }, take: ["a"] },
      ]),
    ).toThrow("node id already exists: cat");
    const ops = buildSplitOps(graph, "cat", [
      { newCategory: { id: "x1", parentId: "cat", type: "category", title: "X1", description: "1" }, take: ["a", "b"] },
      { newCategory: { id: "x2", parentId: "cat", type: "category", title: "X2", description: "2" }, take: ["b", "c"] },
    ]);
    const x2Bring = ops.find((o) => o.op === "setBring" && o.id === "x2") as { bring: string[] };
    expect(x2Bring.bring).toEqual(["c"]); // b already taken by x1
  });
});

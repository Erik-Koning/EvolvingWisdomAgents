import { describe, it, expect } from "vitest";
import {
  Graph,
  normalizeDocument,
  precomputeEmbeddings,
  MapEmbeddings,
  type GraphDoc,
  type EmbeddingsConnector,
} from "../src/index.js";

const doc = (): GraphDoc =>
  normalizeDocument({
    schemaVersion: "1.0",
    graphId: "e",
    profile: "L1",
    nodes: [
      { id: "root", parentId: null, type: "category", title: "R", description: "r", routable: false },
      { id: "a", parentId: "root", type: "category", title: "A", description: "aa" },
      { id: "b", parentId: "root", type: "category", title: "B", description: "bb", embedding: [9, 9] },
      { id: "k", parentId: "root", type: "category", title: "K", description: "kk", routable: false },
    ],
  });

describe("precomputeEmbeddings", () => {
  it("embeds only routable nodes missing a vector; input doc untouched", async () => {
    const base = doc();
    const next = await precomputeEmbeddings(base, new MapEmbeddings({ "A — aa": [1, 0] }));
    const graph = new Graph(next);
    expect(graph.get("a").embedding).toEqual([1, 0]);
    expect(graph.get("b").embedding).toEqual([9, 9]); // untouched, connector never asked
    expect(graph.get("k").embedding).toBeUndefined(); // non-routable skipped
    expect(new Graph(base).get("a").embedding).toBeUndefined(); // input not mutated
  });

  it("is a no-op with zero connector calls when nothing is missing", async () => {
    const complete = await precomputeEmbeddings(doc(), new MapEmbeddings({ "A — aa": [1, 0] }));
    const exploding: EmbeddingsConnector = {
      embed: async () => {
        throw new Error("must not be called");
      },
    };
    await expect(precomputeEmbeddings(complete, exploding)).resolves.toBe(complete);
  });

  it("force re-embeds everything routable", async () => {
    const next = await precomputeEmbeddings(
      doc(),
      new MapEmbeddings({ "A — aa": [1, 0], "B — bb": [0, 1] }),
      { force: true },
    );
    expect(new Graph(next).get("b").embedding).toEqual([0, 1]);
  });
});

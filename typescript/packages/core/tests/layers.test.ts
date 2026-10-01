import { describe, expect, it } from "vitest";
import {
  MemoryLayerStore,
  applyChangeset,
  loadWithLayers,
  normalizeDocument,
  rebaseLayer,
  type GraphDoc,
  type GraphLayer,
} from "../src/index.js";

const base = (): GraphDoc =>
  normalizeDocument({
    schemaVersion: "1.0",
    graphId: "layered",
    version: "1",
    profile: "L0",
    nodes: [
      { id: "root", parentId: null, type: "category", title: "R", description: "r" },
      { id: "a", parentId: "root", type: "category", title: "A", description: "aa" },
    ],
  });

const layer = (ops: GraphLayer["ops"]): GraphLayer => ({
  layerId: "user:erik",
  baseGraphId: "layered",
  baseVersion: "1",
  scope: "user",
  ownerId: "erik",
  version: "u1",
  ops,
});

describe("layer persistence + rebase", () => {
  it("MemoryLayerStore CRUD with scope filtering", async () => {
    const store = new MemoryLayerStore();
    await store.putLayer(layer([]));
    await store.putLayer({ ...layer([]), layerId: "tenant:acme", scope: "tenant", ownerId: "acme" });
    expect((await store.listLayers("layered")).length).toBe(2);
    expect((await store.listLayers("layered", "user")).map((l) => l.layerId)).toEqual(["user:erik"]);
    expect((await store.getLayer("user:erik"))?.ownerId).toBe("erik");
    await store.deleteLayer("user:erik");
    expect(await store.getLayer("user:erik")).toBeNull();
  });

  it("rebaseLayer drops-and-flags ops the new base broke, stamping the new baseVersion", () => {
    const moved = applyChangeset(base(), [{ op: "deleteNode", id: "a", orphans: "cascade" }]);
    const rebased = rebaseLayer(moved, layer([{ op: "updateNode", id: "a", patch: { title: "X" } }]));
    expect(rebased.baseVersion).toBe(moved.version);
    expect(rebased.conflicts).toHaveLength(1);
    expect(rebased.conflicts![0]!.reason).toContain("Unknown node id: a");
    expect(rebased.ops).toHaveLength(1); // ops never rewritten, only flagged
  });

  it("loadWithLayers materializes base ⊕ layers into an indexed graph", () => {
    const { graph, conflicts } = loadWithLayers(base(), [
      layer([
        { op: "addNode", parentId: "root", node: { id: "mine", parentId: "root", type: "category", title: "Mine", description: "m" } },
      ]),
    ]);
    expect(conflicts).toHaveLength(0);
    expect(graph.has("mine")).toBe(true);
  });
});

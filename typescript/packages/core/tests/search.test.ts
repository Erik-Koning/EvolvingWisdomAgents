import { describe, it, expect } from "vitest";
import { Graph, normalizeDocument, findNodes, listPropertyKeys, type GraphDoc } from "../src/index.js";

const doc: GraphDoc = {
  schemaVersion: "1.0",
  graphId: "search",
  profile: "L1",
  defaults: { routing: { descriptor: ["title", "props.learn"] } },
  nodes: [
    { id: "root", parentId: null, type: "category", title: "Wisdom", description: "root" },
    { id: "goals", parentId: "root", type: "category", title: "Goals",
      props: { learn: "ambitions, plans, timelines" } },
    { id: "kn-goals-1", parentId: "goals", type: "category", routable: false,
      prompt: { slots: { knowledge: "Wants to retire at 45." } },
      props: { source: "chat" } },
    { id: "interests", parentId: "root", type: "category", title: "Interests",
      aliases: ["hobbies"], props: { learn: "hobbies and passions" } },
  ],
};

const graph = new Graph(normalizeDocument(doc));

describe("findNodes", () => {
  it("searches the effective descriptor (including props.*) plus aliases by default", () => {
    expect(findNodes(graph, "ambitions").map((n) => n.id)).toEqual(["goals"]);
    expect(findNodes(graph, "hobbies").map((n) => n.id)).toEqual(["interests"]);
  });

  it("scopes to a single field and a subtree", () => {
    expect(findNodes(graph, "retire", { field: "title" })).toEqual([]);
    // object fields JSON-stringify, so knowledge text is findable via the prompt field
    expect(findNodes(graph, "retire", { field: "prompt" }).map((n) => n.id)).toEqual(["kn-goals-1"]);
    const hits = findNodes(graph, "chat", { field: "props.source", subtreeId: "goals" });
    expect(hits.map((n) => n.id)).toEqual(["kn-goals-1"]);
    expect(findNodes(graph, "chat", { field: "props.source", subtreeId: "interests" })).toEqual([]);
  });
});

describe("listPropertyKeys", () => {
  it("counts props keys graph-wide and per subtree", () => {
    expect(listPropertyKeys(graph)).toEqual({ learn: 2, source: 1 });
    expect(listPropertyKeys(graph, "goals")).toEqual({ learn: 1, source: 1 });
  });
});

import { describe, expect, it } from "vitest";
import {
  Graph,
  ScriptedLlm,
  addOps,
  approveChangeset,
  commitChangeset,
  createChangeset,
  discardChangeset,
  normalizeDocument,
  validateChangeset,
  type GraphDoc,
  type MutationOp,
} from "../src/index.js";

const doc = (): GraphDoc =>
  normalizeDocument({
    schemaVersion: "1.0",
    graphId: "lc",
    version: "1",
    profile: "L0",
    nodes: [
      { id: "root", parentId: null, type: "category", title: "R", description: "r" },
      { id: "a", parentId: "root", type: "category", title: "A", description: "aa" },
    ],
  });

const ADD_B: MutationOp[] = [
  { op: "addNode", parentId: "root", node: { id: "b", parentId: "root", type: "category", title: "B", description: "bb" } },
];

describe("changeset lifecycle", () => {
  it("walks draft → validated → approved → committed", async () => {
    const base = doc();
    let cs = createChangeset(base, "tester", "cs-1");
    cs = addOps(cs, ADD_B);
    cs = await validateChangeset(base, cs);
    expect(cs.status).toBe("validated");
    expect(cs.validation?.valid).toBe(true);
    cs = approveChangeset(cs);
    const { doc: next, changeset } = commitChangeset(base, cs);
    expect(changeset.status).toBe("committed");
    expect(new Graph(next).has("b")).toBe(true);
  });

  it("enforces strict transitions", async () => {
    const base = doc();
    let cs = createChangeset(base, "tester", "cs-2");
    cs = addOps(cs, ADD_B);
    expect(() => commitChangeset(base, cs)).toThrow('Cannot commit changeset in status "draft"');
    expect(() => approveChangeset(cs)).toThrow('Cannot approve changeset in status "draft"');
    const validated = await validateChangeset(base, cs);
    expect(() => addOps(validated, ADD_B)).toThrow('Cannot add ops to changeset in status "validated"');
  });

  it("a failing apply keeps the draft and records the failure", async () => {
    const base = doc();
    let cs = createChangeset(base, "tester", "cs-3");
    cs = addOps(cs, [{ op: "updateNode", id: "ghost", patch: { title: "X" } }]);
    cs = await validateChangeset(base, cs);
    expect(cs.status).toBe("draft");
    expect(cs.validation?.valid).toBe(false);
    expect(cs.validation?.errors[0]?.code).toBe("CHANGESET_APPLY_FAILED");
  });

  it("the regression gate blocks validation and reports traffic steal", async () => {
    const base = doc();
    let cs = createChangeset(base, "tester", "cs-4");
    cs = addOps(cs, ADD_B);
    const labeled = [{ query: "belongs to a", expected: "a" }];
    // the new node b steals the labeled query → stays draft
    const stolen = await validateChangeset(base, cs, {
      labeled,
      connectors: { llm: new ScriptedLlm({ classify: [{ matches: [{ nodeId: "b", confidence: 0.9 }] }] }) },
    });
    expect(stolen.status).toBe("draft");
    expect((stolen.regression as { stolen: unknown[] }).stolen).toHaveLength(1);
    // routing stays home → validated
    const ok = await validateChangeset(base, cs, {
      labeled,
      connectors: { llm: new ScriptedLlm({ classify: [{ matches: [{ nodeId: "a", confidence: 0.9 }] }] }) },
    });
    expect(ok.status).toBe("validated");
  });

  it("autoApprove commits straight from validated; discard works from approved", async () => {
    const base = doc();
    let cs = createChangeset(base, "tester", "cs-5");
    cs = addOps(cs, ADD_B);
    cs = await validateChangeset(base, cs);
    const { changeset } = commitChangeset(base, cs, { autoApprove: true });
    expect(changeset.status).toBe("committed");

    let cs2 = createChangeset(base, "tester", "cs-6");
    cs2 = addOps(cs2, ADD_B);
    cs2 = approveChangeset(await validateChangeset(base, cs2));
    expect(discardChangeset(cs2).status).toBe("discarded");
  });
});

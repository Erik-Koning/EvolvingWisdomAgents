// Edge cases beyond fixture 64 (which pins the cross-language contract):
// per-reason citation failures, conditional degrade classification for
// setBring/updateNode, and the new Memory stores. Mirrored in Python
// (tests/test_replay_gate.py).
import { describe, it, expect } from "vitest";
import {
  applyEvidenceGate,
  isDegradingOp,
  MemoryAgentStateStore,
  MemoryTranscriptStore,
  normalizeDocument,
  verifyCitation,
  type GraphDoc,
  type MutationOp,
  type Transcript,
} from "../src/index.js";

const doc = (): GraphDoc =>
  normalizeDocument({
    schemaVersion: "1.0",
    graphId: "g",
    profile: "L1",
    nodes: [
      { id: "root", parentId: null, title: "R", description: "r" },
      {
        id: "cat",
        parentId: "root",
        title: "C",
        description: "c",
        bring: ["kn-a", "kn-b"],
      },
      {
        id: "kn-a",
        parentId: "cat",
        routable: false,
        title: "A",
        description: "a",
        prompt: { slots: { knowledge: "prefers detailed weekly reports" } },
      },
      { id: "kn-b", parentId: "cat", routable: false, title: "B", description: "b" },
    ],
  } as unknown as GraphDoc);

const transcript = (role: "user" | "assistant", content: string): Transcript => ({
  id: "t1",
  turns: [{ role, content }],
});

describe("degrade classification", () => {
  it("setBring shrinking is degrading; superset/reorder is additive", () => {
    const d = doc();
    expect(isDegradingOp(d, { op: "setBring", id: "cat", bring: ["kn-a"] })).toBe(true);
    expect(isDegradingOp(d, { op: "setBring", id: "cat", bring: ["kn-b", "kn-a", "kn-x"] })).toBe(false);
  });

  it("updateNode: null-deleting a key or shortening a slot is degrading; growth and props bumps are additive", () => {
    const d = doc();
    expect(isDegradingOp(d, { op: "updateNode", id: "kn-a", patch: { prompt: { slots: { knowledge: null } } } })).toBe(true);
    expect(isDegradingOp(d, { op: "updateNode", id: "kn-a", patch: { prompt: { slots: { knowledge: "brief" } } } })).toBe(true);
    expect(
      isDegradingOp(d, {
        op: "updateNode",
        id: "kn-a",
        patch: { prompt: { slots: { knowledge: "prefers detailed weekly reports with NPV and churn metrics" } } },
      })
    ).toBe(false);
    expect(isDegradingOp(d, { op: "updateNode", id: "kn-a", patch: { props: { feedbackCount: 3 } } })).toBe(false);
  });

  it("moveNode/addNode are additive; mergeNodes/pruneSubtree always degrade", () => {
    const d = doc();
    expect(isDegradingOp(d, { op: "moveNode", id: "kn-a", newParentId: "root" })).toBe(false);
    expect(isDegradingOp(d, { op: "mergeNodes", ids: ["kn-b"], intoId: "kn-a" })).toBe(true);
    expect(isDegradingOp(d, { op: "pruneSubtree", id: "cat" })).toBe(true);
  });
});

describe("citation verification", () => {
  const ev = { opIndex: 0, quote: "I sold the kayak", transcriptId: "t1", turnIndex: 0 };

  it("reports the most specific failure per citation", () => {
    expect(verifyCitation(ev, [])).toBe("transcript-not-found");
    expect(verifyCitation({ ...ev, turnIndex: 5 }, [transcript("user", "I sold the kayak")])).toBe("turn-out-of-range");
    expect(verifyCitation(ev, [transcript("assistant", "I sold the kayak")])).toBe("not-user-turn");
    expect(verifyCitation(ev, [transcript("user", "kayaks are great")])).toBe("quote-not-found");
    expect(verifyCitation(ev, [transcript("user", "well, I sold \n  the kayak today")])).toBe(null);
  });
});

describe("applyEvidenceGate", () => {
  it("re-indexes kept evidence and reports dropped reasons", () => {
    const ops: MutationOp[] = [
      { op: "deleteNode", id: "kn-a", orphans: "cascade" },
      { op: "addNode", parentId: "cat", node: { id: "kn-c", parentId: "cat", title: "C2", description: "x" } },
      { op: "deleteNode", id: "kn-b", orphans: "cascade" },
    ];
    const result = applyEvidenceGate(
      doc(),
      ops,
      [
        { opIndex: 0, quote: "not actually said", transcriptId: "t1", turnIndex: 0 },
        { opIndex: 2, quote: "drop rule b", transcriptId: "t1", turnIndex: 0 },
      ],
      [transcript("user", "please drop rule b, it is stale")]
    );
    expect(result.kept.map((o) => o.op)).toEqual(["addNode", "deleteNode"]);
    expect(result.evidence).toEqual([{ opIndex: 1, quote: "drop rule b", transcriptId: "t1", turnIndex: 0 }]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({ opIndex: 0, reason: "quote-not-found" });
  });
});

describe("memory stores", () => {
  it("MemoryTranscriptStore.appendTurns creates on first append and accumulates", async () => {
    const store = new MemoryTranscriptStore();
    await store.appendTurns("t1", [{ role: "user", content: "hi" }]);
    const t = await store.appendTurns("t1", [{ role: "assistant", content: "hello" }]);
    expect(t.turns).toHaveLength(2);
    expect((await store.get("t1"))?.turns[1]).toMatchObject({ role: "assistant" });
    expect(await store.get("missing")).toBe(null);
  });

  it("MemoryTranscriptStore.list filters by graphId", async () => {
    const store = new MemoryTranscriptStore();
    await store.put({ id: "a", graphId: "g1", turns: [] });
    await store.put({ id: "b", graphId: "g2", turns: [] });
    expect((await store.list("g1")).map((t) => t.id)).toEqual(["a"]);
    expect(await store.list()).toHaveLength(2);
  });

  it("MemoryAgentStateStore round-trips state by agent", async () => {
    const store = new MemoryAgentStateStore();
    expect(await store.getState("sage")).toBe(null);
    await store.putState("sage", { lastSleepAt: 5, pressure: [] });
    expect(await store.getState("sage")).toEqual({ lastSleepAt: 5, pressure: [] });
  });
});

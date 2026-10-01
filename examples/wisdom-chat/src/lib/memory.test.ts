// The memory-system safety core, tested offline: per-agent locking, app-level
// CAS (user-writes-win), sleep orchestration guards, the pinned-node guard,
// the philosophy-pressure ledger, and the transcendence engine (drift cap,
// draft approval, conservative invalidation). ScriptedLlm plays every review;
// drift uses the Levenshtein fallback (no vector keys in the test env).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Graph, ScriptedLlm, type LlmConnector, type MutationOp } from "@apgraph/core";
import { AGENTS, memoryPolicy, transcendencePolicy } from "./agents";
import {
  ConflictError,
  commitOps,
  getAgentState,
  getProposal,
  listProposals,
  loadAgentDocFresh,
  loadAgentGraph,
  putAgentState,
  saveAgentDoc,
  withAgentLock,
} from "./store";
import { buildConsolidationOps, consolidate, maybeSleep } from "./consolidate";
import { approveAmendment, driftSimilarity, maybeProposeFromPressure } from "./transcend";
import { bagOfWordsVectors, maybeGrow } from "./grow";
import { changesetStore } from "./store";
import { charterText } from "./wisdom";

const sage = AGENTS.sage;
const envBackup: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ["WISDOM_DATA_DIR", "VOYAGE_API_KEY", "OPENAI_API_KEY", "SLEEP_COOLDOWN_MS", "AMEND_COOLDOWN_MS"]) {
    envBackup[key] = process.env[key];
  }
  process.env.WISDOM_DATA_DIR = mkdtempSync(join(tmpdir(), "wisdom-mem-"));
  delete process.env.VOYAGE_API_KEY; // force the Levenshtein drift fallback
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function addRuleOps(categoryId: string, ids: string[], graph: Graph, pinned: string[] = []): MutationOp[] {
  const ops: MutationOp[] = ids.map((id) => ({
    op: "addNode",
    parentId: categoryId,
    node: {
      id,
      parentId: categoryId,
      type: "category",
      routable: false,
      ...(pinned.includes(id) ? { pinned: true } : {}),
      prompt: { slots: { knowledge: `Fact ${id}.` } },
      props: { source: "chat", feedbackCount: 1 },
    },
  }));
  ops.push({ op: "setBring", id: categoryId, bring: [...(graph.get(categoryId).bring ?? []), ...ids] });
  return ops;
}

describe("safe-write layer", () => {
  it("withAgentLock serializes concurrent writers", async () => {
    const order: number[] = [];
    await Promise.all([
      withAgentLock("sage", async () => {
        await new Promise((r) => setTimeout(r, 25));
        order.push(1);
      }),
      withAgentLock("sage", async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("CAS rejects a save whose expected version moved", async () => {
    const { doc } = await loadAgentGraph(sage); // seeds from the template
    await expect(
      saveAgentDoc(sage, doc, { actor: "manual", summary: "stale", expectedVersion: "not-the-version" }),
    ).rejects.toThrow(ConflictError);
  });

  it("commitOps: maintenance aborts on a moved base, user-initiated retries", async () => {
    const { doc, graph } = await loadAgentGraph(sage);
    const v0 = doc.version!;
    // someone else commits first
    await commitOps(sage, v0, addRuleOps("interests", ["kn-i-1"], graph), {
      actor: "manual",
      summary: "concurrent write",
      retry: false,
    });
    const opsB = addRuleOps("interests", ["kn-i-2"], graph); // built against the stale graph
    await expect(
      commitOps(sage, v0, opsB, { actor: "sleep", summary: "maintenance", retry: false }),
    ).rejects.toThrow(ConflictError);
    const committed = await commitOps(sage, v0, opsB, { actor: "feedback", summary: "user", retry: true });
    const g = new Graph(committed);
    expect(g.has("kn-i-1") && g.has("kn-i-2")).toBe(true);
    expect(g.get("interests").bring).toContain("kn-i-2");
  });
});

describe("sleep orchestration", () => {
  it("skips below threshold, honors cooldown for auto but not manual", async () => {
    process.env.SLEEP_COOLDOWN_MS = "3600000";
    const idle = await maybeSleep("shop", "idle", new ScriptedLlm({}));
    expect(idle).toMatchObject({ ran: false, skipped: "threshold" });

    // push a category over the threshold, then set a recent sleep
    const { doc, graph } = await loadAgentGraph(sage);
    await commitOps(sage, doc.version, addRuleOps("goals", ["g1", "g2", "g3", "g4", "g5", "g6"], graph), {
      actor: "manual",
      summary: "seed",
      retry: false,
    });
    putAgentState(sage.id, { ...getAgentState(sage.id), lastSleepAt: new Date().toISOString() });

    const cooled = await maybeSleep(sage.id, "idle", new ScriptedLlm({}));
    expect(cooled).toMatchObject({ ran: false, skipped: "cooldown" });

    // manual bypasses cooldown; an all-clean review is a no-op run
    const manual = await maybeSleep(sage.id, "manual", new ScriptedLlm({ extract: [{ vars: {} }] }));
    expect(manual).toMatchObject({ ran: false, skipped: "no-op" });
  });

  it("aborts on a mid-sleep user write (user wins) and reports the conflict", async () => {
    const conflictingLlm: LlmConnector = {
      classify: async () => [],
      extract: async () => {
        // a user write lands while the review is thinking
        const { doc, graph } = await loadAgentGraph(sage);
        await commitOps(sage, doc.version, addRuleOps("interests", [`kn-mid-${Date.now().toString(36)}`], graph), {
          actor: "feedback",
          summary: "mid-sleep user write",
          retry: true,
        });
        return { merges: [{ keepId: "g1", absorbIds: ["g2"], mergedText: "Merged fact." }] };
      },
    };
    const result = await maybeSleep(sage.id, "manual", conflictingLlm);
    expect(result).toMatchObject({ ran: false, skipped: "conflict" });
    // the user's write survived; the sleep's merge was discarded
    const { graph } = await loadAgentGraph(sage);
    expect(graph.has("g2")).toBe(true);
  });

  it("pinned nodes are untouchable by reviews", async () => {
    const { doc, graph } = await loadAgentGraph(sage);
    const committed = await commitOps(sage, doc.version, addRuleOps("life-philosophy", ["p1", "p2"], graph, ["p1"]), {
      actor: "manual",
      summary: "seed pinned",
      retry: true,
    });
    const g = new Graph(committed);
    const { summary } = buildConsolidationOps(g, committed, "life-philosophy", {
      merges: [{ keepId: "p2", absorbIds: ["p1"], mergedText: "absorb the pinned one" }],
      retires: [{ id: "p1" }],
      priorities: [{ id: "p1", weight: 5 }],
    });
    expect(summary).toMatchObject({ merged: 0, retired: 0, reranked: 0 });
  });
});

describe("pressure ledger + transcendence", () => {
  it("sleep logs philosophy conflicts to the ledger without retiring, and dedupes", async () => {
    putAgentState(sage.id, { ...getAgentState(sage.id), lastSleepAt: null, pressure: [] });
    const review = {
      philosophyConflicts: [{ id: "g1", note: "contradicts the charter" }],
    };
    const first = await consolidate(sage.id, new ScriptedLlm({ extract: [{ vars: review }] }));
    expect(first.conflicts).toHaveLength(1);
    const after1 = getAgentState(sage.id).pressure.filter((p) => p.status === "open");
    expect(after1).toHaveLength(1);
    // g1 still exists — conflicts never retire
    expect((await loadAgentGraph(sage)).graph.has("g1")).toBe(true);

    await consolidate(sage.id, new ScriptedLlm({ extract: [{ vars: review }] }));
    expect(getAgentState(sage.id).pressure.filter((p) => p.status === "open")).toHaveLength(1);
  });

  it("drift cap rejects a radical amendment (Levenshtein fallback), passes a minimal one", async () => {
    const policy = transcendencePolicy(0.6); // floor 0.7
    const { graph } = await loadAgentGraph(sage);
    const constraints = charterText(graph, sage.rootId);
    expect(await driftSimilarity(constraints, constraints + " Also note tax.")).toBeGreaterThan(policy.driftFloor);
    expect(await driftSimilarity(constraints, "Totally new being with a brand new philosophy.")).toBeLessThan(
      policy.driftFloor,
    );
  });

  it("pressure at threshold yields a draft; drift violation yields a rejected proposal", async () => {
    process.env.AMEND_COOLDOWN_MS = "0";
    const { doc, graph } = await loadAgentGraph(sage);
    const policy = memoryPolicy(sage, doc.meta); // score 0.6 → threshold 5, slots constraints+task
    const pressure = ["g1", "g2", "g3", "g4", "g5"].map((nodeId) => ({
      nodeId,
      note: "conflicts with charter",
      at: new Date().toISOString(),
      status: "open" as const,
    }));
    putAgentState(sage.id, { ...getAgentState(sage.id), pressure, lastAmendProposedAt: null, lastAmendAt: null });

    const currentConstraints = (graph.get(sage.rootId).prompt as { slots: Record<string, string> }).slots.constraints!;

    // radical rewrite → drift rejection (kept on file for the audit trail)
    const radical = await maybeProposeFromPressure(sage, doc, policy, new ScriptedLlm({
      extract: [{ vars: { amendments: [{ slot: "constraints", revisedText: "Be entirely different now.", rationale: "r" }], label: "radical" } }],
    }));
    expect(radical.proposal).toBeNull();
    expect(radical.rejected?.reason).toBe("drift");
    expect(listProposals(sage.id, "rejected").length).toBeGreaterThan(0);

    // minimal amendment but the verifier flags a commitment inversion → rejected
    const inverted = await maybeProposeFromPressure(sage, doc, policy, new ScriptedLlm({
      extract: [
        { vars: { amendments: [{ slot: "constraints", revisedText: `${currentConstraints} Reciting knowledge as a list is encouraged.`, rationale: "r" }], label: "inverting" } },
        { vars: { inverts: true, note: "reverses the never-recite rule" } },
      ],
    }));
    expect(inverted.proposal).toBeNull();
    expect(inverted.rejected?.reason).toBe("inversion");

    // minimal, non-inverting amendment → draft (drift + inversion both pass)
    const minimal = await maybeProposeFromPressure(sage, doc, policy, new ScriptedLlm({
      extract: [
        { vars: { amendments: [{ slot: "constraints", revisedText: `${currentConstraints} Prefer seasons of sprint and rest.`, rationale: "evidence shows cyclical effort" }], label: "seasons amendment" } },
        { vars: { inverts: false } },
      ],
    }));
    expect(minimal.proposal?.status).toBe("draft");
  });

  it("approval applies the amendment, consumes evidence, and leaves the hash stale for reconsolidation", async () => {
    const draft = listProposals(sage.id, "draft")[0]!;
    const before = getAgentState(sage.id);
    expect(before.identityHash).not.toBeNull();

    const approved = await approveAmendment(draft.id);
    expect(approved.status).toBe("approved");
    const { doc, graph } = await loadAgentGraph(sage);
    expect(charterText(graph, sage.rootId)).toContain("seasons of sprint and rest");
    expect(doc.version).not.toBe(draft.fromVersion);

    const state = getAgentState(sage.id);
    expect(state.pressure.filter((p) => p.status === "consumed")).toHaveLength(5);
    expect(state.identityHash).toBe(before.identityHash); // stale on purpose
  });

  it("deep sleep: a saturated misfit pool becomes a regression-gated growth draft", async () => {
    const coffee = [
      "Enjoys espresso coffee brewing every morning.",
      "Espresso coffee brewing gear fills the kitchen.",
      "Reads about espresso coffee brewing techniques.",
    ];
    const kayak = [
      "Enjoys river kayak paddling on weekends.",
      "River kayak paddling gear is expensive.",
      "Plans more river kayak paddling trips.",
    ];
    // lexical vectors separate the two themes cleanly
    const vectors = bagOfWordsVectors([...coffee, ...kayak]);
    expect(vectors).toHaveLength(6);

    const { doc, graph } = await loadAgentGraph(sage);
    const ids = [...coffee, ...kayak].map((_, i) => `g-obs-${i}`);
    const ops = ids.map((id, i) => ({
      op: "addNode" as const,
      parentId: "observations",
      node: {
        id, parentId: "observations", type: "category" as const, routable: false,
        prompt: { slots: { knowledge: [...coffee, ...kayak][i]! } }, props: { source: "chat" },
      },
    }));
    const committed = await commitOps(
      sage,
      doc.version,
      [...ops, { op: "setBring", id: "observations", bring: [...(graph.get("observations").bring ?? []), ...ids] }],
      { actor: "manual", summary: "seed misfits", retry: true },
    );

    // scripted: 1 naming call, then classify per labeled query (4 from
    // meta.regression + 2 exemplars) — everything routes home
    const g = new Graph(committed);
    const scripted = new ScriptedLlm({
      extract: [{ vars: { clusters: [
        { index: 0, title: "Coffee", learn: "espresso and brewing preferences", slug: "coffee" },
        { index: 1, title: "Kayaking", learn: "paddling and river trips", slug: "kayaking" },
      ] } }],
      classify: [
        { matches: [{ nodeId: "life-philosophy", confidence: 0.9 }] },
        { matches: [{ nodeId: "goals", confidence: 0.9 }] },
        { matches: [{ nodeId: "interests", confidence: 0.9 }] },
        { matches: [{ nodeId: "observations", confidence: 0.9 }] },
        { matches: [{ nodeId: "cat-coffee", confidence: 0.9 }] },
        { matches: [{ nodeId: "cat-kayaking", confidence: 0.9 }] },
      ],
    });
    const growth = await maybeGrow(sage, committed, g, scripted);
    expect(growth).not.toBeNull();
    expect(growth!.vectorMode).toBe("lexical");
    expect(growth!.status).toBe("validated");
    expect(growth!.newCategories.map((c) => c.id).sort()).toEqual(["cat-coffee", "cat-kayaking"]);

    const stored = await changesetStore().get(growth!.changesetId);
    expect(stored?.status).toBe("validated");
    // the draft never touched the live graph
    expect((await loadAgentGraph(sage)).graph.has("cat-coffee")).toBe(false);
  });

  it("a draft is invalidated when the charter moved since it was drafted", async () => {
    process.env.AMEND_COOLDOWN_MS = "0";
    const { doc } = await loadAgentDocFresh(sage).then((d) => ({ doc: d }));
    putAgentState(sage.id, {
      ...getAgentState(sage.id),
      pressure: [{ nodeId: "g3", note: "again", at: new Date().toISOString(), status: "open" }],
      lastAmendProposedAt: null,
      lastAmendAt: null,
    });
    const policy = { ...memoryPolicy(sage, doc.meta) };
    policy.transcendence = { ...policy.transcendence, pressureThreshold: 1 };
    const constraints = (new Graph(doc).get(sage.rootId).prompt as { slots: Record<string, string> }).slots.constraints!;
    const outcome = await maybeProposeFromPressure(sage, doc, policy, new ScriptedLlm({
      extract: [
        { vars: { amendments: [{ slot: "constraints", revisedText: `${constraints} Minor addition.`, rationale: "r" }], label: "stale-to-be" } },
        { vars: { inverts: false } },
      ],
    }));
    expect(outcome.proposal?.status).toBe("draft");

    // the charter changes before anyone approves
    await commitOps(sage, doc.version, [
      { op: "updateNode", id: sage.rootId, patch: { prompt: { slots: { constraints: `${constraints} Changed meanwhile.` } } } },
    ], { actor: "manual", summary: "charter moved", retry: true });

    const resolved = await approveAmendment(outcome.proposal!.id);
    expect(resolved.status).toBe("invalidated");
    expect(getProposal(outcome.proposal!.id)?.status).toBe("invalidated");
  });
});

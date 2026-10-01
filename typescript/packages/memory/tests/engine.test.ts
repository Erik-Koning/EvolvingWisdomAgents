// Deterministic engine tests: ScriptedLlm plays every extract/classify in
// call order, Memory* stores isolate each test, the clock is injected.
import { describe, it, expect } from "vitest";
import {
  Graph,
  MemoryAgentStateStore,
  MemoryChangesetStore,
  MemoryGraphStore,
  MemoryTranscriptStore,
  ScriptedLlm,
  applyChangeset,
  normalizeDocument,
  type GraphDoc,
  type LlmConnector,
} from "@apgraph/core";
import {
  digestFeedback,
  finalizeAmendment,
  getEngineState,
  harvestTurns,
  resolvePolicy,
  runReplay,
  runSleep,
  transcendencePolicy,
  type AuditEntry,
  type MemoryDeps,
} from "../src/index.js";

const GRAPH_ID = "g";

function seedDoc(): GraphDoc {
  return normalizeDocument({
    schemaVersion: "1.0",
    graphId: GRAPH_ID,
    profile: "L3",
    version: "1-0",
    meta: { regression: [{ query: "what does he like", expected: "interests" }] },
    nodes: [
      {
        id: "root",
        parentId: null,
        title: "Sage",
        description: "companion",
        prompt: { slots: { persona: "You are Sage, a thoughtful companion.", constraints: "Never give medical advice." } },
      },
      {
        id: "interests",
        parentId: "root",
        title: "Interests",
        description: "hobbies and interests he enjoys",
        props: { learn: "hobbies and interests" },
        bring: ["kn-espresso", "kn-kayak"],
      },
      {
        id: "observations",
        parentId: "root",
        title: "Observations",
        description: "misfit observations pool",
        isFallback: true,
        props: { learn: "anything that fits nowhere else" },
        bring: [],
      },
      {
        id: "kn-espresso",
        parentId: "interests",
        routable: false,
        title: "espresso",
        description: "espresso",
        prompt: { slots: { knowledge: "Enjoys espresso brewing every morning." } },
        props: { source: "chat", feedbackCount: 1 },
      },
      {
        id: "kn-kayak",
        parentId: "interests",
        routable: false,
        title: "kayak",
        description: "kayak",
        prompt: { slots: { knowledge: "Owns a kayak and paddles on weekends." } },
        props: { source: "chat", feedbackCount: 1 },
      },
    ],
  } as unknown as GraphDoc);
}

interface Harness {
  deps: MemoryDeps;
  store: MemoryGraphStore;
  transcripts: MemoryTranscriptStore;
  changesets: MemoryChangesetStore;
  audits: AuditEntry[];
}

async function harness(llm: LlmConnector, doc: GraphDoc = seedDoc()): Promise<Harness> {
  const store = new MemoryGraphStore();
  await store.save(doc);
  const transcripts = new MemoryTranscriptStore();
  const changesets = new MemoryChangesetStore();
  const audits: AuditEntry[] = [];
  let tick = 0;
  const deps: MemoryDeps = {
    graphId: GRAPH_ID,
    store,
    llm,
    transcripts,
    changesets,
    state: new MemoryAgentStateStore(),
    audit: (e) => audits.push(e),
    now: () => 1_700_000_000_000 + ++tick * 1000,
  };
  return { deps, store, transcripts, changesets, audits };
}

describe("policy", () => {
  it("resolves defaults ⊕ meta.memory ⊕ host override, score re-derives dials", () => {
    const doc = seedDoc();
    (doc.meta as Record<string, unknown>)["memory"] = { sleep: { threshold: 3 }, transcendence: { score: 0.5 } };
    const policy = resolvePolicy(doc, { transcendence: { driftFloor: 0.42 } });
    expect(policy.sleep.threshold).toBe(3);
    expect(policy.transcendence.amendableSlots).toEqual(["constraints", "task"]);
    expect(policy.transcendence.driftFloor).toBe(0.42);
    expect(transcendencePolicy(0).pressureThreshold).toBe(Infinity);
  });
});

describe("replay", () => {
  const turns = (contents: Array<[string, string]>) =>
    contents.map(([role, content]) => ({ role: role as "user" | "assistant", content }));

  it("commits additive candidates, advances watermarks, and ends with sleep", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: {
          candidates: [
            { kind: "add", text: "Started learning the cello this spring.", categoryId: "interests" },
            { kind: "reinforce", text: "espresso", targetNodeId: "kn-espresso" },
          ],
        } },
      ],
    });
    const h = await harness(llm);
    await h.transcripts.put({
      id: "t1",
      graphId: GRAPH_ID,
      turns: turns([
        ["user", "I picked up the cello this spring"],
        ["assistant", "wonderful!"],
      ]),
    });

    const report = await runReplay(h.deps, {});
    expect(report.ran).toBe(true);
    expect(report.added).toHaveLength(1);
    expect(report.reinforced).toEqual([{ nodeId: "kn-espresso", text: "espresso" }]);
    expect(report.changesetId).toMatch(/^replay-/);
    // watermark advanced
    expect((await h.transcripts.get("t1"))?.replayedUpTo).toBe(2);
    // committed to the store, not just returned
    const doc = await h.store.load(GRAPH_ID);
    const graph = new Graph(doc);
    expect(graph.get("interests").bring).toContain("kn-interests-1");
    expect(graph.get("kn-espresso").props?.["feedbackCount"]).toBe(2);
    // replay → sleep ordering visible in the report (threshold-skipped here)
    expect(report.sleep?.skipped).toBe("threshold");
    expect(h.audits[0]?.actor).toBe("replay");
  });

  it("drops an uncited retire to the pressure ledger; a cited retire applies", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: {
          candidates: [
            { kind: "retire", text: "espresso rule", targetNodeId: "kn-espresso" }, // no quote → dropped
            {
              kind: "retire",
              text: "kayak rule",
              targetNodeId: "kn-kayak",
              quote: "I sold the kayak",
              turnIndex: 0,
            },
          ],
        } },
      ],
    });
    const h = await harness(llm);
    await h.transcripts.put({
      id: "t1",
      graphId: GRAPH_ID,
      turns: turns([["user", "I sold the kayak last month, done with paddling"]]),
    });

    const report = await runReplay(h.deps, { sleep: false });
    expect(report.degradesDropped).toEqual([{ nodeId: "kn-espresso", kind: "retire", reason: "no-citation" }]);
    expect(report.degradesApplied).toMatchObject([{ nodeId: "kn-kayak", kind: "retire" }]);
    const graph = new Graph(await h.store.load(GRAPH_ID));
    expect(graph.has("kn-kayak")).toBe(false);
    expect(graph.has("kn-espresso")).toBe(true);
    expect(graph.get("interests").bring).toEqual(["kn-espresso"]);
    // the doubt is on the ledger, not applied
    const state = await getEngineState(h.deps);
    expect(state.pressure).toMatchObject([{ nodeId: "kn-espresso", status: "open" }]);
    // the committed changeset carries the verified citation
    const cs = (await h.changesets.list()).find((c) => c.id === report.changesetId);
    expect(cs?.evidence).toHaveLength(1);
    expect(cs?.evidence?.[0]?.quote).toBe("I sold the kayak");
  });

  it("rejects a retire quoting the assistant", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: {
          candidates: [
            {
              kind: "retire",
              text: "espresso",
              targetNodeId: "kn-espresso",
              quote: "you seem tired of espresso",
              turnIndex: 1,
            },
          ],
        } },
      ],
    });
    const h = await harness(llm);
    await h.transcripts.put({
      id: "t1",
      graphId: GRAPH_ID,
      turns: turns([
        ["user", "morning"],
        ["assistant", "you seem tired of espresso lately"],
      ]),
    });
    const report = await runReplay(h.deps, { sleep: false });
    expect(report.degradesDropped).toEqual([{ nodeId: "kn-espresso", kind: "retire", reason: "not-user-turn" }]);
    expect(new Graph(await h.store.load(GRAPH_ID)).has("kn-espresso")).toBe(true);
  });

  it("dedups an add into reinforcement of the existing rule", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: {
          candidates: [
            { kind: "add", text: "Enjoys espresso brewing every morning.", categoryId: "interests" },
          ],
        } },
      ],
    });
    const h = await harness(llm);
    await h.transcripts.put({ id: "t1", graphId: GRAPH_ID, turns: turns([["user", "espresso again this morning"]]) });
    const report = await runReplay(h.deps, { sleep: false });
    expect(report.added).toHaveLength(0);
    expect(report.reinforced).toMatchObject([{ nodeId: "kn-espresso" }]);
  });

  it("dryRun extracts and gates without committing, advancing, or sleeping", async () => {
    const llm = new ScriptedLlm({
      extract: [{ vars: { candidates: [{ kind: "add", text: "Collects vintage maps.", categoryId: "interests" }] } }],
    });
    const h = await harness(llm);
    await h.transcripts.put({ id: "t1", graphId: GRAPH_ID, turns: turns([["user", "I collect vintage maps"]]) });
    const report = await runReplay(h.deps, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.added).toHaveLength(1);
    expect(report.changesetId).toBe(null);
    expect(report.sleep).toBe(null);
    expect((await h.transcripts.get("t1"))?.replayedUpTo).toBeUndefined();
    expect((await h.store.load(GRAPH_ID)).version).toBe("1-0");
  });

  it("aborts the whole batch when a user write races it (maintenance loses)", async () => {
    let raced = false;
    const llm: LlmConnector = {
      classify: async () => [],
      extract: async (input) => {
        if (!raced) {
          raced = true;
          // a "user write" lands while replay is extracting
          const fresh = await h.store.load(GRAPH_ID);
          await h.store.save(applyChangeset(fresh, [{ op: "updateNode", id: "kn-espresso", patch: { props: { feedbackCount: 9 } } }]));
          return { candidates: [{ kind: "add", text: "Collects vintage maps.", categoryId: "interests" }] };
        }
        void input;
        return {};
      },
    };
    const h = await harness(llm);
    await h.transcripts.put({ id: "t1", graphId: GRAPH_ID, turns: [{ role: "user", content: "maps" }] });
    const report = await runReplay(h.deps, { sleep: false });
    expect(report.skipped).toBe("conflict");
    expect(report.changesetId).toBe(null);
    expect((await h.transcripts.get("t1"))?.replayedUpTo).toBeUndefined(); // watermark NOT advanced
    const graph = new Graph(await h.store.load(GRAPH_ID));
    expect(graph.get("kn-espresso").props?.["feedbackCount"]).toBe(9); // user write intact
    expect(graph.has("kn-interests-1")).toBe(false);
  });
});

const rules = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `kn-r${i}`,
    parentId: "interests",
    routable: false as const,
    title: `r${i}`,
    description: `r${i}`,
    prompt: { slots: { knowledge: `Standing rule number ${i}.` } },
    props: { source: "chat", feedbackCount: 1 },
  }));

function fatDoc(): GraphDoc {
  const doc = seedDoc();
  return applyChangeset(doc, [
    ...rules(5).map((node) => ({ op: "addNode" as const, parentId: "interests", node })),
    { op: "setBring", id: "interests", bring: ["kn-espresso", "kn-kayak", ...rules(5).map((r) => r.id)] },
  ]);
}

describe("sleep", () => {
  it("threshold-gates, then merges via review and stamps state", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: {
          merges: [{ keepId: "kn-r0", absorbIds: ["kn-r1"], mergedText: "Merged standing rule zero and one." }],
          retires: [{ id: "kn-r2" }],
          priorities: [{ id: "kn-espresso", weight: 5 }],
        } },
      ],
    });
    const h = await harness(llm, fatDoc());
    const result = await runSleep(h.deps, { manual: true });
    expect(result.ran).toBe(true);
    expect(result.categories).toEqual([{ categoryId: "interests", merged: 1, retired: 1, reranked: 1 }]);
    const graph = new Graph(await h.store.load(GRAPH_ID));
    expect(graph.has("kn-r1")).toBe(false);
    expect(graph.has("kn-r2")).toBe(false);
    expect(graph.get("kn-espresso").composition?.priority).toBe(800);
    const state = await getEngineState(h.deps);
    expect(state.lastSleepAt).not.toBe(null);
    expect(state.identityHash).not.toBe(null);
    expect(h.audits[0]?.actor).toBe("sleep");
  });

  it("cooldown skips automatic sleep but not manual", async () => {
    const llm = new ScriptedLlm({ extract: [{ vars: {} }, { vars: {} }, { vars: {} }] });
    const h = await harness(llm, fatDoc());
    await runSleep(h.deps, { manual: true }); // stamps lastSleepAt (no-op review)
    const auto = await runSleep(h.deps, {});
    expect(auto.skipped).toBe("cooldown");
    const manual = await runSleep(h.deps, { manual: true });
    expect(manual.skipped).toBe("no-op");
  });

  it("philosophy conflicts land on the pressure ledger, never retired", async () => {
    const llm = new ScriptedLlm({
      extract: [{ vars: { philosophyConflicts: [{ id: "kn-r0", note: "contradicts the charter" }] } }],
    });
    const h = await harness(llm, fatDoc());
    const result = await runSleep(h.deps, { manual: true });
    expect(result.conflictsLogged).toBe(1);
    const state = await getEngineState(h.deps);
    // no transcript provenance on kn-r0 → no citation call spent, marked inferred
    expect(state.pressure).toMatchObject([{ nodeId: "kn-r0", status: "open", inferred: true }]);
    expect(state.pressure[0]?.citation).toBeUndefined();
    expect(new Graph(await h.store.load(GRAPH_ID)).has("kn-r0")).toBe(true);
  });
});

describe("transcendence via sleep pressure", () => {
  function pressureDoc(): GraphDoc {
    const doc = seedDoc();
    (doc.meta as Record<string, unknown>)["memory"] = {
      sleep: { threshold: 2 },
      // driftFloor relaxed: the keyless Levenshtein proxy scores additions
      // harshly, and these tests target the inversion/approval paths;
      // inferredWeight pinned to 1 — citation weighting has its own suite
      transcendence: { score: 0.6, pressureThreshold: 1, cooldownMs: 0, driftFloor: 0.3, inferredWeight: 1 },
    };
    return doc;
  }

  it("pressure ≥ threshold drafts a validated amendment changeset", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-espresso", note: "espresso vs calm mornings" }] } }, // review
        { vars: {
          amendments: [
            { slot: "constraints", revisedText: "Never give medical advice. Mornings may be lively.", rationale: "lived pattern" },
          ],
          label: "lively mornings",
        } },
        { vars: { inverts: false } }, // inversion verifier
      ],
    });
    const h = await harness(llm, pressureDoc());
    const result = await runSleep(h.deps, { manual: true });
    expect(result.proposal?.changeset?.status).toBe("validated");
    const meta = result.proposal?.changeset?.meta as { kind?: string; drift?: Record<string, number> };
    expect(meta.kind).toBe("amendment");
    expect(meta.drift?.["constraints"]).toBeGreaterThan(0.3);
    // draft never touched the live graph
    const graph = new Graph(await h.store.load(GRAPH_ID));
    expect(graph.get("root").prompt).toMatchObject({ slots: { constraints: "Never give medical advice." } });
  });

  it("an inverting revision is rejected and kept on file as discarded", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-espresso", note: "conflict" }] } },
        { vars: {
          amendments: [
            { slot: "constraints", revisedText: "Never give medical advice? Give medical advice freely.", rationale: "x" },
          ],
          label: "inversion attempt",
        } },
        { vars: { inverts: true, note: "medical advice commitment inverted" } },
      ],
    });
    const h = await harness(llm, pressureDoc());
    const result = await runSleep(h.deps, { manual: true });
    expect(result.proposal?.rejected?.reason).toBe("inversion");
    const kept = (await h.changesets.list()).filter((c) => c.status === "discarded");
    expect(kept).toHaveLength(1);
    expect((kept[0]?.meta as { rejected?: { reason: string } }).rejected?.reason).toBe("inversion");
  });
});

describe("pressure citations (library-roadmap #8)", () => {
  // kn-r0 carries transcript provenance (as harvest stamps it); default
  // inferredWeight (0.5) is in effect — cited entries weigh 1
  function citedDoc(): GraphDoc {
    const doc = applyChangeset(fatDoc(), [
      { op: "updateNode", id: "kn-r0", patch: { props: { transcriptId: "t1" } } },
    ]);
    (doc.meta as Record<string, unknown>)["memory"] = {
      transcendence: { score: 0.6, pressureThreshold: 1, cooldownMs: 0, driftFloor: 0.3 },
    };
    return doc;
  }

  it("a verified user quote lands on the ledger and carries full weight", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-r0", note: "casual tone conflicts with the charter" }] } },
        { vars: { found: true, turnIndex: 0, quote: "keep it casual with me" } }, // citation pass
        { vars: {
          amendments: [
            { slot: "constraints", revisedText: "Never give medical advice. Keep a casual tone.", rationale: "lived preference" },
          ],
          label: "casual tone",
        } },
        { vars: { inverts: false } },
      ],
    });
    const h = await harness(llm, citedDoc());
    await h.transcripts.put({
      id: "t1",
      graphId: GRAPH_ID,
      turns: [
        { role: "user", content: "honestly, keep it casual with me — I hate formal replies" },
        { role: "assistant", content: "noted!" },
      ],
    });

    const result = await runSleep(h.deps, { manual: true });
    const state = await getEngineState(h.deps);
    expect(state.pressure).toMatchObject([
      { nodeId: "kn-r0", status: "open", citation: { transcriptId: "t1", turnIndex: 0, quote: "keep it casual with me" } },
    ]);
    expect(state.pressure[0]?.inferred).toBeUndefined();
    // cited weight 1 ≥ threshold 1 → the proposal fires in the same sleep
    expect(result.proposal?.changeset?.status).toBe("validated");
    // the human gate sees the receipt
    const meta = result.proposal?.changeset?.meta as { evidence?: Array<{ note: string; citation?: { quote: string } }> };
    expect(meta.evidence?.[0]?.citation?.quote).toBe("keep it casual with me");
    expect(meta.evidence?.[0]?.note).toContain('user said: "keep it casual with me"');
  });

  it("a quote that fails mechanical verification marks the entry inferred (reduced weight)", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-r0", note: "conflict" }] } },
        // quotes the ASSISTANT turn — verifyCitation rejects (not-user-turn)
        { vars: { found: true, turnIndex: 1, quote: "you seem to dislike formality" } },
      ],
    });
    const h = await harness(llm, citedDoc());
    await h.transcripts.put({
      id: "t1",
      graphId: GRAPH_ID,
      turns: [
        { role: "user", content: "morning" },
        { role: "assistant", content: "you seem to dislike formality" },
      ],
    });

    const result = await runSleep(h.deps, { manual: true });
    const state = await getEngineState(h.deps);
    expect(state.pressure).toMatchObject([{ nodeId: "kn-r0", status: "open", inferred: true }]);
    expect(state.pressure[0]?.citation).toBeUndefined();
    // inferred weight 0.5 < threshold 1 → no proposal yet
    expect(result.proposal?.changeset).toBe(null);
    expect(result.proposal?.rejected).toBeUndefined();
  });

  it("inferred conflicts accumulate at half weight until the threshold is met", async () => {
    const doc = fatDoc(); // no transcript provenance anywhere → all inferred
    (doc.meta as Record<string, unknown>)["memory"] = {
      transcendence: { score: 0.6, pressureThreshold: 1, cooldownMs: 0, driftFloor: 0.3 },
    };
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-r0", note: "first doubt" }] } }, // sleep 1 review
        { vars: { philosophyConflicts: [{ id: "kn-r3", note: "second doubt" }] } }, // sleep 2 review
        { vars: {
          amendments: [{ slot: "constraints", revisedText: "Never give medical advice, stated gently.", rationale: "x" }],
          label: "gentle phrasing",
        } },
        { vars: { inverts: false } },
      ],
    });
    const h = await harness(llm, doc);

    const first = await runSleep(h.deps, { manual: true });
    expect(first.proposal?.changeset).toBe(null); // 0.5 < 1

    const second = await runSleep(h.deps, { manual: true });
    expect(second.proposal?.changeset?.status).toBe("validated"); // 0.5 + 0.5 ≥ 1
  });
});

describe("identity odometer (library-roadmap #9)", () => {
  function odoDoc(reviewFloor?: number): GraphDoc {
    const doc = fatDoc();
    (doc.meta as Record<string, unknown>)["memory"] = {
      transcendence: {
        score: 0.6,
        pressureThreshold: 1,
        cooldownMs: 0,
        driftFloor: 0.1,
        inferredWeight: 1,
        ...(reviewFloor !== undefined ? { reviewFloor } : {}),
      },
    };
    return doc;
  }

  it("captures genesis, stamps the proposal odometer, and advances the trail on commit", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-r0", note: "tone conflict" }] } },
        { vars: {
          amendments: [
            {
              slot: "constraints",
              revisedText: "Never give medical advice. Keep a casual, playful tone in every reply.",
              rationale: "lived pattern",
            },
          ],
          label: "casual tone",
        } },
        { vars: { inverts: false } },
      ],
    });
    const h = await harness(llm, odoDoc());
    const result = await runSleep(h.deps, { manual: true });

    // genesis captured on first contact; live odometer starts at 1
    const state = await getEngineState(h.deps);
    expect(state.genesisCharter).toContain("You are Sage");
    expect(state.identityCumulative).toBe(1);

    // the human gate sees the journey: before = 1 (still at genesis), after < 1
    const cs = result.proposal?.changeset;
    const meta = cs?.meta as { odometer?: { before: number; after: number; reviewFloor: number } };
    expect(meta.odometer?.before).toBe(1);
    expect(meta.odometer?.after).toBeLessThan(1);
    expect(meta.odometer?.reviewFloor).toBe(0.5); // default band

    // commit + finalize → trail entry, live cumulative advanced
    const doc = await h.store.load(GRAPH_ID);
    await h.store.save(applyChangeset(doc, cs!.ops), { expectedVersion: doc.version ?? null });
    await finalizeAmendment(h.deps, cs!);
    const after = await getEngineState(h.deps);
    expect(after.identityTrail).toHaveLength(1);
    expect(after.identityTrail[0]).toMatchObject({ label: "casual tone" });
    expect(after.identityTrail[0]!.cumulative).toBeLessThan(1);
    expect(after.identityTrail[0]!.reviewRecommended).toBeUndefined();
    expect(after.identityCumulative).toBe(after.identityTrail[0]!.cumulative);
  });

  it("flags a constitutional review when cumulative similarity crosses the band", async () => {
    const llm = new ScriptedLlm({
      extract: [
        { vars: { philosophyConflicts: [{ id: "kn-r0", note: "x" }] } },
        { vars: {
          amendments: [
            { slot: "constraints", revisedText: "Never give medical advice, and always cite sources.", rationale: "y" },
          ],
          label: "cite sources",
        } },
        { vars: { inverts: false } },
      ],
    });
    const h = await harness(llm, odoDoc(0.95)); // tight band: any real movement flags
    const result = await runSleep(h.deps, { manual: true });
    const cs = result.proposal!.changeset!;
    const doc = await h.store.load(GRAPH_ID);
    await h.store.save(applyChangeset(doc, cs.ops), { expectedVersion: doc.version ?? null });
    await finalizeAmendment(h.deps, cs);

    const state = await getEngineState(h.deps);
    expect(state.identityCumulative).toBeLessThan(0.95);
    expect(state.identityTrail[0]?.reviewRecommended).toBe(true);
  });
});

describe("wake path", () => {
  it("harvestTurns distills the tail, advances the watermark, audits as harvest", async () => {
    const llm = new ScriptedLlm({
      extract: [{ vars: { facts: [{ fact: "Grows heirloom tomatoes.", categoryId: "interests" }] } }],
    });
    const h = await harness(llm);
    await h.transcripts.put({
      id: "t1",
      graphId: GRAPH_ID,
      turns: [
        { role: "user", content: "my tomatoes are thriving" },
        { role: "assistant", content: "lovely" },
      ],
    });
    const result = await harvestTurns(h.deps, "t1");
    expect(result?.learned).toMatchObject([{ categoryId: "interests" }]);
    expect((await h.transcripts.get("t1"))?.harvestedUpTo).toBe(2);
    expect(h.audits[0]?.actor).toBe("harvest");
  });

  it("digestFeedback refines an existing rule and bumps feedbackCount", async () => {
    const llm = new ScriptedLlm({
      classify: [{ matches: [{ nodeId: "interests", confidence: 0.9 }] }], // scoping route
      extract: [
        { vars: {
          adjustments: [
            {
              instruction: "Enjoys espresso brewing every morning; prefers a double shot.",
              categoryId: "interests",
              action: "refine",
              updateOfNodeId: "kn-espresso",
            },
          ],
        } },
      ],
    });
    const h = await harness(llm);
    const result = await digestFeedback(h.deps, "actually it's always a double shot");
    expect(result.refined).toMatchObject([{ nodeId: "kn-espresso", viaRewrite: false }]);
    const graph = new Graph(await h.store.load(GRAPH_ID));
    expect(graph.get("kn-espresso").props?.["feedbackCount"]).toBe(2);
    expect(h.audits[0]?.actor).toBe("feedback");
  });
});

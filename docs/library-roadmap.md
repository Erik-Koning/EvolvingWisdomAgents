# Library roadmap — keeping graphs organized as they evolve

Gaps identified while building the wisdom-chat memory system (sleep, feedback, transcendence).
Ranked by leverage. Kernel-semantics items land in **both runtimes with conformance fixtures**;
the fixture suite remains the cross-language contract.

| # | Item | Status |
|---|------|--------|
| 1 | `ComposedPrompt.contributors` — usage telemetry foundation | **Implemented** (fixture 58) |
| 2 | Compare-and-swap in the store contract | **Implemented** (`save(doc, {expectedVersion})`, `StoreConflictError`) |
| 6 | Kernel-enforced `pinned` protection | **Implemented** (fixtures 59–62) |
| 3 | Changeset lifecycle (the L5 pipeline) | **Implemented** (`lifecycle.ts/.py`, changeset stores, MCP tools with elicitation-gated commit) |
| 4 | Routing-regression harness | **Implemented** (`evalRouting`, fixture 63, `meta.regression` convention) |
| 5 | Loop-3 growth utilities (splits, misfit clustering) | **Implemented** (`evolve.ts/.py`; deep-sleep growth in wisdom-chat) |
| 7 | GraphLayer persistence | **Implemented** (LayerStoreConnector, Memory+File stores, `rebaseLayer`, `loadWithLayers`) |

## Implemented this tranche

**1. Contributors.** `compose()` now reports the nodes that actually fed the prompt —
post-truncation, first-contribution order. This is the input every organizing loop was missing:
"this rule hasn't composed in 60 days" becomes measurable, enabling decay/retirement decisions
in the sleep pass and honest context-stats UIs (wisdom-chat's stats line now reads it directly).

**2. Store CAS.** `GraphStoreConnector.save(doc, {expectedVersion})` — string must match the
stored latest, `null` = create-only, violation throws `StoreConflictError` (both runtimes;
`MemoryGraphStore` + `FileGraphStore`). App-level optimistic concurrency now delegates here;
DB-backed connectors (Postgres/Convex) can make it truly multi-process. FileGraphStore's check
is advisory across processes (no flock) — documented.

**6. Pinned.** `pinned: true` is a structural node field (schema + both kernels; also a
RESERVED key — `props.pinned` now fails validation). Removal ops — `deleteNode` (including any
pinned *descendant* on cascade), `pruneSubtree`, `mergeNodes` victims — throw
`Node "x" is pinned (pass force to override)`; `force: true` is the explicit escape. Content
edits stay legal: pinning means "don't lose this", not "freeze it". Layers inherit protection
via drop-and-flag.

## Implemented — second tranche

**4. Routing-regression harness.** `evalRouting(graph, labeled, {connectors, topK, focusNodes})`
— sequential input-order evaluation, pass = expected within top-K, fallback never passes,
failures won by focus nodes reported as **traffic steal** (fixture 63). `assertRegression` is
the gate; `labeledFromMeta` reads the portable `meta.regression` convention (seeded in the
repair-shop and wisdom-profile templates and kept honest by the template suites).

**3. Changeset lifecycle.** draft → validated → approved → committed | discarded, strict
transitions, pure functions in both runtimes; validation = dry apply + structural report +
optional regression gate; commit only from approved (`autoApprove` for user scope).
`ChangesetStoreConnector` (Memory both runtimes, File in `@apgraph/connectors`). Six MCP tools —
`apg_create_changeset` … `apg_commit_changeset` — where commit from "validated" triggers a human
**elicitation**; clients without elicitation must use the out-of-band approve tool first
(tested: accept, decline, and no-capability paths).

**7. Layer persistence.** `LayerStoreConnector` + Memory (both runtimes) + `FileLayerStore`;
`rebaseLayer` writes drop-and-flag conflicts into the layer and restamps `baseVersion`;
`loadWithLayers` materializes base ⊕ layers in one call.

**5. Growth utilities.** `cosineSimilarity`, deterministic greedy single-link
`clusterBySimilarity`, `medoid`, and `buildSplitOps` (subcategories + moved learnings + one
authoritative bring per anchor) in both runtimes. wisdom-chat's **deep sleep** uses them: a
saturated misfit pool clusters (embeddings, else bag-of-words fallback), one LLM call names
coherent themes, and the result is a **lifecycle changeset draft validated against
`meta.regression` plus the misfit exemplars** — surfaced as a 🌱 card, human-approved, blocked
outright when the regression gate reports stolen queries.

**App follow-ups (done):** the semantic-inversion verifier now backs the drift cap (negation
flips are rejected even when edit distance is tiny), and the Teach box gained an explicit
**identity** toggle so charter-directed teaching no longer depends on LLM classification.

## Implemented — third tranche: transcript replay + the `@apgraph/memory` engine

**Transcript replay** is implemented per the decided contract (kept below verbatim as the
spec), alongside a full lift of the memory engine into the library:

- **Contracts (both runtimes + fixture 64)**: `Transcript`/`TranscriptTurn`/`OpEvidence` types
  (`transcript.schema.json`), `Changeset.evidence/meta/createdAt`, `TranscriptStoreConnector` +
  `AgentStateStoreConnector` (Memory impls in core, File impls in `@apgraph/connectors`), and
  the pure **evidence gate** (`applyEvidenceGate`, `core/src/replay-gate.ts` + `replay_gate.py`)
  pinned by conformance fixture 64.
- **`@apgraph/memory`** (TS-only, like mcp-server): `runReplay` (watermarked windows, evidence
  gate, dedup-to-reinforce, maintenance CAS, always ends with `runSleep`), `runSleep`
  (growth-first + poolExempt, charter-aware reviews, pressure ledger), `maybeGrow`,
  transcendence proposals **as lifecycle changesets** (`createdBy: "amendment"`,
  drift/charterHash/rationale in `meta` — one persistence + one approval surface shared with
  growth), `harvestTurns` + `digestFeedback` wake path, policy from `doc.meta.memory`
  (`resolvePolicy`), everything dependency-injected (stores, llm, lock, clock — no module
  state, no env, no fs).
- **MCP**: `--data-dir` persistence (graph versions, changesets, transcripts, engine state,
  `audit.jsonl` survive restarts; `--graph` becomes the first-run seed) and eight engine tools:
  `apg_log_turns`, `apg_list_transcripts`, `apg_get_transcript`, `apg_harvest`, `apg_replay`,
  `apg_sleep`, `apg_feedback`, `apg_memory_status`. Growth and amendment drafts commit through
  the existing elicitation-gated `apg_commit_changeset`; amendments get a charter-staleness
  re-check at commit (`revalidateAmendment`) and consume ledger evidence on success
  (`finalizeAmendment`).

**The replay contract (the spec the implementation satisfies):**

- **Preservation-biased**: replay re-interprets stale episodes, so its warrant for destruction
  is weaker than consolidation's (which compares live rule texts side by side). Replay may
  freely add, refine-additively, and reinforce; it may retire, merge away, or weaken a node
  ONLY with explicit textual evidence — a transcript quote + session reference attached to the
  op and preserved in the audit log. Absent a citation the degrade op is dropped (logged to the
  pressure ledger for a future consolidation to examine). Extends the existing hierarchy: user
  writes beat maintenance; explicit evidence beats inference. Citations must quote USER turns,
  not assistant turns — the agent must not launder its own inferences into degrade authority.
  Verification is mechanical, not model-trusted: the quote must appear verbatim
  (whitespace-normalized) in the cited user turn or the op drops.
- **Orchestration contract**: replay runs FIRST, then sleep — all merging and category
  break-out (growth) happens at sleep time, after replay's additions land, so growth clusters
  the fullest raw pool and the merge pass compresses any redundancy replay introduced
  (pipeline: replay → growth → merge; extends the growth-before-compression rule in
  architecture.md). Replay is NEVER implicit: it does not attach to the automatic sleep
  triggers and runs only when explicitly triggered (button/API/tool call) or via a
  caller-configured cron — it is the most expensive pass (re-reads transcripts) and must be
  deliberate. `runReplay` schedules nothing itself.

## Remaining candidates (next tier)

- **Voice finisher — parallel output-shaping channel** ([`voice-finisher.md`](voice-finisher.md)):
  split graphs into substance/voice channels (`props.channel` convention, bring-isolated voice
  branch), overlap the voice compose with the inner engine run, and apply the composed
  output-editing prompt to the inner draft in a final small-model finisher call — a learnable,
  brandable character over any inner pipeline. Phase 0 needs no kernel change; Phase 1 adds a
  fixture-pinned `channelTargets` helper.
- Boundary-fix discrimination in deep sleep (assign clusters to existing categories, not only
  new ones) and cross-category contradiction sweeps.
- DB-backed store connectors (Postgres/Convex) making CAS and layers multi-process-native.
- Leaf-embedding tier with text-hash dirty tracking.
- Migrate `examples/wisdom-chat` onto `@apgraph/memory` (the app still runs its own copy of
  the engine; the library version is the normative one going forward).

## Governance & evaluation candidates — 2026-07-14 charter review

Gaps surfaced while pressure-testing the transcendence design (charter vs. learned evidence,
amendment lifecycle, benchmark fit). Ranked by leverage; engine items land in
`@apgraph/memory`, kernel-semantics items need fixtures in both runtimes.

| # | Item | Tier | Status |
|---|------|------|--------|
| 8 | **Citation-carrying pressure ledger** — extend the evidence-gate discipline to identity: `philosophyConflict` ledger entries attach a `sessionId` + verbatim USER-turn quote, mechanically verified via the kernel's `verifyCitation`; unverified entries are marked `inferred` and count at reduced weight toward the pressure threshold. Rationale: retiring one leaf via replay demands a verified user quote, yet charter amendments — far more consequential — are petitioned today by purely LLM-inferred conflicts. The human gate should see receipts, not summaries. | engine | **Implemented** (see below) |
| 9 | **Identity odometer** — store the genesis charter; compute cumulative drift (not just per-step) at each amendment; surface the trail in `apg_memory_status` and the proposal UI; optional "constitutional review" event when cumulative drift crosses a band. | engine | **Implemented** (see below) |
| 10 | **Amendment impact preview** — dry-run the charter-aware review against the *proposed* charter at draft time; attach blast radius (rules newly conflicting / re-ranked) to the proposal so the human approves with foresight, not hindsight. | engine | candidate |
| 11 | **Pressure decay** — ledger entries age to `dormant` outside a recency window unless re-observed; stale contradictions from an old context stop compounding with fresh ones toward the threshold. | engine | candidate |
| 12 | **Governance dials in the graph** — seed `meta.memory` (transcendence score, sleep policy) into the templates so the portable program declares its own amendability; app config becomes the override, not the source. (`resolvePolicy` already reads `doc.meta.memory` — this is a template + docs change.) | templates/docs | candidate |
| 13 | **`life-philosophy` naming collision** — the wisdom-profile *category* (learned beliefs about the user) shares a name with the informal description of the *charter* (the agent's identity). Rename the category or reserve "charter" vocabulary in `learning-conventions.md`. | templates/docs | candidate |
| 14 | **Memory-regression harness** — the recall analog of `meta.regression`/traffic-steal: labeled recall probes run before/after sleep; an answer that dies across the sleep boundary flags a destructive merge. Also the on-ramp to external benchmarks (HaluMem operation-level, LongMemEval knowledge-update subset). | kernel + engine | candidate |
| 15 | **Contributors-driven decay** — feed `ComposedPrompt.contributors` usage telemetry (built in #1, unconsumed by sleep) into consolidation reviews as structured signal: "0 contributions in N days" becomes retirement evidence. | engine | candidate |
| 16 | **MCP gap closures** — `--bind-connectors` flag so a graph's declared `connectors` block actually binds via `registerBuiltins()`/`bindConnectors()` (today it is decorative on the server path), and session persistence through the existing `SessionStoreConnector` under `--data-dir`. | mcp-server | candidate |

**8. Citation-carrying pressure ledger.** After the charter-aware review flags
`philosophyConflicts`, a **citation pass** (`citeConflict`, one focused extract per fresh
conflict) follows the rule's provenance (`props.transcriptId`, stamped by harvest) back to the
originating transcript and asks for a verbatim quote from the user turn that evidences the
rule. Verification is mechanical and reuses the replay evidence gate's `verifyCitation` — the
quote must appear (whitespace-normalized) in a USER turn of the cited transcript. Verified
entries carry `citation: {transcriptId, turnIndex, quote}`; no provenance / unknown transcript
/ failed verification mark the entry `inferred: true` (corroboration is best-effort, never a
failure mode — replay's uncited-degrade doubts are `inferred` by definition). The pressure
gate now counts **weighted** pressure (`weighPressure`): cited entries weigh 1.0, inferred
entries `inferredWeight` (default 0.5, dial via `meta.memory.transcendence.inferredWeight`) —
uncorroborated model inference must be twice as sustained to petition the charter. Amendment
proposals surface the receipts (`meta.evidence[].citation`, and `— user said: "…"` in the
evidence notes), and `apg_memory_status` reports `pressure.{open, cited, weighted, threshold}`.

**9. Identity odometer.** The engine now measures the *journey*, not just the step. The
charter text at first engine contact is captured as the **genesis charter**
(`EngineState.genesisCharter`, best-effort for pre-existing deployments); every amendment
proposal carries `meta.odometer = {before, after, reviewFloor}` — similarity(genesis, charter)
before and after the proposed change, computed with the same `driftSimilarity` backend as the
per-step cap (embeddings when bound, Levenshtein proxy otherwise) — so the human gate sees how
far identity has traveled before signing. `finalizeAmendment` appends an
`IdentityTrailEntry {at, label, stepDrift, cumulative}` per committed amendment and keeps a
live `identityCumulative`; sleep refreshes it whenever the identity hash moved, so **manual
root edits move the odometer too**. When cumulative similarity falls below
`transcendence.reviewFloor` (default 0.5, per-graph via `meta.memory`), the trail entry and
`apg_memory_status.identity` flag `reviewRecommended` — a constitutional review is surfaced,
never enforced: per-step movement stays bounded by the drift cap, and the band is a human
prompt, not a gate.

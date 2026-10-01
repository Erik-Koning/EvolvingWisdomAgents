# @apgraph/memory

The APG memory engine: every learning loop the wisdom-chat reference app pioneered, lifted
into a reusable, dependency-injected library. No module state, no `process.env`, no
filesystem — everything arrives through `MemoryDeps` (stores, LLM, embeddings, lock, audit
sink, clock), so hosts wire `Memory*` stores for tests and `File*`/DB stores for real
deployments.

```ts
import { runReplay, runSleep, harvestTurns, digestFeedback, type MemoryDeps } from "@apgraph/memory";

const deps: MemoryDeps = {
  graphId: "wisdom-profile",
  store,        // GraphStoreConnector (CAS-capable)
  llm,          // classify + extract
  transcripts,  // TranscriptStoreConnector
  changesets,   // ChangesetStoreConnector
  state,        // AgentStateStoreConnector (pressure ledger, sleep stamps)
  audit: (e) => appendFileSync("audit.jsonl", JSON.stringify(e) + "\n"),
};

await harvestTurns(deps, transcriptId);          // wake path: distill the un-harvested tail
await digestFeedback(deps, "be more brief");     // wake path: add / refine / retire
await runSleep(deps, { manual: true });          // consolidation: growth first, then merges
await runReplay(deps);                            // episodic replay → always ends with sleep
```

## The loops

| Loop | Trigger | Writes | Gate |
|---|---|---|---|
| `harvestTurns` | host cadence (every N turns) | adds/refines, actor `harvest` | dedup backstop; user-write CAS (retry once) |
| `digestFeedback` | user comment | add/refine/retire, actor `feedback` | scoped candidates, stage-2 rewrite, dedup→refine |
| `runSleep` | manual / host cron (cooldown-gated) | merges, retires, priorities, actor `sleep` | threshold; charter conflicts → pressure ledger, never retired; growth drafts human-gated |
| `maybeGrow` (inside sleep) | misfit-pool saturation | **lifecycle changeset draft only** | routing-regression gate + misfit exemplars |
| `runReplay` | **explicit only** (API/tool/cron — never scheduled here) | evidence-gated batch, actor `replay` | the evidence gate (below); maintenance CAS — user writes win |
| transcendence | pressure ≥ threshold or identity edict | **amendment changeset draft only** | score-derived slots, drift cap, inversion verifier, human commit |

## Replay's evidence gate (fixture 64)

Replay is **preservation-biased**: adds, reinforcements, and additive refinements pass freely;
an op that degrades stored wisdom (retire, shrinking bring, shortening/nulling text) applies
only with a mechanically verified citation — the USER's exact words, whitespace-normalized,
from a stored transcript turn. Uncited degrades drop to the pressure ledger as doubts for a
future sleep. Assistant turns carry no degrade authority. The gate is pure kernel logic
(`applyEvidenceGate` in `@apgraph/core`, mirrored in Python, pinned by conformance fixture 64);
this package assembles the intent ops, runs the gate, expands verified retires into the full
removal set, and commits one audited changeset whose `evidence` array survives on disk.

## Ordering contract

`runReplay` always finishes by calling `runSleep` — merging and category break-out happen
AFTER replay's additions land (pipeline: **replay → growth → merge**, extending the
growth-before-compression rule in `docs/architecture.md`). A plain sleep never implies replay.

## Proposals are changesets

Growth drafts and charter amendments both persist as lifecycle changesets — one storage
surface, one approval surface (`validateChangeset` → human gate → `commitChangeset`).
Amendments carry `meta: { kind: "amendment", drift, charterHash, changes, rationale,
evidence }`; hosts MUST call `revalidateAmendment` before committing one (a draft whose
charter moved underneath it is invalidated, never applied) and `finalizeAmendment` after (to
consume ledger evidence; `identityHash` stays stale on purpose so the next sleep runs an
identity-aware reconsolidation).

## Policy

`resolvePolicy(doc, override?)`: defaults ⊕ `doc.meta.memory` ⊕ host override. The
transcendence score derives the amendable slots / pressure threshold / drift floor (0 = the
charter is a constitution); every derived dial is individually overridable. Sleep threshold
and cooldown, growth clustering thresholds, and the replay window are all tunable the same
way — the graph is the portable program.

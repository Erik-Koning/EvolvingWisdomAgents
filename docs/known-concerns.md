# Known concerns register

Library-tier evolution items graduated to [`library-roadmap.md`](library-roadmap.md).

Findings from the 2026-07-13 architecture audit of the feedback/teaching system
(`examples/wisdom-chat` + the library surfaces it exercises), ranked by severity at the time of
the audit. Same spirit as the design doc's deferred-changes register: each entry names the
failure scenario, the blast radius, and the mitigation path, so these are designed-around
rather than rediscovered.

| # | Concern | Status |
|---|---------|--------|
| 1 | Full-mode context missed task-anchored preferences | **Fixed** |
| 2 | Feedback add-path lacked a dedup backstop; truncated listings could misidentify | **Fixed** |
| 3 | Monotonic rule growth, no consolidation loop | **Fixed** — the "sleep" pass, [architecture.md](architecture.md#consolidation-loop-implemented--exampleswisdom-chatsrclibconsolidatets) |
| 4 | Concurrent graph writes are last-write-wins | **Largely fixed** — per-agent lock + app-level CAS + atomic file writes (single-process; multi-process needs a CAS store connector) |
| 5 | Feedback auto-commits without gates | Partially fixed — identity/charter changes now require human-approved drafts; rule-level writes remain user-scope auto-commit by design |
| 6 | Newest preferences drop first under token budget; stale-vector risk for a future leaf-embedding tier | Partially fixed — consolidation re-ranks by reinforcement |

## 1. Full mode missed task-anchored preferences — FIXED

**Was:** "full" mode composed `[root]` only; root's `bring` deliberately lists only global
preference categories (routed mode includes root as a secondary target — fixtures 56/57 — so its
brings must stay global-only or routed selectivity dies). Rules anchored to task nodes
(`appliesTo: quotes`) therefore composed in routed mode but silently *not* in full mode.

**Fix:** full-mode targets are now `[root, ...allCategories]` in `src/lib/chat.ts` — every
category rides as a secondary target, contributing its contextOnly slots and brings. Full is a
true superset regardless of bring wiring, and survives categories created by future splits. The
graph template is intentionally untouched.

## 2. Feedback dedup + truncation misidentification — FIXED

**Was:** the harvest had a `findNodes` near-duplicate backstop; the feedback digest trusted the
LLM's refine-vs-add judgment alone. Routing scope could omit the true target from the candidate
listing (miss → duplicate add), and the 160-char listing truncation could hide the distinguishing
clause of a long rule.

**Fix:** (a) the digest's add path now runs the same `findNodes` backstop and converts a
near-duplicate add into a **refine** of the existing node (repetition = reinforcement,
`feedbackCount`++); (b) long nodes carry a `props.label` (≤10-word summary, authored by the same
stage-2 rewrite call that authors the text) and candidate listings show `label — truncated text`
instead of blind truncation. Unlabeled legacy nodes fall back to truncation.

**Lesson pinned during verification:** the identification schema must demand *the text as it
should be stored*, never "a statement of the change" — short-node refines store the field
verbatim, and a change-description silently replaces a clean rule with meta-commentary
(observed live, schema wording fixed, reinforcement now idempotent).

## 3. No consolidation loop — FIXED

**Was:** rules only accumulated; write-time hygiene (refine-over-add + dedup backstop) is
insert-time only and never re-examines residents against each other.

**Fix:** the "sleep" pass (`examples/wisdom-chat/src/lib/consolidate.ts`,
`POST /api/consolidate`, 😴 button): per qualifying category (≥6 rules), one off-the-chat-path
review call over all residents at full text → `mergeNodes` near-duplicates, retire
stale/contradicted rules, and map `feedbackCount` onto `composition.priority` (700–800 band) so
reinforced rules survive token-budget truncation — which also closes the priority half of
concern #6. One validated changeset per category, `consolidations.jsonl` audit, snapshot per
run. Deterministic vitest coverage via `ScriptedLlm`; live-verified (7 style rules → 2 coherent
policies, one-off retired). Cross-category contradiction pass and raw-transcript replay remain
future tiers.

## 4. Last-write-wins concurrency — LARGELY FIXED

**Was:** two simultaneous commits both load version N, both save N+1 — first write silently
clobbered.

**Fix (app level):** every graph write flows through `withAgentLock` (per-agent in-process
serialization) plus app-level CAS (`ConflictError` when the stored version moved). Policy:
user-initiated writes (harvest/feedback) retry once against the fresh doc; maintenance
(sleep/amendment) aborts and reschedules — **user work always beats maintenance** (pinned by the
mid-sleep-conflict test). `FileGraphStore` now writes atomically (temp + rename), so a crash
can't truncate the graph. Remaining honest gap: the lock is in-process — a multi-instance
deployment still needs store-connector CAS (Postgres/Convex), which the version key already
supports.

## 5. Feedback auto-commits without gates (open, deliberate)

The digest converts arbitrary user text into standing `constraints` and commits after structural
validation only — the design doc's *user-scope* treatment, correct for a single-tenant demo. The
contextOnly boundary keeps feedback out of `persona`/`task`, and version snapshots give
rollback, but there is no content linting and no probation status.
**Path for multi-user:** write feedback to per-user `GraphLayer`s (implemented and
fixture-pinned in the library, unused by the app) over a shared base; add digest-time content
linting and `status: "staging"` probation per the design doc's overlay-quality-control note.

## 6. Budget priority + embedding staleness (open, minor)

Learned rules are bring fragments (~priority 700): under token-budget pressure the
most-recently-added drops first, and a rule reinforced five times has no more staying power than
a one-off. **Path:** map `feedbackCount` onto `node.composition.priority` at write time (hook
already exists in the composer).

Separately: `precomputeEmbeddings` fills *missing* vectors only. If a leaf-embedding tier is
added later, refines that rewrite text would keep stale vectors — needs a text-hash dirty check
at that point, not before.

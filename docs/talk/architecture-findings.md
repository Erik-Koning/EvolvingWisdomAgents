# APG architecture — audited findings

Deep-audit synthesis (2026-07-14) of the whole repo: kernel, schema/conformance, MCP surface,
and the wisdom-chat learning stack. Written as source material for conference talks and docs;
every claim below was verified against source, with paths for traceability. Companion doc:
[`speakable-terms.md`](speakable-terms.md).

## TL;DR

APG is **an operating system for prompts**: an agent's behavior lives in a portable,
schema-validated JSON *program* (`*.apg.json`); a zero-dependency *kernel* executes it
(route → resolve → compose → walk → effects); all side effects flow through swappable *drivers*
(connectors); MCP is the *syscall interface* for external agents; and a *learning engine*
mutates the program at runtime through one audited op algebra — with autonomy graded from
auto-commit (facts) to human-ratified (identity). Two kernels (TypeScript + Python) implement
identical semantics, pinned by a shared conformance-fixture suite: **a behavior change without
a fixture change is a bug by definition.**

## The layer map (OS analogy, as built)

| OS concept | APG realization | Where |
|---|---|---|
| Program | `*.apg.json` graph document (JSON Schema 2020-12, `additionalProperties:false`) | `schema/apg.schema.json`, `templates/` |
| Kernel | route → resolve → compose → walk → effects + mutation algebra + validator | `typescript/packages/core` (3,457 LOC, zero runtime deps), `python/packages/apg-core` (3,433 LOC, stdlib only) |
| Drivers | connector interfaces: llm, embeddings, store, session, transcripts, state, memory, tools, handoff, telemetry — "driver missing = load error" | `core/src/connectors.ts`, shipped impls in `@apgraph/connectors` |
| Syscall interface | MCP server: 25 tools, 2 resources, per-node prompts, elicitation-gated commits | `typescript/packages/mcp-server` |
| Capability rings | L0–L5 profiles, strict supersets; validator rejects a graph whose declared profile is below the features it uses | `schema/profiles.json` (`featureGates`) |
| Userland apps | wisdom-chat (Sage native + Repair Shop LangGraph), CLI | `examples/wisdom-chat`, `typescript/packages/cli` |
| ABI / spec | 64 conformance fixtures + `docs/spec/determinism.md`; fixtures win disagreements | `schema/conformance/` |

## By the numbers

- **2 runtimes**, module-for-module (19 TS modules ↔ 19 Python modules; per-module LOC within a few lines of each other; Python is sync because the kernel is deterministic — async is cosmetic).
- **64 conformance fixtures**, one self-contained JSON each (`graph + op + expected | expectError`), run by both test harnesses from the single shared directory. Distribution: sessionStep 15, compose 13, route 8, applyChangeset 8, validate 5, plus outline/expr/layers/bring/regression/evidence-gate.
- **17 mutation ops** in one `MutationOp` algebra; **7 prompt slots** (closed enum: persona, task, constraints, knowledge, examples, outputFormat, queryRewrite); **3 context-only slots** (knowledge, constraints, examples).
- **25 MCP tools** (1 routing, 7 read, 2 session/compose, 7 changeset lifecycle, 8 memory engine), 2 resources, dynamic prompts.
- **9 templates** spanning L0–L5 plus the two learning demos (repair-shop, wisdom-profile) which carry `meta.regression` labeled query sets.
- **5 audit actors** on every graph write: `harvest | feedback | sleep | amendment | manual`, recorded append-only with `fromVersion → toVersion`.

## The kernel: route → resolve → compose → walk → effects

**route()** (`core/src/router.ts`) — hybrid, one LLM call per route, "no randomness anywhere":
eligibility gate (routable, not pruned, entryCondition) → optional embedding shortlist (only
when eligible count > K; stored `node.embedding` vectors preferred; shortlist re-projected to
DFS order so the outline stays byte-stable) → canonical outline → single structured
classification → dedupe/confidence-gate/tie-break → deterministic fallback ladder (ancestor
`fallbackNodeId` → first `isFallback` in DFS → root).

**resolveBring()** (`core/src/bring.ts`) — BFS companion-context expansion; the *landing node*
governs the whole expansion (recursion flag, depth cap 3); cycle-safe seen-set; unknown refs →
`dangling[]` (telemetry, not fatal); cross-tenant brings → `tenantBlocked[]`.

**compose()** (`core/src/compose.ts`) — three stages at three ownerships, strict order:
**path** (the author's intent, root→leaf, per-slot merge modes) → **imports** (secondary
matches + brings, contextOnly) → **overlays** (this user's feedback history). Then a
deterministic token budget: drop whole fragments in ascending priority (ladder: path
constraints never dropped → leaf persona/task 900 → path 800 → brings 700 − 50/depth →
examples 400 → overlays 100), ties drop the most recent contribution first. Output is a
`ComposedPrompt` with structured `slots`, joined `text`, and `contributors` — the nodes whose
fragments actually survived, i.e. **usage telemetry** for decay/retirement decisions.

**sessionStep()** (`core/src/session.ts`) — deterministic flow walking over decision/action/
answer/category nodes; the only LLM touches are opportunistic variable fill and scoped freeform
mini-classification. Decision resolution order: known var → guard expression → explicit choice
→ freeform classify → ask. Escalation (`mode: "require"`) collects required vars, opens a
ticket, and parks the session in `awaitingHuman`; only a `humanAnswer` moves it. Stale routing
after a mutation reroutes gracefully, never errors.

Surface mapping: the same verbs are CLI subcommands (`apg route | compose | walk`) and MCP
tools (`route_query`, `apg_resolve_bring`, `apg_compose_preview`, `apg_session_step`). The
route→compose handoff is literal — `compose(graph, routing.matches.map(m => m.nodeId),
{query})` — and the classifier only ever sees the descriptor-only outline, never prompt
payloads. The walk's return is `{session, effects}`: the effects union
(`ask/elicit/say/toolCall/escalate/composeReady/walkComplete/reroute`) is the kernel↔host
contract — the kernel decides, the host acts. Verb table, sequence diagram, and two worked
chat traces:
[`../architecture.md`](../architecture.md#the-kernel-request-path--route--resolve--compose--walk--effects).

Supporting machinery: a **sandboxed expression language** (own tokenizer/parser/evaluator,
pinned grammar, JS-strict equality, no eval, no dependencies) for all guards/conditions; a
**pinned mini JSON-Schema subset** for action results and variables so neither runtime needs a
schema library in the hot path; canonical `normalizeDocument` (idempotent, DFS re-serialization
after every mutation).

## Determinism as the product surface

The deep insight of the codebase: everywhere the LLM *isn't*, behavior is pinned to the byte.
`docs/spec/determinism.md` is normative; fixtures win over prose. Highlights:

- **Byte-stable outline serialization** — the router's view of the graph is a canonical string,
  usable as both cache key and fixture assertion.
- **Total tie-break order** — confidence desc → deeper node → sibling authored order →
  lexicographic id. No randomness in the kernel, ever.
- **Cross-language parity traps pinned out of existence** — JS-strict equality (`true ≠ 1`),
  the closed JS falsiness set, numeric-coercion regex so `Number()` vs `float()` never
  disagree, `ceil(codepoints/4)` token fallback, three distinct missingness notions.
- **Route cache key** = `(query, baseVersion, ...layerVersions)` — undiverged users share the
  base cache.

## One mutation algebra under everything

Every change — human edit, agent tool, harvest, feedback, sleep, amendment — is a sequence of
the same 17 ops (`core/src/mutation.ts`):

- **Changesets** are transactional (first failure aborts; result must re-validate) with a
  strict lifecycle: draft → validated → approved → committed | discarded. Validation = dry
  apply + structural report + optional **routing-regression gate** (`evalRouting` against the
  graph's `meta.regression` labeled queries; failures won by the changeset's own nodes are
  reported as **traffic steal**).
- **Layers** are permanently-open changesets applied at load (`base ⊕ tenant ⊕ user`); failed
  ops are **dropped and flagged, never guessed**. `rebaseLayer` re-applies onto a moved base.
- **Pinned protection** — `pinned: true` blocks delete/prune/merge-victim (cascade checks
  descendants) unless `force: true`; content edits stay legal ("don't lose this", not "freeze
  it").
- **Store CAS** — `save(doc, {expectedVersion})` throws `StoreConflictError`; policy: user
  actors retry against fresh, maintenance actors abort — **user work always beats maintenance**.
- **Evidence gate** (`core/src/replay-gate.ts`) — the pure half of preservation-biased replay:
  every op is classified additive vs degrading; a degrading op needs a mechanically verified
  verbatim quote from a **user** turn or it is dropped. "The agent must not launder its own
  inferences into degrade authority."

## The learning engine (the wisdom graph)

Implemented in `examples/wisdom-chat/src/lib/` and lifted into `@apgraph/memory` behind the
MCP server's memory tools. Three timescales, split like biological memory:

| Loop | Timescale | Analogy | Gate |
|---|---|---|---|
| Route + compose | per message | attention | — |
| **Harvest / feedback** | per ~5 msgs / per teach | waking encoding | auto-commit (dedup backstop, refine-over-add, CAS retry) |
| **Sleep (consolidation)** | idle timer, session end ("bedtime"), manual 😴, cron | sleep: replay, downscaling | auto-commit; pinned untouchable; philosophy conflicts → pressure ledger, never retired |
| **Deep-sleep growth** | misfit-pool saturation | schema accommodation | changeset draft + regression gate + **human approval** (🌱) |
| **Transcendence (charter amendment)** | pressure ≥ threshold, or explicit edict | identity change | drift cap + semantic-inversion verifier + **human approval, always** |

Load-bearing details:

- Categories declare what they want learned via `props.learn`; learnings are graph nodes with
  `feedbackCount`, `source`, lifecycle timestamps, and ≤10-word `props.label`. Reinforcement
  maps onto `composition.priority` (700–800 band) so repeated lessons outlive one-offs under
  token pressure.
- **Ordering rule discovered live**: growth clusters RAW misfits BEFORE consolidation
  compresses them — "light sleep eats deep sleep" otherwise. Replay (when triggered) runs
  first of all: replay → growth → merge.
- **Transcendence is one dial, five derived reins**: at score 0 the charter is a constitution;
  rising score unlocks amendable slots (constraints → +task → +persona), lowers the pressure
  threshold, loosens the drift floor. Every amendment is a human-approved draft at any score;
  approval deliberately leaves the identity hash stale so the next sleep re-audits all rules
  against the new charter.
- The **control plane is the graph**: a feedback "deny" edits the root's `toolAllowlist`,
  which flows through `compose()` into which tools LangGraph even receives next request.
- Concurrency: per-agent in-process lock + app-level CAS + atomic temp-and-rename writes +
  unified `audit.jsonl`.

## The MCP facade — semantic mapping onto MCP primitives

The mapping is clean enough to be a talk slide by itself:

- **Nouns → Resources**: `apg://graph/tree` (canonical outline), `apg://node/{id}`.
- **Identities → Prompts**: every routable prompt-bearing node is an MCP Prompt whose body is
  its composed path (named by globally-unique node id; capability declared lazily).
- **Verbs → Tools**: routing, read toolkit, deterministic session walking (the whole state
  machine behind one `apg_session_step` tool returning `{session, effects}`), the changeset
  lifecycle, and the memory engine (log turns / harvest / replay / sleep / feedback / status).
- **Approvals → Elicitation**: `apg_commit_changeset` from "validated" fires a real MCP
  elicitation; a client *without* the elicitation capability is refused and pointed at the
  out-of-band `apg_approve_changeset`. **The human gate is enforced by capability negotiation,
  not client goodwill** — and it's distinct from within-walk escalation (an `escalate` effect +
  `awaitingHuman`), which is operational handoff, not governance.
- Every store write re-materializes the served graph and pushes resource/prompt list-changed
  notifications — agents see the graph learn without polling.

## Two-runtime conformance discipline

The fixtures are the contract: one shared directory, both harnesses glob and run all 64; a
fixture passing in one runtime and failing in the other blocks both. Python carries a small
`_json.py` shim purely to pin JS serialization/equality semantics. The only intentional
divergence is sync vs async (documented); Ajv/JSON-Schema validation is TS-only (Python stays
stdlib). Templates are themselves conformance-guarded in both suites (normalize, validate,
profile ≥ detected features, idempotent normalization).

## Graded autonomy (the governance model)

Three tiers, worth stating exactly:

1. **Content (facts and rules)** — autonomous end to end: the LLM authors node text, picks
   categories (enum-constrained, routing fallback), links edges, refines, and even
   merges/retires rules — sleep consolidation runs with no gate. But always through hygiene:
   refine-over-add, dedup backstop, pinned protection, CAS, audit trail, version snapshot per
   write.
2. **Structure** (new categories) — machine-proposed, regression-gated, human-approved.
3. **Identity** (charter) — machine-proposed only under sustained evidence pressure or
   explicit edict, drift-capped, inversion-checked, cooled down, human-approved always,
   followed by identity-aware reconsolidation.

## Evaluation positioning (recorded from the benchmark analysis)

- **HaluMem** is the natural external benchmark: it evaluates memory at the operation level
  (extraction, updating, QA), which maps 1:1 onto APG's actors and audit trail; its thesis —
  memory errors are written in at extraction/update time — is already this repo's design
  language (evidence gate, preservation-biased replay, known-concerns #3).
- **LongMemEval**: run the knowledge-update and preference subsets externally; use the full QA
  set *internally* as a before/after-sleep regression harness (the memory analog of
  `evalRouting`) — any answer that dies across a sleep boundary is a destructive merge.
- **τ-bench-class** suites exercise the kernel axis (session walking, tool allowlists,
  escalation), not the memory axis.
- Publish the distillation trade-off explicitly: a wisdom graph is generalization-biased —
  worse verbatim episodic recall, better consistency under contradiction and update. That is
  the design argument, not a weakness to hide.
- Blockers before running any of it: the learning loops need a headless harness (they live
  behind Next.js routes and UI approval buttons), and growth's human gate needs an eval-mode
  bypass.

## Honest gaps found during audit

Track these so the talk never overclaims:

- The MCP server does **not** call `bindConnectors(doc)` — a graph's declared `connectors`
  block is documentation on that path; drivers are injected programmatically and the default
  LLM is the deterministic `LexicalLlm` demo classifier. `registerBuiltins()`/`bindConnectors()`
  currently have no call sites outside their definitions (host-embedding API).
- MCP sessions live in a process-local Map — not persisted even with `--data-dir`.
- The `mcp-client` tools driver is declared in templates but not shipped; `otel` telemetry is
  a no-op placeholder.
- Locks are in-process; multi-instance deployments need a DB-backed CAS store connector
  (Postgres/Convex — roadmap).
- Rule-level feedback auto-commits by design (known-concerns #5); multi-user needs per-user
  layers + probation status (implemented in the library, unused by the app).
- Fixture-count drift in prose (README said 57, architecture.md 63, actual 64) — corrected
  2026-07-14; keep the counts in sync as fixtures land.
- No license yet; all packages private/UNLICENSED.

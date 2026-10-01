# Speakable terms — the APG vocabulary

Marketable, sayable-on-stage language for APG, grouped by theme. Terms marked **[repo]** are
verbatim from the codebase/docs (safe to present as established project vocabulary); terms
marked **[new]** are proposed coinages for talks and marketing. Companion doc:
[`architecture-findings.md`](architecture-findings.md) for the technical grounding of every
claim.

## The pitch ladder

**Ten words:** *An operating system for prompts — and the prompts learn.*

**Thirty seconds:** Your agent's behavior shouldn't be a wall of prompt text — it should be a
program. APG makes it one: a portable JSON graph that a small deterministic kernel routes,
composes, and walks — emitting effects the host executes. Models, stores, and tools plug in
as drivers. MCP is the syscall
interface. And because the graph is data, the agent can safely rewrite it as it learns — every
memory is a diffable node, every change is an audited operation, and the riskier the change,
the more human approval it needs.

**Two minutes** (add): The kernel is deterministic everywhere the LLM isn't — one model call
per route, byte-stable everything else, pinned by 64 conformance fixtures that two independent
kernels (TypeScript and Python) must both pass. Learning runs on three timescales borrowed
from biological memory: harvest while awake, consolidate during sleep, grow new structure in
deep sleep. Identity sits behind a constitution: the agent's charter can only amend itself
under sustained evidence pressure, within a drift cap, with a human signing every amendment.
You get an agent that visibly gets better at its job — and a graph you can read, diff, roll
back, and govern.

## Headline terms (slide-worthy)

- **Adaptive Prompt Graph (APG)** [repo] — the project. A graph of prompt categories as a
  portable, schema-validated JSON program.
- **An operating system for prompts** [repo] — the master analogy: graph = program, kernel =
  runtime, connectors = drivers, MCP = syscalls, profiles = capability rings.
- **Wisdom graph / wisdom context graph** [repo] — the learning deployment of APG: a memory
  substrate that stores distilled lessons, not transcripts. *Say:* "a wisdom graph is not a
  transcript index — it keeps the lesson and lets go of the noise."
- **Route → resolve → compose → walk → effects** [repo] — the kernel verbs (`route()`,
  `resolveBring()`, `compose()`, `sessionStep()`; also the CLI subcommands and MCP tools),
  ending in the effects the walk emits (`ask · elicit · say · toolCall · escalate …`) — the
  kernel↔host contract: **the kernel decides, the host acts.** Sayable as "the
  fetch-decode-execute cycle for context": route = which part of the program applies (the
  classifier sees only a stripped, descriptor-only outline — never the prompt payloads),
  resolve = gather what it needs, compose = compile the system prompt from route's matches
  (the user's message rides separately), walk = execute the deterministic flow branch
  (generation stays with the host). Verb table, sequence diagram, and worked traces:
  [`../architecture.md`](../architecture.md#the-kernel-request-path--route--resolve--compose--walk--effects).
- **The prompt is a build artifact** [new] — nobody writes the system prompt; `compose()`
  compiles it per query from path, brings, and overlays. Also: **"compiled context."**
- **Three edge families** [repo] — *taxonomy edges* say where a query belongs; *bring edges*
  say what an answer needs; *flow edges* say what happens next. One graph, three kinds of
  meaning.
- **Capability profiles L0–L5** [repo] — from prompt switcher to self-mutation, each tier a
  strict superset. *Say:* "the graph's driver's license — the validator won't let an L0 graph
  do L5 things."
- **A behavior change without a fixture change is a bug by definition** [repo] — the
  engineering-discipline applause line. Pair with: **same 64 fixtures, two languages — the
  kernels can't drift apart.**
- **Glass-box memory** [new] — versus opaque vector stores: every memory is a named node with
  provenance, a reinforcement count, and a version history. *Also:* **"memory with a
  changelog."**

## The learning vocabulary (wake / sleep)

- **Wake path vs sleep path** [repo] — fast, scoped learning in the request path; global
  reorganization off the hot path. *Say:* "you can't reorganize memory while serving traffic —
  neither can you."
- **Harvest** [repo] — waking encoding: distill durable facts from live conversation, every
  few messages. **Refine-over-add** [repo]: repetition is reinforcement, not duplication.
- **Sleep / consolidation** [repo] — the 😴 pass: merge near-duplicates, retire stale rules,
  re-rank by reinforcement. Triggered by idle **sleep pressure**, session-end **bedtime**, a
  button, or cron [all repo].
- **Deep-sleep growth** [repo] — when the misfit pool saturates, cluster the outliers and
  propose new categories. *Say:* "the taxonomy grows where reality didn't fit it."
- **"Light sleep eats deep sleep"** [repo] — the ordering rule discovered live: cluster raw
  episodes *before* compressing them, or merging destroys the very signal clustering needs.
  Great war-story slide.
- **Misfit pool** [repo] — the fallback category where unclassifiable learnings accumulate
  until they're worth a new branch.
- **Contributors** [repo] — compose() reports which nodes actually made it into the prompt.
  *Say:* "we know which memories are earning their keep."
- **Pinned** [repo] — "don't lose this," not "freeze it": protected from removal, still
  editable.
- **User work always beats maintenance** [repo] — the concurrency policy in one line: a human
  write racing the sleep pass wins; sleep discards and re-arms.
- **Preservation-biased replay + the evidence gate** [repo] — re-reading old transcripts may
  freely add, but may only forget with a verbatim quote from a *user* turn attached. *Say:*
  **"the agent can't launder its own inferences into the authority to forget."**

## The governance vocabulary (transcendence)

- **Charter** [repo] — the root node's persona/task/constraints: the agent's identity, in the
  same graph as everything else.
- **Transcendence score** [repo] — one dial from 0 to 1: at 0 the charter is a
  **constitution** (leaves conform, no amendments); as it rises, sustained conflict may amend
  constraints, then task, then persona. *Say:* "one dial, five derived reins."
- **Pressure ledger** [repo] — sleep never deletes a rule that contradicts the charter; it
  logs the conflict as evidence. Enough pressure → an amendment proposal.
- **Edict** [repo] — the human shortcut: teach the agent about itself, explicitly.
- **Drift cap** [repo] — identity may travel far, but only in small, individually-audited
  steps (cosine floor per amendment), backed by a **semantic-inversion verifier** [repo] that
  catches "never upsell → always upsell" flips edit distance can't see.
- **Graded autonomy** [repo, name new] — the three-tier governance pyramid: content
  auto-commits (the agent writes, merges, and retires its own rules — even sleep needs no
  gate), structure is regression-gated + human-approved, identity is drift-capped +
  human-approved always. *Say:* **"the riskier the change, the more ceremony it needs."**
- **Traffic steal** [repo] — the regression gate's failure mode: a new category quietly
  hijacking queries that belonged elsewhere. *Say:* **"evolution with a brake pedal"** [repo,
  comment in `regress.ts`].
- **Changesets and layers** [repo] — git for prompt graphs: draft → validate → approve →
  commit; per-tenant/per-user layers over a shared base, where failed ops are **dropped and
  flagged, never guessed** [repo].

## Lines for an MCP audience specifically

- **"Nouns are Resources, verbs are Tools, identities are Prompts, approvals are
  Elicitation."** [new] — the whole server in one sentence: outline and nodes as resources,
  routing/walking/mutation/memory as tools, every prompt-bearing node published as an MCP
  prompt, and the commit gate as a real elicitation.
- **"The human gate is enforced by capability negotiation, not client goodwill."** [new] — a
  client without the elicitation capability is *refused* the commit and pointed to an
  out-of-band approval tool. Server-enforced governance over MCP.
- **"One tool call is a whole state machine."** [new] — `apg_session_step` folds
  decision/action/answer/escalation walking into a single stateless-looking tool returning
  `{session, effects}`.
- **"The graph updates the client."** [new] — every learning write pushes resource/prompt
  list-changed notifications; agents watch the memory evolve without polling.
- **"Deterministic everywhere the LLM isn't — one model call per route."** [new] — no
  randomness in the kernel; the LLM is consulted exactly where judgment is needed and nowhere
  else.

## Analogy bank (and where each breaks)

- **Operating system** (primary) — program/kernel/drivers/syscalls/rings. *Breaks at:* there's
  no scheduler or preemption story; don't stretch to "processes."
- **Biological memory** (learning loops) — attention / waking encoding / sleep consolidation /
  schema accommodation; synaptic downscaling ≈ merge + re-rank. *Breaks at:* neuroscience
  rigor — present as a design metaphor, not a model of the brain.
- **Constitutional government** (transcendence) — constitution, amendments, evidence,
  ratification. Avoid the phrase "Constitutional AI" (taken); say **"a constitution with an
  amendment process."**
- **Git** (mutation) — changesets ≈ PRs with CI (the regression gate), layers ≈ long-lived
  branches, snapshots ≈ tags, audit.jsonl ≈ reflog. *Breaks at:* no merge/rebase of concurrent
  changesets — CAS just makes the loser retry or abort.

## The thesis spine (for the conference talk)

1. **Problem:** agent behavior is trapped in monolithic prompts — unversioned, unauditable,
   and either frozen or drifting.
2. **Move:** make the prompt a *program* — a graph with three edge families — and make the
   runtime deterministic everywhere the LLM isn't.
3. **Payoff 1 (engineering):** portable across languages and hosts; conformance fixtures as
   the ABI; MCP as the syscall interface any agent can call.
4. **Payoff 2 (learning):** because behavior is data, the agent can rewrite it safely — one
   op algebra, wake/sleep loops, glass-box memory.
5. **Payoff 3 (governance):** graded autonomy — facts flow freely, structure needs a
   regression gate, identity needs a human and a drift cap.
6. **Meta-claim:** the leverage isn't in the human-authored artifact; it's in the learned,
   governed representation next to it. Two-level optimization: content within nodes,
   structure across nodes.

## Enterprise pitch (v2) — corrected draft

The enterprise framing, fact-checked against the code paths (2026-07-14):

> Context and prompting are how you align an agent with your brand and culture — so users feel
> they're talking to *your* product, not the model provider. But a wall of text — edge cases,
> rare-product knowledge, every policy at once — confuses the model. The **Wisdom Graph** is how
> enterprise wisdom evolves and gets shared: the agent **writes, merges, and retires its own
> wisdom** from chat and feedback — only changes to the taxonomy's shape or to its own identity
> need a human signature. It's saved in a portable, schema-validated format that can be reused
> later, scoped per tenant or per user, and executed by two independent runtimes.
>
> Learning runs on three timescales borrowed from biological memory: harvest while awake,
> consolidate during sleep, grow new structure in deep sleep — plus an optional fourth, replay,
> which re-reads old transcripts and may only forget with a verbatim user quote. Identity sits
> behind a constitution: the charter amends only under sustained evidence pressure or an
> explicit edict, within a drift cap, with a human signing every amendment. The result: an
> agent that gets better at its job, and a graph you can read, diff, roll back, and govern.
>
> Per query: **ROUTE** — where does this belong? (the classifier sees a stripped, descriptor-only
> outline, never the prompt payloads) · **RESOLVE** — what does the answer need? (bring edges
> aggregate companion nodes) · **COMPOSE** — compile the *system prompt* from the winning path
> plus its wisdom nodes (the user's message rides separately) · then **either** the host
> **GENERATES** against it, **or** — when routing lands in a flow subtree — the kernel **WALKS**
> the decision/action/answer nodes deterministically, emitting **effects** the host executes.
> The kernel decides; the host acts.

Wording rulings baked in above: "walk" stays the verb and "effects" is its output (`sessionStep`
walks flow edges and *emits* `ask`/`say`/`toolCall`/`escalate`…; renaming the step "effect"
names the output and loses the actor). The pipeline **branches** after route — category
landings never walk; flow landings walk before composing. And compose never embeds the user's
message: `compose()` is a pure function of (graph, targets, vars) whose output becomes the
system prompt.

## Enterprise terms with code receipts

Each term: the line you say, why it lands, and the code behavior that makes it true.

- **Autonomous at the content tier** — *"The agent writes, merges, and retires its own wisdom;
  only the taxonomy's shape and its own identity need a human signature."* Reasoning: "manages
  itself" unqualified reads as liability; naming the two human-gated exceptions turns the same
  claim into the trust story. Receipts: `harvestTurns` authors fact text, picks the category
  (enum-constrained, `route()` fallback), decides refine-vs-add, links `seeAlso` edges, and
  commits with no gate (`memory/src/digest.ts`); `digestFeedback` retires rules via
  `deleteNode` cascade autonomously; `runSleep` merges/retires/re-ranks autonomously
  (`memory/src/sleep.ts`) — while `maybeGrow` and `proposeAmendment` both end in
  human-approved changeset drafts.

- **Graded autonomy** — *"The riskier the change, the more ceremony it needs."* Reasoning: the
  governance pyramid is the differentiator versus opaque memory products. Receipts: tier 1
  commits directly (`commitOps(…, {actor: "feedback", retry: true})`); tier 2 growth drafts a
  lifecycle changeset validated against `meta.regression` and blocked on stolen queries
  (`memory/src/grow.ts`); tier 3 amendments add the drift floor, the semantic-inversion
  verifier, citation-weighted pressure, and a mandatory human gate at any transcendence score
  (`memory/src/transcend.ts`).

- **"Constraints are never dropped."** — *"Your compliance rules cannot be squeezed out of the
  prompt."* Reasoning: enterprises fear silent truncation of policy text under context
  pressure more than they fear token cost. Receipts: the composer marks path-constraints
  fragments `droppable: false`; under budget pressure it drops examples (400), then brings
  (700), then path knowledge (800) — never constraints (`core/src/compose.ts`, pinned by
  fixture 25; ladder in `docs/spec/determinism.md`).

- **Memory with a changelog** — *"Read it, diff it, roll it back."* Reasoning: auditability and
  rollback are the primitives enterprise trust is built from; opaque vector stores have
  neither. Receipts: every write — human, harvest, sleep, amendment — is the same 17-op
  mutation algebra through `applyChangeset`; each commit appends `{actor, fromVersion,
  toVersion}` to `audit.jsonl`; `FileGraphStore` snapshots every version
  (`{graphId}@{version}.apg.json`), and `GET /api/graph?version=` serves any historical state.

- **The evidence rule** — *"The agent can't launder its own inferences into the authority to
  forget."* Reasoning: memory errors are written in at extraction/update time — so destructive
  authority requires receipts, not model confidence. Receipts: `verifyCitation`
  (`core/src/replay-gate.ts`) demands a verbatim, whitespace-normalized quote from a **user**
  turn before any degrading replay op applies; uncited degrades drop to the pressure ledger;
  and charter petitions weigh cited conflicts at 1.0 versus 0.5 for uncorroborated inference
  (`citeConflict` in `memory/src/sleep.ts`, `weighPressure` in `memory/src/state.ts`).

- **Human gate via capability negotiation** — *"Governance is enforced by the protocol, not by
  client goodwill."* Reasoning: an MCP audience knows tool-side promises are worthless; a
  server-enforced gate is a real invariant. Receipts: `apg_commit_changeset` checks
  `getClientCapabilities().elicitation` and fires a real elicitation; a client without the
  capability is refused and pointed at the out-of-band `apg_approve_changeset`
  (`mcp-server/src/server.ts`; accept/decline/no-capability all tested).

- **Evolution with a brake pedal** — *"Self-modification is only safe when regressions are
  measurable before commit."* Reasoning: the fear with self-evolving systems is silent
  behavioral drift; a pre-commit gate makes drift a number. Receipts: `evalRouting` replays
  the graph's `meta.regression` labeled queries against the mutated graph and reports
  **traffic steal** — failures won by the changeset's own nodes (`core/src/regress.ts`,
  fixture 63); growth proposals are blocked outright when steal > 0.

- **Generate stays external** — *"The wisdom layer outlives your model choice."* Reasoning:
  provider independence is a procurement requirement, not a nice-to-have. Receipts: the kernel
  emits `ComposedPrompt {text, slots, toolAllowlist}` and never calls a model to answer; the
  same output drives a native Anthropic call (Sage) and a LangGraph ReAct agent (Repair Shop,
  `prompt: composed.text`, tools filtered by `composed.toolAllowlist`) —
  `examples/wisdom-chat/src/lib/{chat,shop-agent}.ts`.

## Claims discipline — say / don't say

Safe to claim (implemented + fixture-pinned): two-runtime parity; deterministic kernel;
changeset lifecycle with regression gate; pinned protection; layers with drop-and-flag; the
full wake/sleep/growth/transcendence loop in wisdom-chat; the evidence gate; MCP
elicitation-gated commits; the memory tools over MCP.

Qualify before claiming: the graph's `connectors` block is *declared* but the shipped MCP
server injects drivers programmatically (LexicalLlm by default); MCP sessions are in-memory;
`mcp-client` tools driver and real telemetry are not shipped; single-process locking; the
learning benchmarks (HaluMem/LongMemEval) are a plan with a fit argument, not results yet.

Don't say: "multi-agent federation," "learned routers," "streaming composition" (explicitly
deferred); any theorem-flavored guarantee about learning dynamics — the design principles
transfer from the literature, the proofs don't.

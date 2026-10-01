# Wisdom Chat

A Next.js app with two agents, each backed by its own Adaptive Prompt Graph (left pane, live):

- **Sage** — a companion that learns *about you*: every 5 messages (and at end-chat) an LLM
  reads the transcript and saves durable facts into its wisdom graph.
- **Repair Shop** — a **LangGraph** ReAct agent for a small-engine shop, tuned by *direct
  feedback*: hit **👎 Adjust** on any reply, or type into the **🎓 Teach box** with no message
  at all ("always mention the warranty when quoting"). The digest decides per instruction
  whether to **add** a new standing rule, **refine** an existing one in place
  (`feedbackCount` increments — repeated feedback strengthens one node instead of accreting
  duplicates), or **retire** a rule the feedback contradicts (node deleted, bring references
  and seeAlso edges cleaned, all in one atomic changeset). Tool feedback can go as far as
  `toolAllowlist` removals that physically take tools away from the agent. In large graphs the
  digester's candidate set is scoped by routing the feedback text (plus seeAlso neighbors),
  so teaching stays cheap as the graph grows.

The repair shop demonstrates APG as a **control plane over a foreign agent framework**:
`compose()` builds LangGraph's system prompt, `compose().toolAllowlist` filters which
LangChain tools the agent receives, LangGraph's reported tool calls feed the feedback
digester, and every adjustment is an ordinary validated changeset. A **routed ⟷ full**
toggle in the header switches between selective context (per-message routing picks the
branches; the root rides along as a secondary target so global preferences still load —
conformance fixtures 56/57) and whole-graph context, with a per-reply stats line showing
the difference.

What dictates *what* gets learned is the graph itself: category nodes (`Life Philosophy`,
`Goals`, `Interests`, `Observations`) carry a `props.learn` description, and the graph's
routing descriptor (`["title", "props.learn"]`) puts that guidance in front of the extractor
via `serializeOutline`. Adding a new category node to the graph changes what Sage learns —
no code change.

## Library surface exercised

| Step | Library call |
|---|---|
| System prompt | `compose(graph, ["wisdom"])` — persona + constraints + **all learned knowledge** via `recursiveBring` |
| Reply | `AnthropicLlm.generate({prompt, query, history})` |
| Routing badges | `route(message, graph)` — which categories a message touches |
| Learning vocabulary | `serializeOutline(graph)` over the `props.learn` descriptor |
| Fact extraction | `AnthropicLlm.extract(transcript, factsSchema)` (forced tool call) |
| Branch point | LLM's `categoryId` validated against the graph, else `route(fact)` |
| Dedup | `findNodes(graph, fact, {field:"prompt", subtreeId:category})` |
| Save | `applyChangeset(doc, [addNode, setBring, setEdge…])` — atomic, validated, version-bumped |
| Persistence | `FileGraphStore` (`data/wisdom-profile.apg.json` + per-version snapshots) |

## Run it

```bash
# 1. build the library (once)
cd ../../typescript && pnpm install && pnpm -r build

# 2. install + run the app
cd ../examples/wisdom-chat
pnpm install
pnpm dev
```

Open http://localhost:3000. The API key is read from `ANTHROPIC_API_KEY` in the environment,
the app's own `.env`, or the **repo-root `.env`** (all gitignored) — whichever is found first.
The graph seeds itself from `templates/wisdom-profile.apg.json` on first run; everything
lives under `data/` (delete it to reset Sage's memory).

Without an API key the app still boots and renders the seed graph, but chat is disabled.

## Live test scripts (repair shop)

The Repair Shop pane has a **🧪 Test** button that opens a popover of canned scripts
(3–8 steps each). Only the *user side* is scripted — every step runs through the real
`/api/chat` / `/api/feedback` pipeline, the live LLM digests it, and the real store
commits. Before each step the transcript shows the **expected graph change** (dashed
note row); after each feedback step it shows what the digester **actually did**
(new/refined/retired/tools removed + new graph version) and refreshes the tree, so you
verify accuracy by eye — nothing about the graph outcome is mocked. Scripts cover:
👎 Adjust add-then-refine, Teach-box add → refine → retire, tool denial via
`toolAllowlist`, and an identity edict → gated charter amendment. The ⏹ button stops a
run; **writes are real and persist** (delete `data/` to reset).

For direct feedback insertion without the UI (the Teach-box path, no session):

```bash
pnpm test:feedback                                       # canned add → refine → retire lifecycle
node scripts/insert-feedback.mjs "always mention the 90-day warranty when quoting"
node scripts/insert-feedback.mjs --identity "you are now also the service manager"
```

It prints the digest result plus the observed node-count/version delta after each step
(the app must be running).

## The memory system: sleep + transcendence

Learned rules are held **durably until an explicit, audited actor touches them** — every graph
write (harvest / feedback / sleep / amendment) goes through a per-agent lock + compare-and-swap
(user writes always beat maintenance), atomic file writes, and `data/audit.jsonl`. Pin any rule
with `props.pinned: true` and no sleep will ever merge or retire it.

**Sleep** (consolidation) runs four ways: the 😴 button, *bedtime* (after a session ends), *sleep
pressure* (an idle timer armed after each write — default 2 min of quiet), and *cron*
(`curl -X POST -H "Authorization: Bearer $CONSOLIDATE_SECRET" localhost:3000/api/consolidate`).
Automatic sleeps that run between messages surface as a toast on your next reply.

**Transcendence** governs whether the agent's *charter* (root persona/philosophy) may evolve.
Sleep reviews flag rules that conflict with the charter into a pressure ledger (never deleting
them); enough pressure — or an explicit identity edict via the Teach box — generates a **draft
amendment**: minimal per-slot rewrites, drift-capped by embedding similarity, always requiring
your approval in the graph panel (⚡ gauge shows pressure building; the root pulses while a
proposal is pending). Sage runs score 0.6 (constraints+task may amend), the shop 0.1
(constraints only, tight drift). Tune per graph via `meta.memory`, or pace demos with
`SLEEP_IDLE_MS` / `SLEEP_COOLDOWN_MS` / `AMEND_COOLDOWN_MS`.

## Scaling behavior

Two mechanisms activate as the graph grows, both already wired:

- **Selective context**: below 25 learned facts Sage composes the root (total recall — every
  fact in the system prompt). Above it, the per-message routing result becomes the retrieval
  mechanism: `compose(graph, matchedCategories)` pulls only the matched branches' knowledge.
- **Embedding shortlist**: set `VOYAGE_API_KEY` or `OPENAI_API_KEY` (root `.env` works) and
  routing adds the vector pre-filter — stored `node.embedding` vectors are compared by cosine,
  top-K survive to the classifier. Harvests call `precomputeEmbeddings` so any new routable
  branch point is vectored once at write time, never per query.

Known limits of the learning/feedback tier (consolidation, concurrency, gating) are tracked in
[`docs/known-concerns.md`](../../docs/known-concerns.md).

## Notes

- The library packages are `link:` dependencies into the built pnpm workspace, and are kept
  `serverExternalPackages` so their `node:fs` schema/template reads work natively.
- Graph snapshots (`data/wisdom-profile@{version}.apg.json`) accumulate one per harvest —
  `GET /api/graph?version=…` serves any historical state.
- All library calls are server-side (route handlers); the browser only ever sees JSON.

## ⚖ Compare: monolith mega-prompt vs graph compose (`/compare`)

An A/B benchmark of the library's core claim, on a use case built for it: the **Cedar Grove
Veterinary Clinic** assistant (94-node graph — a ~1,100-word charter, 9 species/service
categories, 84 knowledge leaves totalling ~113k chars). Same chatbot, two prompt strategies:

- **Monolith ("no library")** — one prebuilt master system prompt with every policy and all
  84 leaves inline (~30k tokens), sent on every request. Zero library calls in the request
  path; `buildMonolith()` flattens the template with plain string concatenation.
- **Graph** — one routing classify call scopes the user message, then `compose()` builds the
  prompt from the charter + matched categories only (typically 5–7k tokens). The routing
  call's latency is the library's cost and is reported separately as `route ms`.

Everything else is byte-identical: the same LangGraph ReAct agent, `ChatAnthropic` client and
model constants, the same five mocked tools (`apptSlots`, `medDose`, `toxinCheck`,
`boardingAvailability`, `priceEstimate`), and the same shared conversation history. Content
parity is structural — both prompts derive from `templates/vet-clinic.apg.json`, and the test
suite asserts every leaf appears verbatim in the monolith.

Per reply the UI shows: mode, routing chips, tool calls (args on hover), a
route/compose/generate timing breakdown, **real API token usage** (summed input/output plus
the first call's input tokens, which the system prompt dominates), prompt size, and the exact
system prompt behind an expandable details block. Toggle the mode mid-conversation, or check
**Run both** to send one message through both arms concurrently and get a side-by-side card
with a delta line — only the active arm's reply joins the history. The left panel aggregates
per-mode averages.

Fairness notes: neither arm uses prompt caching; history grows identically in both arms (so
first-call input tokens and prompt chars are the cleanest deltas); the graph is read-only here
— no harvest, feedback, or sleep runs on this page. Sessions persist under `data/compare/`.

The page ships a **curated sample suite** (chips above the input; hover to see what each
probe demonstrates — cross-species disambiguation, constraint survival, needle-in-haystack,
fallback floor, tool math; the ⚖ chips fire both arms). Costs are shown in real dollars per
message and projected monthly on a volume slider. Routing uses a dedicated small-model
(Haiku) connector instance — `route()` takes whatever classify model the connector defaults
to, so this needed no library changes; generation stays on the same Sonnet constants in both
arms. The full improvement catalog and later chunks (embedding fast-path routing, cached
compose, LLM-judge scoring, scaling charts) live in
[`docs/compare-roadmap.md`](../../docs/compare-roadmap.md).

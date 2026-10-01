# ⚖ Compare demo roadmap — showcasing graph-composed prompts vs the monolith

The `/compare` page (examples/wisdom-chat) benchmarks the library's core claim on the Cedar
Grove Veterinary Clinic graph (94 nodes, ~30k-token monolith). Live baseline from the first
verified drive: monolith ~29.9k input tokens and 10.3s generate per message; graph ~6.3k
input tokens with a 3.5s route + 9.7s generate; identical tool behavior and answer quality.
This doc is the durable catalog of everything identified to sharpen that story, tagged by
implementation chunk. Library-level items follow the repo rule: kernel semantics land in both
runtimes with conformance fixtures.

## Demo improvements

| # | Item | Why | Status |
|---|------|-----|--------|
| 1 | **Sample-question chips**, each labeled with what it proves | viewers shouldn't have to invent good probes; makes the demo reproducible | **chunk-1 (implemented)** |
| 2 | **Dollar cost per message + monthly projection card** with a volume slider | money persuades; tokens are abstract | **chunk-1 (implemented)** |
| 3 | **Fast routing via a small classify model** (dedicated Haiku connector instance) | the route call is the library's entire overhead (~3.5s on Sonnet) | **chunk-1 (implemented)** |
| 4 | One-click **benchmark script**: run the whole sample suite through both arms → scorecard (tokens, ms, $, tool parity) | reproducible, shareable evidence | **chunk-2 (implemented — ▶ button; first verified run: graph 101k vs monolith 343k input tokens, −70.5%, tool parity 8/8)** |
| 5 | **Scaling story**: prompt-tokens-vs-knowledge-size chart + synthetic 2×/5× knowledge toggle | the monolith grows linearly toward the context ceiling; the routed line stays flat — the deepest argument | chunk-3 candidate |
| 6 | **Blind LLM-judge** scoring both replies (species-correct? constraint compliance? right policy cited?) → compliance-rate column | giant prompts *degrade* quality (dilution); turn anecdotes into a metric | chunk-3 candidate |
| 7 | **Streaming + time-to-first-token** metric | users feel TTFT, and big prompts hurt it most | chunk-3 candidate |
| 8 | Third arm: **monolith + prompt caching** | preempts the obvious objection; show steady-state savings AND whole-prompt invalidation on every knowledge edit vs surgical node updates | chunk-4 candidate |
| 9 | Export a session comparison as a shareable report | demo artifact to send around | recorded |

## The sample-question suite (chunk-1, pinned by tests)

Each probe demonstrates one failure mode of the monolith or one strength of routing:
cross-species disambiguation (bird + chocolate — the monolith is full of *dog*-chocolate
content), constraint survival under 30k tokens of dilution (dose request without tools),
urgency detection from a single constraint leaf (rabbit GI stasis), needle-in-haystack (the
one buried Monday-grooming fact), multi-category routing with two tool calls (new-kitten
Saturday visit), the fallback floor (off-topic movie question — the graph declines with a
~7k-char prompt, the monolith spends ~30k tokens doing the same), mid-conversation topic
switching, and tool-grounded math (multi-night boarding). Canonical list:
`examples/wisdom-chat/src/lib/sample-questions.ts`; the offline routing test asserts each
routes to its intended category so the demo script can never silently rot.

## Library performance items

| # | Item | Effect | Status |
|---|------|--------|--------|
| 1 | **Embedding-only routing fast path**: confidence bypass skips the LLM classify when the shortlist top-1 clears a cosine margin | route ~3.5s → ~200ms on decisive queries; LLM classify becomes the ambiguity tiebreaker | **chunk-2 (implemented — `routing.embedBypass`, fixtures 65/66, both runtimes)** |
| 2 | **`routing.modelHint`** in graph defaults so templates declare a small classify model portably | today the classify model is whatever the connector instance defaults to | chunk-2 |
| 3 | **Route caching** via existing `routeCacheKey` + session-sticky routing for elliptical follow-ups ("and what about calcium?") | most real-conversation turns pay zero route cost | chunk-2/3 |
| 4 | **Surface API `usage`** from `AnthropicLlm` classify/extract calls | routing cost becomes measured, not estimated | **chunk-2 (implemented — `AnthropicConfig.onUsage`; the demo's route cost badge is now measured)** |
| 5 | **Cache-aware compose**: emit stable-fragment / cache-breakpoint metadata from `compose()` (charter prefix first, category blocks as stable fragments) | routed AND cached — strictly better than a cached monolith: one node edit invalidates one fragment, not the whole prompt | chunk-4 |
| 6 | **Query-relevance leaf pruning** (leaf-embedding tier): top-k relevant leaves in full, `props.label` one-liners for the rest | another 2–3× prompt reduction on narrow questions | chunk-4 |
| 7 | **Scoped tool binding** from matched categories' `toolAllowlist` | fewer tool schemas in the request, better tool selection — structurally impossible for a monolith | recorded |

## Fairness invariants (hold for every chunk)

Same model constants, same tools, same shared history in both arms; content parity is
structural (both prompts derive from `templates/vet-clinic.apg.json`, pinned by the monolith
parity test); the routing call is always reported separately as the library's cost; no hidden
caching asymmetry (caching, when added, becomes an explicit labeled arm).

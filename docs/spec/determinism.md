# APG Determinism Contracts (normative)

The places two runtimes (or two releases) silently diverge, pinned by spec and enforced by the
conformance fixtures in `/schema/conformance/fixtures`. Where this document and a fixture
disagree, the fixture wins and this document has a bug.

## 1. Outline serialization

Depth-first, authored sibling order (`reorderChildren` is therefore routing-relevant). One line
per rendered node:

```
{indent}{id}: {descriptor fields joined " — "}
```

- `indent` = two spaces × the number of **rendered** ancestors (an excluded ancestor does not
  indent its descendants).
- Descriptor fields render in declared order; empty fields are skipped.
- Text is NFC-normalized; newline runs (with surrounding whitespace) collapse to one space.
- Rendered set: routable, non-pruned nodes; with a shortlist, the shortlisted nodes plus their
  routable ancestors.
- Field values: strings as-is; string arrays join with `", "`; numbers/booleans stringify;
  objects JSON-stringify.

The outline for a given `(graph, shortlist)` is byte-stable — cache-key input and fixture
assertion both.

## 2. Tie-breaking (total order)

Sorting matches: confidence descending, then **deeper node first**, then sibling order along the
path from the root, then lexicographic id. No randomness anywhere in the kernel.

## 3. Routing pipeline

1. Eligibility: `routable !== false`, not pruned, `entryCondition` (if any) holds under session vars.
2. Embedding shortlist only when an embeddings connector is bound **and** eligible count exceeds
   `shortlistK`; cosine similarity, ties by the §2 node order; shortlist re-emitted in DFS order.
   Stored `node.embedding` vectors are preferred: the connector is called once per route with
   the query plus only the nodes lacking a vector (`precomputeEmbeddings` is the write-path
   counterpart that fills them in, embedText fields only).
3. Classifier output is **deduped by nodeId (highest confidence wins)**, filtered to outline
   members, gated by `minConfidence`, sorted by §2.
4. `allowMulti: false` keeps top-1.
5. Fallback (in order): below-threshold top candidate's nearest `fallbackNodeId` on its ancestor
   path (self first) → first `isFallback` node in DFS order → root. **Pruned nodes are never
   fallback targets.** Fallback matches carry `confidence: 0`.

## 4. Bring resolution

BFS from the landing node's `bring[]`. The **landing node's** `recursiveBring` governs the whole
expansion (false = one hop: brings found on brought nodes are NOT expanded). Seen-set cycle
safety (landing node pre-seeded). Depth capped by the landing node's `maxBringDepth` (default 3).
Unknown refs → `dangling[]` (telemetry, never fatal at runtime; the validator errors on them at
rest). Tenant-crossing brings (both `metadata.tenantId` set, different) → `tenantBlocked[]`.
Order: BFS level order; within a level, `bring[]` array order.

## 5. Composition

Three stages, strict order — path, imports (secondary matches + brings), overlays.

- **Stage 1 (path)**: root→leaf; each contributing node's slot fragment applies the contributor's
  merge mode (`node.composition.mode[slot]` → `node.composition.defaultMode` → graph defaults →
  `"append"`). `override` clears accumulated fragments for the slot; `merge` appends unless an
  identical fragment exists; `prepend` inserts at head.
- **Stage 2 (imports)**: secondary routed matches compose as contextOnly imports, then brings per
  landing node (contextOnly slots `knowledge`/`constraints`/`examples`, or all text slots when
  the landing node's `bringMode` is `"full"`). Imports always append. Brings expand for
  **targets only** — a path ancestor's `bring[]` is NOT expanded (fixture 56); to load
  root-anchored global context in selective composition, pass the root as a secondary target
  (its brings load, its path slots don't duplicate — fixture 57).
- **Stage 3 (overlays)**: user overlays for nodes on the primary path, ancestors first;
  contextOnly by construction; always append.
- `fewShot` renders as `Input: {input}\nOutput: {output}` into `examples`.
- `queryRewrite`: deepest path node wins; `{{query}}` is available; not part of `text`.
- Assembly: slot order `persona, task, constraints, knowledge, examples, outputFormat`; fragments
  within a slot join with `\n\n`; non-empty slots join with `\n\n` into `text` (no headers —
  hosts have the structured `slots`).
- `outputSchema`: deepest path node wins. `modelHints`: graph default ⊕ path overrides, leaf
  wins per key. `toolAllowlist`: intersection over path nodes that declare one.
- **`contributors`**: nodes with at least one fragment SURVIVING the budget, ordered by each
  node's first fragment (ascending contribution sequence), text slots only — a fully truncated
  node is not a contributor (fixture 58). This is the usage-telemetry contract.

### Truncation priorities (higher kept longer)

| Fragment | Priority |
|---|---|
| Path `constraints` | never dropped |
| Leaf `persona`/`task` | 900 |
| Other path fragments | 800 |
| Direct brings / secondary matches | 700 |
| Recursive brings | 700 − 50×(depth−1) |
| `examples` (any stage except overlays) | 400 |
| Overlays | 100 |

`node.composition.priority` overrides the computed value. Token counting: connector
`countTokens` if provided, else **ceil(Unicode code points / 4)**, summed per fragment. Drops
remove whole fragments in ascending priority; equal priority → most recently contributed drops
first; every drop is recorded in `truncated[]`.

## 6. Variables

Precedence (low → high): graph `variables[].default` → tenant → memory → session → call-site.
Prompt-template `variables[].default` entries apply only when the declaring node is part of the
composition (primary path + imports) — a default on an unrelated subtree never leaks in; graph-
level `variables` defaults are global. A **referenced** required variable that resolves nowhere
raises
`Missing required variable "{name}" at node "{nodeId}"`; an optional one renders empty and is
recorded in `unresolved[]`. Templating is logic-less: mustache `{{name}}` (default) or f-string
`{name}`; `{{props.x.y}}` resolves against the contributing node's props; non-string values
render as JSON.

## 7. Expression language

`guard` / `entryCondition` / `exitCondition` / `skipCondition` share one sandboxed grammar:
comparisons (`== != < <= > >=`), boolean ops (`&& || !`), `has(path)`, dotted identifiers,
string/number/bool/null literals, parentheses. Missing identifiers resolve to `null`; `has` is
true iff the path exists non-null; ordering requires two numbers or two strings (else false);
equality is strict across types; truthiness: `false`, `null`, `0`, `""` are falsy. Templates are
untrusted userland: no arbitrary code, ever.

Number literals contain at most one dot; a malformed literal (`1.2.3`) is a parse error in both
runtimes, never a silent NaN. There is no unary minus (compare against `0 - x`-free expressions
or session vars instead). `has` not followed by `(` parses as an ordinary variable named `has`.

## 8. Session walking

Deterministic stepping; the only LLM touches are scoped freeform mini-classification and the
single opportunistic-fill extraction per user turn (filled vars never overwrite known vars —
never re-ask what's known). Decision resolution order: known `saveAs` var → `guard` resolving to
a choice value → explicit input (value, then label, case-insensitive) → freeform classification
→ ask. Escalation tickets: `ticket-{nodeId}-{stepCount}`; history timestamps are logical
(`#{stepCount}`). Answer terminals say + complete the walk; category terminals emit
`composeReady` and return to routing.

Further pinned walker behaviors:

- **Escalation intake never stalls silently**: a `require`-mode escalation with missing
  `collectBeforeHandoff` vars elicits them (explicit fill and opportunistic extraction both
  apply — `collectBeforeHandoff` specs join the open-vars extraction schema) before the ticket
  opens.
- **`visitPolicy: "once"`**: arriving at an already-visited once-node diverts to the nearest
  `fallbackNodeId` on its ancestor path (self first, self-loops excluded), else the walk
  completes. A divert cycle within one step (once-nodes whose fallbacks point at each other)
  completes the walk on the first repeat instead of consuming the step limit.
- **`enter` to an unknown node** (stale routing after a graph mutation) reroutes gracefully
  (`mode: "routing"` + `reroute` effect) — never a raw error. The same guard applies to a stale
  `currentNodeId` at the start of any step.
- **Explicit-fill numeric coercion**: only strings matching `^[+-]?(\d+(\.\d*)?|\.\d+)$` coerce
  to numbers; hex, underscores, `nan`/`inf` etc. stay strings (and then fail number schemas,
  re-eliciting). This pins JS `Number()` vs Python `float()` differences out of existence.
- **Category `exitCondition` gates composition**: a category node whose exitCondition fails
  elicits (`Exit condition not met: {expr}`) instead of emitting `composeReady` — this is the
  loopUntilValid intake pattern.

## 9. Mutation

Ops apply transactionally in order; changesets abort on first structural failure **and** on a
failed post-validation; layers drop-and-flag failed ops and continue (`updateRoutingConfig` is
base-scope-only and always dropped from layers). `updateNode` patch: deep-merge; `null` deletes
a key; arrays replace wholesale. Nodes inserted by `addNode`/`graftSubtree`/`splitNode` are
normalized to canonical form. After every op the nodes array re-serializes in DFS order. Version
bump: a trailing `-N` increments; otherwise `-1` is appended. Route cache key:
`(query, baseVersion, ...layerVersions)`.

**Pinned protection**: `pinned: true` nodes abort removal ops — `deleteNode` (a cascade checks
every descendant), `pruneSubtree`, and `mergeNodes` victims (merging INTO a pinned node is
fine) — with `Node "x" is pinned (pass force to override)`; `force: true` on those three ops is
the explicit escape (fixtures 59–61). Content edits (`updateNode`) remain legal. Layer ops
violating the guard are dropped-and-flagged, never fatal (fixture 62). `pinned` is a reserved
structural key (`props.pinned` → RESERVED_PROPS_KEY).

**Store compare-and-swap**: `GraphStoreConnector.save(doc, {expectedVersion})` — a string must
equal the stored latest's version; `null` means create-only; violations throw
`StoreConflictError` in both runtimes. FileGraphStore's check is advisory across processes.

**Embedding fast path** (fixtures 65/66, opt-in via `defaults.routing.embedBypass`): when an
embeddings connector is bound and `embedBypass` is configured, shortlist similarity scores
compute even for pools smaller than `shortlistK`. If the top-scored node clears BOTH gates —
`sim ≥ minSimilarity` and `(top1 − top2) ≥ minMargin` (a lone candidate needs only the first)
— routing returns that single match with `confidence = cosine` and `reason: "embedding"`, and
the outline/classify/gate/fallback stages are skipped entirely (the classify connector is
never called). On decline, the classify path proceeds unchanged. `minConfidence` governs only
the classify path; the bypass has its own two gates. Default: disabled (`embedBypass: null`).

**Routing regression** (fixture 63): `evalRouting` evaluates labeled queries sequentially in
input order (one classifier call each — mock queues line up one-to-one); pass = expected node
within the top-K gated matches (default 1); a fallback route never passes; failures whose
winner is in `focusNodes` are reported as `stolen` (traffic steal). The portable labeled set
lives in `meta.regression`.

**Changeset lifecycle**: draft → validated → approved → committed | discarded, strict
transitions (`Cannot <verb> changeset in status "<s>"`); validation = dry `applyChangeset` +
structural report + optional regression gate (status advances only when both pass); commit IS
`applyChangeset`, permitted from approved (or validated with explicit `autoApprove`).

**Layer rebase**: `rebaseLayer` re-applies through `materializeLayers` (drop-and-flag,
fixtures 39/40/62), writes the conflicts into the returned layer, and stamps the new
`baseVersion`; ops are never rewritten.

**Growth math**: `clusterBySimilarity` is greedy single-link in input order (an item joins the
FIRST cluster with any member ≥ threshold); `medoid` maximizes total similarity with ties to
the lowest index; `buildSplitOps` emits per group addNode → moveNode(s) → setBring, then one
final authoritative setBring on the source category.

**Evidence gate** (fixture 64, `applyEvidenceGate` both runtimes): the pure half of
preservation-biased replay. Degrade classification over the op algebra — always degrading:
`deleteNode`, `pruneSubtree`, `mergeNodes`, `unlinkChoice`, `removeEdge`, `updateGraphConfig`,
`updateRoutingConfig`; `setBring` degrades iff the new array drops any id currently in the
node's bring (supersets/reorders are additive); `updateNode` degrades iff the patch nulls any
key at any depth (arrays are wholesale replacement, not keyed deletion — list values are not
recursed) or replaces an existing non-empty prompt slot with strictly shorter text. Citation
verification is mechanical: the quote must appear as a substring of the cited turn's content
after whitespace normalization (runs collapse to one space, trimmed; case-SENSITIVE), and the
turn's role must be `user`. Failure reasons, most specific per citation:
`transcript-not-found` → `turn-out-of-range` → `not-user-turn` → `quote-not-found`; a degrading
op with no citations reports `no-citation`; with several citations the last examined failure
wins. Kept ops re-index their evidence to positions in the kept array; dropped ops report their
ORIGINAL index. Changeset carries `evidence?: OpEvidence[]`, plus open `meta` and `createdAt`.

**Transcript watermarks** (engine convention, not kernel): `harvestedUpTo`/`replayedUpTo` are
turn counts — turns below the mark are done; replay advances a watermark only after its batch
commits (a CAS abort leaves it untouched, so the next run re-reads the same window).

## 10. Cross-language parity traps (found porting TS → Python)

Semantics that JavaScript implies silently and every other runtime must replicate explicitly:

- **Equality is JS-strict.** `true ≠ 1`; different types are never `==` in the expression
  evaluator, minischema `const`/`enum`, and decision `saveAs` matching (Python's `True == 1`
  must be suppressed; `3 == 3.0` remains equal).
- **Falsiness is the closed JS set** `false, null, undefined-as-null, 0, ""` — NaN, empty
  arrays, and empty objects are truthy.
- **`integer` accepts integral floats** (`Number.isInteger(5.0)`), and coercing empty user text
  to a number yields `0` (`Number("") === 0`).
- **Three distinct missingness notions coexist:** normalization defaults use nullish coalescing
  (explicit `null` gets defaulted); block detection (`bring`/`collect` present) uses key
  presence; variable resolution treats a `null` value as unresolved.
- **Root detection is strict `parentId: null`** — a node *missing* `parentId` is neither root
  nor child.
- **One `BRING_CYCLE` warning per document** (first cycle found wins).
- **Elicit dedup is cross-effect within a step**: a collect gate suppresses its elicit if any
  elicit effect was already emitted this step.
- **Async is cosmetic in the kernel**: no awaited call interleaves; a sync port is behaviorally
  identical.

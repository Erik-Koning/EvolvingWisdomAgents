# APG Conformance Fixture Format

Every fixture is **pure data**: a graph, an operation, mocked connector responses, and the
expected outcome. Both runtimes (TypeScript and Python) run the identical files. A behavior
change without a fixture change is a bug by definition.

## File shape

```jsonc
{
  "description": "What this fixture pins",
  "schemaVersion": "1.0",
  "graph": { /* inline APG document */ },
  "session": { /* optional initial SessionState (sessionStep ops) */ },
  "vars": { /* optional call-site variable overrides */ },
  "userOverlays": [ /* optional UserOverlay[] for composition stage 3 */ ],
  "mocks": {
    "classify": [ { "matches": [ { "nodeId": "x", "confidence": 0.9, "reason": "…" } ] } ],
    "extract":  [ { "vars": { "name": "value" } } ],
    "embeddings": { "<exact text>": [0.1, 0.2] },
    "tools": { "<toolName>": { "ok": true, "result": {} } }
  },
  "op": { "kind": "<operation>", /* op-specific args */ },
  "expected": { /* see matching rules */ },
  "expectError": "substring of the expected error message (mutually exclusive with expected)"
}
```

## Operations (`op.kind`)

| kind | args | result asserted |
|---|---|---|
| `normalize` | — | canonical graph document after load (defaults applied, string prompts desugared, edges materialized) |
| `validate` | — | `{ valid, errors: [{ code, nodeId? }] }` — error order irrelevant, matched as a set by `code`+`nodeId` |
| `serializeOutline` | `nodeIds?` (shortlist; omit = all routable) | `{ outline }` byte-exact string |
| `evalExpr` | `expr`, `vars` | `{ value }` |
| `route` | `query`, `sessionVars?` | `RoutingResult` (subset) |
| `evalRouting` | `labeled`, `topK?`, `focusNodes?` | `RegressionReport` (subset; queries evaluate in input order, one classify mock each) |
| `resolveBring` | `nodeId` | `{ brought: [nodeId…], dangling: […] }` order-exact |
| `compose` | `nodeId`, `query?` | `ComposedPrompt` (subset; `text` byte-exact when present) |
| `routeAndCompose` | `query` | `{ routing, prompt }` |
| `sessionStep` | `input` | `{ session, effects }` (subset) |
| `applyChangeset` | `ops` | `{ graph }` (subset) or `expectError` |
| `materializeLayers` | `layers` | `{ graph, conflicts }` (subset) |
| `evidenceGate` | `ops`, `evidence`, `transcripts` | `{ kept, evidence, dropped }` (subset; kept evidence re-indexed, dropped reports original opIndex + reason) |

## Matching rules

- `expected` matches as a **recursive subset** for objects: every key present in `expected`
  must deep-match the actual value; extra actual keys are ignored (so `latencyMs` etc. never
  break fixtures).
- An explicit `null` in `expected` asserts **null-or-absent** (used to pin key deletion,
  e.g. `updateNode` patch `null` semantics).
- Arrays match **exactly in length and order**, with each element subset-matched.
- The `validate` op's `errors` array is the one exception: matched as a set keyed by
  `(code, nodeId)`.
- `expectError`: the operation must throw/raise, and the message must contain the substring.

## Mock semantics

- `mocks.classify` is a queue: each classifier call consumes the next entry, in order.
  Confidence gating, tie-breaking, and fallback are applied by the runtime under test — the
  mock returns raw matches only.
- `mocks.extract` is a queue for opportunistic-fill extraction calls.
- `mocks.embeddings` maps **exact text → vector** (query and node embed-text alike). A text
  missing from the map is a fixture bug and must raise. When `mocks.embeddings` is absent,
  the embedding pre-filter is skipped (all routable nodes survive to the outline).
- Token counting uses the pinned fallback: `ceil(len(text) / 4)` over Unicode code points.

## Determinism contracts pinned here (spec §7.1)

1. **Outline**: depth-first, authored sibling order, two-space indent per depth,
   `{id}: {descriptor fields joined " — "}`, NFC-normalized, newlines collapsed to a space,
   routable nodes only; ancestors of surviving nodes are included to preserve tree shape.
2. **Tie-break total order**: higher confidence → deeper node → sibling order → lexicographic id.
3. **Variable precedence** (low→high): graph defaults → tenant → memory → session → call-site.
   Required-unresolved is a compose-time error naming variable and node; optional-unresolved
   renders empty and is recorded in `unresolved[]`.
4. **Budget truncation**: whole fragments, ascending priority; equal priority → most recently
   contributed drops first; path `constraints` fragments are never dropped.
5. **`updateNode` patch**: deep-merge; `null` deletes a key; arrays replace wholesale.

Fixture 65 pins the embedBypass fast path (empty classify mock proves the LLM was skipped);
fixture 66 pins the margin decline (classify mock consumed).

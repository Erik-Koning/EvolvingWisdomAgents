# Learning conventions (normative for interop)

The de-facto schema for graphs that *learn*, established by the wisdom-chat memory system and
honored by its harvest, feedback, sleep, and transcendence loops. Hosts and MCP agents that
follow these conventions interoperate with any APG learning pipeline.

## Structural (kernel-enforced)

- **`pinned: true`** (top-level node field) — protected from removal ops (`deleteNode`,
  `pruneSubtree`, `mergeNodes` victims; cascade checks descendants) unless the op passes
  `force: true`. Content edits remain legal. This is a library invariant, fixture-pinned
  (59–62). `props.pinned` is a reserved-key violation.
- **`composition.priority` reinforcement band 700–800** — learned rules live in the
  direct-bring band; consolidation maps reinforcement onto `700 + 25·(weight−1)`, capped at 800
  (below leaf persona/task at 900; path constraints are never dropped).

## Learning props (userland vocabulary, read by the loops)

| Prop | Meaning |
|------|---------|
| `props.learn` | On a category: what this category wants learned (routed to extractors via the routing descriptor) |
| `props.storeAs` | On a category: which slot its learnings occupy (`knowledge` facts / `constraints` behavior / `examples`); feedback defaults to `constraints`, harvest to `knowledge` |
| `props.feedbackCount` | Reinforcement counter — refines increment it; merges sum it |
| `props.label` | ≤10-word summary shown in candidate listings instead of blind truncation |
| `props.source` | `chat` (harvest) or `feedback` (taught) |
| `props.sessionId` | Session that produced the learning (`"direct"` for message-free teaching) |
| `props.learnedAt` / `updatedAt` / `consolidatedAt` / `amendedAt` | ISO lifecycle timestamps |

## Runtime contracts the loops rely on

- **`ComposedPrompt.contributors`** — nodes with ≥1 surviving fragment, first-contribution
  order (fixture 58): the usage signal for decay/retirement decisions.
- **Audit actors** — every graph mutation is one of `harvest | feedback | sleep | amendment |
  manual`, recorded append-only with `fromVersion → toVersion`.
- **Store CAS** — writers pass `expectedVersion`; `StoreConflictError` means the base moved.
  Policy convention: user-initiated actors retry against fresh, maintenance actors abort
  (user work always beats maintenance).
- **Charter** — the root node's own `persona`/`task`/`constraints` slots (brings excluded);
  its hash gates identity-aware reconsolidation after amendments.

# Adaptive Prompt Graph (APG)

**An operating system for prompts.** A graph of prompt categories is a portable, schema-validated
JSON *program* (`*.apg.json`); connectors are *drivers* (LLM, embeddings, store, session, memory,
tools, handoff, telemetry); the core runtime is the *kernel* (route → resolve → compose →
walk → effects);
MCP is the *syscall interface* for external agents. One runtime, any use case — the JSON template
decides.

Two runtimes, one schema: `/schema` holds the language-neutral JSON Schema plus a conformance
fixture suite; the TypeScript and Python kernels implement identical semantics and must pass the
same fixtures. **A behavior change without a fixture change is a bug by definition.**

## Repository map

```
schema/                 ★ single source of truth: JSON Schema 2020-12 + profiles + conformance fixtures
templates/              ready-to-run graph templates, one per capability profile (L0–L5)
typescript/packages/
  schema/               @apgraph/schema — TS types + Ajv document validator
  core/                 @apgraph/core — the kernel (zero framework deps)
  connectors/           @apgraph/connectors — shipped drivers: Anthropic LLM, file/transcript/state stores, lexical demo
  memory/               @apgraph/memory — the memory engine: harvest, feedback digest, sleep, deep-sleep growth, transcript replay, transcendence
  mcp-server/           @apgraph/mcp-server — MCP facade (route_query, apg_session_step, apg_* tools, memory tools, --data-dir persistence)
  cli/                  adaptive-prompt-graph — `apg validate | outline | tree | route | compose | walk`
python/packages/
  apg-core/             apg-core — the kernel, ported module-for-module (stdlib only)
docs/                   spec text: pinned determinism semantics
```

## Quickstart

Prerequisites: Node ≥ 20 with pnpm (`corepack enable`), and [uv](https://docs.astral.sh/uv/) for Python.

```bash
# TypeScript
cd typescript && pnpm install && pnpm -r build && pnpm -r test

# CLI
node packages/cli/dist/main.js tree     ../templates/l3-triage-flows.apg.json
node packages/cli/dist/main.js outline  ../templates/l4-support-bot-handoff.apg.json
node packages/cli/dist/main.js route    ../templates/l0-prompt-switcher.apg.json "plan a trip to Portugal"
node packages/cli/dist/main.js walk     ../templates/l3-triage-flows.apg.json wont-start
node packages/cli/dist/main.js validate ../templates/l2-intake-form.apg.json

# MCP server (Claude Desktop / MCP Inspector; stdio)
node packages/mcp-server/dist/main.js --graph ../templates/l4-support-bot-handoff.apg.json

# Python
cd python && uv sync && uv run pytest packages/apg-core/tests -q
```

Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "apg": {
      "command": "node",
      "args": [
        "/absolute/path/to/typescript/packages/mcp-server/dist/main.js",
        "--graph", "/absolute/path/to/templates/l4-support-bot-handoff.apg.json"
      ]
    }
  }
}
```

**Routing drivers:** every demo runs offline on a deterministic lexical classifier. For real
routing, `apg route <graph> "<query>" --live` uses the Anthropic API via `@apgraph/connectors`
(`ANTHROPIC_API_KEY` required), or call `registerBuiltins()` so templates' declared
`connectors` blocks (`anthropic`, `voyage`, `openai`, `file`, `memory`, `webhook`, `lexical`)
bind via `bindConnectors(doc)`. Embedding pre-filtering uses Voyage or OpenAI vectors with
stored `node.embedding` preferred (`precomputeEmbeddings` fills them at write time). Not yet
shipped: the `mcp-client` tools driver.

```ts
import { loadGraph, route, compose } from "@apgraph/core";

const graph = loadGraph("templates/l0-prompt-switcher.apg.json");
const routing = await route("plan a trip", graph, { connectors: { llm: myClassifier } });
const prompt = compose(graph, routing.matches.map(m => m.nodeId), { query: "plan a trip" });
// prompt.text → the compiled context; prompt.slots → structured form
```

```python
from apg_core import load_graph, route, compose

graph = load_graph("templates/l0-prompt-switcher.apg.json")
routing = route("plan a trip", graph, {"llm": my_classifier})
prompt = compose(graph, [m["nodeId"] for m in routing["matches"]], {"query": "plan a trip"})
# prompt["text"] → the compiled context; prompt["slots"] → structured form
```

Runnable end-to-end demos live in `examples/` (deterministic session walking in Node, route +
compose in Python — no API keys needed).

## Capability profiles

| Profile | Name | Adds | Template |
|---|---|---|---|
| L0 | Prompt switcher | routing over category nodes, string prompts, path composition | `templates/l0-prompt-switcher.apg.json` |
| L1 | Personalization | slotted prompts, `bring[]`, non-routable knowledge nodes, variables | `l1-personalization` |
| L1 | Adaptive routing vocabulary | `props` bags + graph-declared routing descriptors (route a FAQ by its questions) | `l1-faq-props` |
| L2 | Elicitation & intake | `collect`, fill policies, guards, visit policies, output schemas | `l2-intake-form` |
| L3 | Flows & actions | decision/action/answer nodes, deterministic session walking, tool allowlists | `l3-triage-flows` |
| L4 | Oversight & handoff | escalation policies, queues, collect-before-handoff, resume | `l4-support-bot-handoff` |
| L5 | Self-mutation | `apg_*` mutation ops behind changesets, layers, gap clustering | `l5-self-mutating` |

Each tier is a strict superset; the kernel implements all six, hosts opt in per deployment. The
validator rejects a graph whose declared profile is below the features it uses.

## The three edge families

*Taxonomy edges* say where a query belongs (`parentId`); *bring edges* say what an answer needs
(`bring[]`, resolved BFS, cycle-safe, tenant-checked); *flow edges* say what happens next
(decision choices, action branches, fallbacks — walked deterministically, zero LLM calls).

Composition is three stages at three ownerships, in strict priority order: **path** (the author's
intent) → **brings** (the graph's shared knowledge, contextOnly) → **overlays** (this user's
feedback history). See `docs/spec/determinism.md` for every pinned contract (outline bytes,
tie-breaking, variable precedence, budget truncation, patch semantics).

The request path over these edges is the kernel cycle **route → resolve → compose → walk →
effects** — see [`docs/architecture.md`](docs/architecture.md#the-kernel-request-path--route--resolve--compose--walk--effects)
for the verb-to-function table, a sequence diagram, and two worked chat traces.

## Mutation: changesets and layers

One op algebra (`MutationOp`) underlies every change: human edits, agent tools, changesets, and
per-scope layers. Base/tenant scope runs the full pipeline (draft → validate → routing regression
→ human approval → atomic commit); layers are permanently-open changesets applied at load
(`base ⊕ tenant ⊕ user`), where failed ops are **dropped and flagged, never guessed**.

## Status

Kernel (both languages), schema, conformance suite (64 fixtures), templates, connector drivers,
MCP facade (routing + session walking), and CLI are implemented. Deliberately deferred (design
hooks held open): DAG multi-parent composition, cross-server federation, learned routers,
streaming composition, template i18n — see the design doc's deferred-changes register. Audited
limitations of the learning/feedback tier are tracked in
[`docs/known-concerns.md`](docs/known-concerns.md); the library evolution queue lives in
[`docs/library-roadmap.md`](docs/library-roadmap.md), and graphs that learn follow
[`docs/spec/learning-conventions.md`](docs/spec/learning-conventions.md).

**License:** none yet — this repository is private and all packages are marked
`private`/`UNLICENSED`; flip the manifest fields before any publish.

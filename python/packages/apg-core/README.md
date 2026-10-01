# apg-core

The Python runtime for the Adaptive Prompt Graph (APG) kernel. It loads `*.apg.json` documents into a canonical, materialized graph and provides the full deterministic kernel: normalization, structural/semantic validation, the byte-stable router outline, the sandboxed expression language, hybrid routing, bring expansion, three-stage prompt composition with token budgeting, zero-LLM session stepping, and transactional graph mutation (changesets and per-scope layers). The kernel is stdlib-only: everything operates on plain dicts and lists exactly as parsed from JSON, and connectors (LLM, embeddings, tools, handoff) are plugged in as plain objects.

This package is one half of the "two runtimes, one schema" contract. The TypeScript kernel (`typescript/packages/core`) is the reference implementation; both runtimes run the identical conformance fixtures in `schema/conformance/fixtures`, which are the normative behavior spec. A fixture that passes in one runtime and fails in the other blocks both — behavior changes land as fixture changes first. The only intentional divergence is mechanical: the TS connector methods are `async`, while the Python kernel's `route` and `session_step` are plain synchronous functions with identical semantics (the kernel is deterministic, so there is nothing to await).

```python
from apg_core import load_graph, route, compose, ScriptedLlm

graph = load_graph("templates/l1-personalization.apg.json")
llm = ScriptedLlm({"classify": [
    {"matches": [{"nodeId": "returns", "confidence": 0.9, "reason": "return request"}]},
]})
result = route("I want to return my order", graph, {"llm": llm})
prompt = compose(graph, [m["nodeId"] for m in result["matches"]],
                 {"query": "I want to return my order", "vars": {"brandName": "Acme"}})
print(prompt["text"])
```

Run the suite from `python/` with `uv sync && uv run pytest packages/apg-core/tests -q`.

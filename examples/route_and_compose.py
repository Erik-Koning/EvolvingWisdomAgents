"""End-to-end Python demo: route a query through the L4 support graph and
compose the final prompt — using a tiny deterministic keyword classifier in
place of a real LLM connector (no API keys needed).

Run from the repo root:
    cd python && uv run python ../examples/route_and_compose.py
"""
import json
import os
import re

from apg_core import compose, load_graph, route


class KeywordLlm:
    """Deterministic stand-in for an LLM classifier: token overlap between the
    query and each outline line, on the same saturating scale as the TS demo
    classifier. Swap for a real connector in production."""

    def classify(self, query: str, outline: str, schema: dict, multi: bool, hints: dict | None = None) -> list[dict]:
        query_tokens = _tokens(query)
        matches = []
        for line in outline.split("\n"):
            m = re.match(r"^\s*([^:]+): (.*)$", line)
            if m is None:
                continue
            overlap = len([t for t in query_tokens if t in _tokens(m.group(2))])
            if overlap:
                matches.append({
                    "nodeId": m.group(1).strip(),
                    "confidence": min(1.0, 0.4 + 0.2 * overlap),
                    "reason": f"keyword overlap: {overlap}",
                })
        return matches


def _tokens(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9à-ÿ]+", s.lower()) if len(t) > 2]


graph = load_graph(os.path.join(os.path.dirname(__file__), "..", "templates", "l4-support-bot-handoff.apg.json"))

query = "my battery is swelling and feels hot"
routing = route(query, graph, {"llm": KeywordLlm()})
prompt = compose(graph, [m["nodeId"] for m in routing["matches"]], {"query": query})

print("query:   ", query)
print("matched: ", [(m["nodeId"], round(m["confidence"], 2)) for m in routing["matches"]])
print("brought: ", routing["broughtNodes"])
print("\n--- composed prompt ---\n")
print(prompt["text"])
print("\n--- slots ---\n")
print(json.dumps({k: v[:80] + "…" if len(v) > 80 else v for k, v in prompt["slots"].items()}, indent=2))

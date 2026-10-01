"""Routing-regression harness — the evolution brake system. Mirrors
core/src/regress.ts: labeled queries evaluate sequentially in input order;
pass = expected within top-K gated matches; fallback never passes; failures
won by focus nodes are traffic-steal."""
from typing import Any

from .graph import Graph
from .router import route


def eval_routing(
    graph: Graph,
    labeled: list[dict],
    connectors: dict,
    top_k: int = 1,
    focus_nodes: list[str] | None = None,
    session_vars: dict | None = None,
) -> dict:
    focus = set(focus_nodes or [])
    report: dict[str, Any] = {"total": len(labeled), "passed": 0, "passRate": 1, "failed": [], "stolen": []}

    for item in labeled:
        query, expected = item["query"], item["expected"]
        routing = route(query, graph, connectors, session_vars=session_vars)
        # a query that fell back has lost its home — never a pass
        matches = [] if routing["fallbackUsed"] else routing["matches"]
        if any(m["nodeId"] == expected for m in matches[:top_k]):
            report["passed"] += 1
            continue
        got = matches[0]["nodeId"] if matches else None
        entry: dict[str, Any] = {"query": query, "expected": expected, "got": got}
        if matches and "confidence" in matches[0]:
            entry["confidence"] = matches[0]["confidence"]
        report["failed"].append(entry)
        if got is not None and got in focus:
            report["stolen"].append({"query": query, "expected": expected, "stolenBy": got})

    report["passRate"] = 1 if report["total"] == 0 else report["passed"] / report["total"]
    return report


def assert_regression(report: dict, min_pass_rate: float = 1) -> None:
    """The lifecycle gate: raise a summarized error when the graph regressed."""
    if report["passRate"] >= min_pass_rate:
        return
    examples = "; ".join(
        f'"{f["query"]}" expected {f["expected"]}, got {f["got"] if f["got"] is not None else "fallback"}'
        for f in report["failed"][:3]
    )
    steal = f" ({len(report['stolen'])} stolen by changed nodes)" if report["stolen"] else ""
    raise ValueError(
        f"Routing regression failed: {report['passed']}/{report['total']} passed{steal} — {examples}"
    )


def labeled_from_meta(graph: Graph) -> list[dict]:
    """The portable labeled set carried in graph meta (learning convention)."""
    raw = (graph.doc.get("meta") or {}).get("regression")
    if not isinstance(raw, list):
        return []
    return [
        e for e in raw
        if isinstance(e, dict) and isinstance(e.get("query"), str) and isinstance(e.get("expected"), str)
    ]

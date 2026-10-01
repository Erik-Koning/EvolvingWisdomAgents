"""The changeset lifecycle — the L5 governance pipeline as pure functions.
Mirrors core/src/lifecycle.ts: draft → validated → approved → committed |
discarded; commit only from approved (or validated with auto_approve)."""
from typing import Any

from .graph import Graph
from .mutation import apply_changeset
from .regress import eval_routing
from .validator import validate_graph


def _transition(cs: dict, verb: str, allowed: list[str]) -> None:
    if cs["status"] not in allowed:
        raise ValueError(f'Cannot {verb} changeset in status "{cs["status"]}"')


def add_ops(cs: dict, ops: list[dict]) -> dict:
    _transition(cs, "add ops to", ["draft"])
    return {**cs, "ops": [*cs["ops"], *ops]}


def changeset_focus_nodes(cs: dict) -> list[str]:
    """Node ids the ops create or modify (default traffic-steal focus)."""
    focus: dict[str, None] = {}
    for op in cs["ops"]:
        kind = op["op"]
        if kind == "addNode":
            focus[op["node"]["id"]] = None
        elif kind == "graftSubtree":
            for n in op["nodes"]:
                focus[n["id"]] = None
        elif kind in ("updateNode", "moveNode", "setBring"):
            focus[op["id"]] = None
        elif kind == "mergeNodes":
            focus[op["intoId"]] = None
        elif kind == "splitNode":
            for p in op["partitions"]:
                focus[p["node"]["id"]] = None
    return list(focus)


def validate_changeset(
    doc: dict,
    cs: dict,
    labeled: list[dict] | None = None,
    connectors: dict | None = None,
    top_k: int = 1,
    min_pass_rate: float = 1,
    focus_nodes: list[str] | None = None,
) -> dict:
    _transition(cs, "validate", ["draft", "validated"])
    result_doc: dict | None = None
    try:
        result_doc = apply_changeset(doc, cs["ops"])
        validation: dict[str, Any] = {"valid": True, "errors": [], "warnings": []}
    except ValueError as err:
        validation = {
            "valid": False,
            "errors": [{"code": "CHANGESET_APPLY_FAILED", "message": str(err)}],
            "warnings": [],
        }
    if result_doc is not None:
        validation = validate_graph(result_doc)

    regression: dict | None = None
    regression_passed = True
    if result_doc is not None and labeled:
        if connectors is None:
            raise ValueError("validate_changeset regression requires connectors")
        regression = eval_routing(
            Graph(result_doc),
            labeled,
            connectors,
            top_k=top_k,
            focus_nodes=focus_nodes if focus_nodes is not None else changeset_focus_nodes(cs),
        )
        regression_passed = regression["passRate"] >= min_pass_rate

    out = {**cs, "validation": validation}
    if regression is not None:
        out["regression"] = regression
    out["status"] = "validated" if validation["valid"] and regression_passed else "draft"
    return out


def approve_changeset(cs: dict) -> dict:
    _transition(cs, "approve", ["validated"])
    return {**cs, "status": "approved"}


def commit_changeset(doc: dict, cs: dict, auto_approve: bool = False) -> dict:
    _transition(cs, "commit", ["approved", "validated"] if auto_approve else ["approved"])
    next_doc = apply_changeset(doc, cs["ops"])
    return {"doc": next_doc, "changeset": {**cs, "status": "committed"}}


def discard_changeset(cs: dict) -> dict:
    _transition(cs, "discard", ["draft", "validated", "approved"])
    return {**cs, "status": "discarded"}

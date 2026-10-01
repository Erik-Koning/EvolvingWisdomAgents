# Cross-language conformance runner. The identical fixtures run against the
# TypeScript runtime (typescript/packages/core/tests/conformance.test.ts); a
# fixture passing in one runtime and failing in the other blocks both.
import json
from pathlib import Path
from typing import Any

import pytest

from apg_core import (
    Graph,
    MapEmbeddings,
    ScriptedLlm,
    ScriptedTools,
    apply_changeset,
    apply_evidence_gate,
    compose,
    eval_expr,
    eval_routing,
    materialize_layers,
    new_session,
    normalize_document,
    resolve_bring,
    route,
    serialize_outline,
    session_step,
    validate_graph,
)

FIXTURES_DIR = Path(__file__).resolve().parents[4] / "schema" / "conformance" / "fixtures"
FIXTURE_FILES = sorted(f.name for f in FIXTURES_DIR.glob("*.json"))

_MISSING = object()


def _scalar_eq(actual: Any, expected: Any) -> bool:
    """JS strict-equality flavor: booleans never equal numbers; 3 == 3.0."""
    if isinstance(actual, bool) != isinstance(expected, bool):
        return False
    return actual == expected


def subset_match(actual: Any, expected: Any, path: str) -> list[str]:
    """Recursive subset match: objects match on present keys; arrays match
    exactly; an explicit null in expected asserts null-or-absent."""
    if expected is None:
        if actual is None or actual is _MISSING:
            return []
        return [f"{path}: expected null/absent, got {json.dumps(actual)}"]
    if actual is _MISSING:
        return [f"{path}: expected {json.dumps(expected)}, got <absent>"]
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return [f"{path}: expected array, got {type(actual).__name__}"]
        if len(actual) != len(expected):
            return [f"{path}: expected length {len(expected)}, got {len(actual)} — actual: {json.dumps(actual)}"]
        out: list[str] = []
        for i, e in enumerate(expected):
            out.extend(subset_match(actual[i], e, f"{path}[{i}]"))
        return out
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path}: expected object, got {json.dumps(actual)}"]
        out = []
        for k, v in expected.items():
            out.extend(subset_match(actual.get(k, _MISSING), v, f"{path}.{k}"))
        return out
    if not _scalar_eq(actual, expected):
        return [f"{path}: expected {json.dumps(expected)}, got {json.dumps(actual)}"]
    return []


def connectors_for(fixture: dict) -> dict:
    connectors: dict = {}
    m = fixture.get("mocks") or {}
    # Presence (not truthiness) binds the llm connector: an EMPTY classify
    # queue is a deliberate fixture device proving classify is never called
    # (matches the TS runner, where [] is truthy).
    if m.get("classify") is not None or m.get("extract") is not None:
        script: dict = {}
        if m.get("classify") is not None:
            script["classify"] = m["classify"]
        if m.get("extract") is not None:
            script["extract"] = m["extract"]
        connectors["llm"] = ScriptedLlm(script)
    if m.get("embeddings"):
        connectors["embeddings"] = MapEmbeddings(m["embeddings"])
    if m.get("tools"):
        connectors["tools"] = ScriptedTools(m["tools"])
    return connectors


def run_op(fixture: dict) -> Any:
    op = fixture["op"]
    raw_graph = fixture.get("graph")

    def graph() -> Graph:
        return Graph(normalize_document(raw_graph))

    kind = op["kind"]
    if kind == "normalize":
        return {"graph": normalize_document(raw_graph)}
    if kind == "validate":
        report = validate_graph(normalize_document(raw_graph))
        return {"valid": report["valid"], "errors": report["errors"], "warnings": report["warnings"]}
    if kind == "serializeOutline":
        return {"outline": serialize_outline(graph(), op.get("nodeIds"))}
    if kind == "evalExpr":
        return {"value": eval_expr(op["expr"], op.get("vars") or {})}
    if kind == "route":
        return route(op["query"], graph(), connectors_for(fixture), session_vars=op.get("sessionVars"))
    if kind == "evalRouting":
        return eval_routing(
            graph(),
            op["labeled"],
            connectors_for(fixture),
            top_k=op.get("topK") or 1,
            focus_nodes=op.get("focusNodes"),
        )
    if kind == "resolveBring":
        r = resolve_bring(graph(), op["nodeId"])
        return {"brought": r["brought"], "dangling": r["dangling"], "tenantBlocked": r["tenantBlocked"]}
    if kind == "compose":
        targets = op.get("nodeIds") or [op["nodeId"]]
        return compose(
            graph(),
            targets,
            {
                "query": op.get("query"),
                "vars": fixture.get("vars"),
                "sessionVars": op.get("sessionVars"),
                "memoryVars": op.get("memoryVars"),
                "tenantVars": op.get("tenantVars"),
                "overlays": fixture.get("userOverlays"),
                "maxPromptTokens": op.get("maxPromptTokens"),
            },
        )
    if kind == "routeAndCompose":
        g = graph()
        routing = route(op["query"], g, connectors_for(fixture))
        prompt = compose(
            g,
            [m["nodeId"] for m in routing["matches"]],
            {"query": op["query"], "vars": fixture.get("vars"), "overlays": fixture.get("userOverlays")},
        )
        return {"routing": routing, "prompt": prompt}
    if kind == "sessionStep":
        session = fixture.get("session") or new_session("s")
        return session_step(graph(), session, op["input"], connectors_for(fixture))
    if kind == "applyChangeset":
        return {"graph": apply_changeset(normalize_document(raw_graph), op["ops"])}
    if kind == "evidenceGate":
        return apply_evidence_gate(
            normalize_document(raw_graph),
            op["ops"],
            op.get("evidence"),
            op.get("transcripts"),
        )
    if kind == "materializeLayers":
        r = materialize_layers(normalize_document(raw_graph), op["layers"])
        return {"graph": r["doc"], "conflicts": r["conflicts"]}
    raise ValueError(f"Unknown fixture op kind: {kind}")


@pytest.mark.parametrize("file", FIXTURE_FILES)
def test_conformance(file: str) -> None:
    fixture = json.loads((FIXTURES_DIR / file).read_text(encoding="utf-8"))

    if fixture.get("expectError") is not None:
        with pytest.raises(Exception) as excinfo:
            run_op(fixture)
        assert fixture["expectError"] in str(excinfo.value), (
            f"expected error containing {fixture['expectError']!r}, got: {excinfo.value}"
        )
        return

    actual = run_op(fixture)
    expected = fixture.get("expected")

    # validate errors match as a set keyed by (code, nodeId)
    if fixture["op"]["kind"] == "validate":
        if "valid" in expected:
            assert actual["valid"] == expected["valid"]
        if "errors" in expected:
            key = lambda e: f"{e['code']}::{e.get('nodeId', '')}"  # noqa: E731
            assert {key(e) for e in actual["errors"]} == {key(e) for e in expected["errors"]}
        return

    mismatches = subset_match(actual, expected, "$")
    assert not mismatches, "Fixture mismatch:\n" + "\n".join(mismatches)

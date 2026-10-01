# Mirrors typescript/packages/core/tests/lifecycle.test.ts.
import pytest

from apg_core import (
    Graph,
    ScriptedLlm,
    add_ops,
    approve_changeset,
    commit_changeset,
    create_changeset,
    discard_changeset,
    normalize_document,
    validate_changeset,
)


def _doc() -> dict:
    return normalize_document(
        {
            "schemaVersion": "1.0",
            "graphId": "lc",
            "version": "1",
            "profile": "L0",
            "nodes": [
                {"id": "root", "parentId": None, "type": "category", "title": "R", "description": "r"},
                {"id": "a", "parentId": "root", "type": "category", "title": "A", "description": "aa"},
            ],
        }
    )


ADD_B = [
    {
        "op": "addNode",
        "parentId": "root",
        "node": {"id": "b", "parentId": "root", "type": "category", "title": "B", "description": "bb"},
    }
]


def test_walks_draft_to_validated_to_approved_to_committed() -> None:
    base = _doc()
    cs = create_changeset(base, "tester", "cs-1")
    cs = add_ops(cs, ADD_B)
    cs = validate_changeset(base, cs)
    assert cs["status"] == "validated"
    assert cs["validation"]["valid"] is True
    cs = approve_changeset(cs)
    result = commit_changeset(base, cs)
    assert result["changeset"]["status"] == "committed"
    assert Graph(result["doc"]).has("b") is True


def test_enforces_strict_transitions() -> None:
    base = _doc()
    cs = create_changeset(base, "tester", "cs-2")
    cs = add_ops(cs, ADD_B)
    with pytest.raises(ValueError, match='Cannot commit changeset in status "draft"'):
        commit_changeset(base, cs)
    with pytest.raises(ValueError, match='Cannot approve changeset in status "draft"'):
        approve_changeset(cs)
    validated = validate_changeset(base, cs)
    with pytest.raises(ValueError, match='Cannot add ops to changeset in status "validated"'):
        add_ops(validated, ADD_B)


def test_failing_apply_keeps_the_draft_and_records_the_failure() -> None:
    base = _doc()
    cs = create_changeset(base, "tester", "cs-3")
    cs = add_ops(cs, [{"op": "updateNode", "id": "ghost", "patch": {"title": "X"}}])
    cs = validate_changeset(base, cs)
    assert cs["status"] == "draft"
    assert cs["validation"]["valid"] is False
    assert cs["validation"]["errors"][0]["code"] == "CHANGESET_APPLY_FAILED"


def test_regression_gate_blocks_validation_and_reports_traffic_steal() -> None:
    base = _doc()
    cs = create_changeset(base, "tester", "cs-4")
    cs = add_ops(cs, ADD_B)
    labeled = [{"query": "belongs to a", "expected": "a"}]
    # the new node b steals the labeled query → stays draft
    stolen = validate_changeset(
        base,
        cs,
        labeled=labeled,
        connectors={"llm": ScriptedLlm({"classify": [{"matches": [{"nodeId": "b", "confidence": 0.9}]}]})},
    )
    assert stolen["status"] == "draft"
    assert len(stolen["regression"]["stolen"]) == 1
    # routing stays home → validated
    ok = validate_changeset(
        base,
        cs,
        labeled=labeled,
        connectors={"llm": ScriptedLlm({"classify": [{"matches": [{"nodeId": "a", "confidence": 0.9}]}]})},
    )
    assert ok["status"] == "validated"


def test_auto_approve_commits_straight_from_validated_and_discard_from_approved() -> None:
    base = _doc()
    cs = create_changeset(base, "tester", "cs-5")
    cs = add_ops(cs, ADD_B)
    cs = validate_changeset(base, cs)
    result = commit_changeset(base, cs, auto_approve=True)
    assert result["changeset"]["status"] == "committed"

    cs2 = create_changeset(base, "tester", "cs-6")
    cs2 = add_ops(cs2, ADD_B)
    cs2 = approve_changeset(validate_changeset(base, cs2))
    assert discard_changeset(cs2)["status"] == "discarded"

# Edge cases beyond fixture 64 (which pins the cross-language contract):
# per-reason citation failures, conditional degrade classification for
# setBring/updateNode, and the new Memory stores. Mirrors
# typescript/packages/core/tests/replay-gate.test.ts.
from apg_core import (
    MemoryAgentStateStore,
    MemoryTranscriptStore,
    apply_evidence_gate,
    is_degrading_op,
    normalize_document,
    verify_citation,
)


def doc() -> dict:
    return normalize_document(
        {
            "schemaVersion": "1.0",
            "graphId": "g",
            "profile": "L1",
            "nodes": [
                {"id": "root", "parentId": None, "title": "R", "description": "r"},
                {
                    "id": "cat",
                    "parentId": "root",
                    "title": "C",
                    "description": "c",
                    "bring": ["kn-a", "kn-b"],
                },
                {
                    "id": "kn-a",
                    "parentId": "cat",
                    "routable": False,
                    "title": "A",
                    "description": "a",
                    "prompt": {"slots": {"knowledge": "prefers detailed weekly reports"}},
                },
                {"id": "kn-b", "parentId": "cat", "routable": False, "title": "B", "description": "b"},
            ],
        }
    )


def transcript(role: str, content: str) -> dict:
    return {"id": "t1", "turns": [{"role": role, "content": content}]}


# ---- degrade classification ----


def test_set_bring_shrinking_is_degrading_superset_reorder_is_additive() -> None:
    d = doc()
    assert is_degrading_op(d, {"op": "setBring", "id": "cat", "bring": ["kn-a"]}) is True
    assert is_degrading_op(d, {"op": "setBring", "id": "cat", "bring": ["kn-b", "kn-a", "kn-x"]}) is False


def test_update_node_null_delete_or_shorter_slot_degrading_growth_and_props_additive() -> None:
    d = doc()
    assert (
        is_degrading_op(d, {"op": "updateNode", "id": "kn-a", "patch": {"prompt": {"slots": {"knowledge": None}}}})
        is True
    )
    assert (
        is_degrading_op(d, {"op": "updateNode", "id": "kn-a", "patch": {"prompt": {"slots": {"knowledge": "brief"}}}})
        is True
    )
    assert (
        is_degrading_op(
            d,
            {
                "op": "updateNode",
                "id": "kn-a",
                "patch": {"prompt": {"slots": {"knowledge": "prefers detailed weekly reports with NPV and churn metrics"}}},
            },
        )
        is False
    )
    assert is_degrading_op(d, {"op": "updateNode", "id": "kn-a", "patch": {"props": {"feedbackCount": 3}}}) is False


def test_move_add_are_additive_merge_prune_always_degrade() -> None:
    d = doc()
    assert is_degrading_op(d, {"op": "moveNode", "id": "kn-a", "newParentId": "root"}) is False
    assert is_degrading_op(d, {"op": "mergeNodes", "ids": ["kn-b"], "intoId": "kn-a"}) is True
    assert is_degrading_op(d, {"op": "pruneSubtree", "id": "cat"}) is True


# ---- citation verification ----

EV = {"opIndex": 0, "quote": "I sold the kayak", "transcriptId": "t1", "turnIndex": 0}


def test_reports_the_most_specific_failure_per_citation() -> None:
    assert verify_citation(EV, []) == "transcript-not-found"
    assert verify_citation({**EV, "turnIndex": 5}, [transcript("user", "I sold the kayak")]) == "turn-out-of-range"
    assert verify_citation(EV, [transcript("assistant", "I sold the kayak")]) == "not-user-turn"
    assert verify_citation(EV, [transcript("user", "kayaks are great")]) == "quote-not-found"
    assert verify_citation(EV, [transcript("user", "well, I sold \n  the kayak today")]) is None


# ---- apply_evidence_gate ----


def test_reindexes_kept_evidence_and_reports_dropped_reasons() -> None:
    ops = [
        {"op": "deleteNode", "id": "kn-a", "orphans": "cascade"},
        {
            "op": "addNode",
            "parentId": "cat",
            "node": {"id": "kn-c", "parentId": "cat", "title": "C2", "description": "x"},
        },
        {"op": "deleteNode", "id": "kn-b", "orphans": "cascade"},
    ]
    result = apply_evidence_gate(
        doc(),
        ops,
        [
            {"opIndex": 0, "quote": "not actually said", "transcriptId": "t1", "turnIndex": 0},
            {"opIndex": 2, "quote": "drop rule b", "transcriptId": "t1", "turnIndex": 0},
        ],
        [transcript("user", "please drop rule b, it is stale")],
    )
    assert [o["op"] for o in result["kept"]] == ["addNode", "deleteNode"]
    assert result["evidence"] == [{"opIndex": 1, "quote": "drop rule b", "transcriptId": "t1", "turnIndex": 0}]
    assert len(result["dropped"]) == 1
    assert result["dropped"][0]["opIndex"] == 0
    assert result["dropped"][0]["reason"] == "quote-not-found"


# ---- memory stores ----


def test_memory_transcript_store_append_turns_creates_on_first_append_and_accumulates() -> None:
    store = MemoryTranscriptStore()
    store.append_turns("t1", [{"role": "user", "content": "hi"}])
    t = store.append_turns("t1", [{"role": "assistant", "content": "hello"}])
    assert len(t["turns"]) == 2
    assert store.get("t1")["turns"][1]["role"] == "assistant"
    assert store.get("missing") is None


def test_memory_transcript_store_list_filters_by_graph_id() -> None:
    store = MemoryTranscriptStore()
    store.put({"id": "a", "graphId": "g1", "turns": []})
    store.put({"id": "b", "graphId": "g2", "turns": []})
    assert [t["id"] for t in store.list("g1")] == ["a"]
    assert len(store.list()) == 2


def test_memory_agent_state_store_round_trips_state_by_agent() -> None:
    store = MemoryAgentStateStore()
    assert store.get_state("sage") is None
    store.put_state("sage", {"lastSleepAt": 5, "pressure": []})
    assert store.get_state("sage") == {"lastSleepAt": 5, "pressure": []}

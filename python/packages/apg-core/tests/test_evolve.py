# Mirrors typescript/packages/core/tests/evolve.test.ts.
import pytest

from apg_core import (
    Graph,
    apply_changeset,
    build_split_ops,
    cluster_by_similarity,
    cosine_similarity,
    medoid,
    normalize_document,
    validate_graph,
)

# ---- evolve math ----


def test_cosine_similarity_on_known_vectors() -> None:
    assert cosine_similarity([1, 0], [1, 0]) == 1
    assert cosine_similarity([1, 0], [0, 1]) == 0
    assert cosine_similarity([1, 0], [0, 0]) == 0


def test_greedy_single_link_clustering_is_input_order_deterministic_and_drops_noise() -> None:
    vectors = [
        [1, 0],
        [0.95, 0.05],
        [0, 1],
        [0.05, 0.95],
        [0.7, 0.7],
    ]
    # hand-derived: sim(v4, v0) = 0.7/0.98995 ≈ 0.707 — at threshold 0.7 the
    # diagonal vector links to BOTH clusters; greedy joins the FIRST (v0's)
    assert cluster_by_similarity(vectors, 0.7, min_size=2) == [[0, 1, 4], [2, 3]]
    # at 0.9 the diagonal is a singleton and gets dropped as noise
    assert cluster_by_similarity(vectors, 0.9, min_size=2) == [[0, 1], [2, 3]]


def test_medoid_breaks_ties_toward_the_lowest_index() -> None:
    vectors = [
        [1, 0],
        [1, 0],
        [0, 1],
    ]
    assert medoid(vectors, [0, 1]) == 0


# ---- buildSplitOps ----


def _doc() -> dict:
    return normalize_document(
        {
            "schemaVersion": "1.0",
            "graphId": "grow",
            "profile": "L1",
            "nodes": [
                {"id": "root", "parentId": None, "type": "category", "title": "R", "description": "r"},
                {
                    "id": "cat",
                    "parentId": "root",
                    "type": "category",
                    "title": "Cat",
                    "description": "c",
                    "bring": ["a", "b", "c", "d"],
                },
                *[
                    {
                        "id": id,
                        "parentId": "cat",
                        "type": "category",
                        "routable": False,
                        "prompt": {"slots": {"knowledge": f"Fact {id}."}},
                    }
                    for id in ["a", "b", "c", "d"]
                ],
            ],
        }
    )


def test_adds_subcategories_moves_taken_learnings_and_emits_authoritative_brings() -> None:
    base = _doc()
    graph = Graph(base)
    ops = build_split_ops(
        graph,
        "cat",
        [
            {
                "newCategory": {"id": "cat-x", "parentId": "cat", "type": "category", "title": "X", "description": "x"},
                "take": ["a", "b"],
            },
            {
                "newCategory": {"id": "cat-y", "parentId": "cat", "type": "category", "title": "Y", "description": "y"},
                "take": ["c"],
            },
        ],
    )
    assert [o["op"] for o in ops] == [
        "addNode", "moveNode", "moveNode", "setBring",
        "addNode", "moveNode", "setBring",
        "setBring",
    ]
    next_doc = apply_changeset(base, ops)
    g = Graph(next_doc)
    assert g.get("a")["parentId"] == "cat-x"
    assert g.get("cat-x")["bring"] == ["a", "b"]
    assert g.get("cat-y")["bring"] == ["c"]
    assert g.get("cat")["bring"] == ["d"]
    assert validate_graph(next_doc)["valid"] is True


def test_rejects_duplicate_ids_and_filters_overlapping_takes() -> None:
    base = _doc()
    graph = Graph(base)
    with pytest.raises(ValueError, match="node id already exists: cat"):
        build_split_ops(
            graph,
            "cat",
            [
                {
                    "newCategory": {"id": "cat", "parentId": "cat", "type": "category", "title": "dup", "description": "d"},
                    "take": ["a"],
                }
            ],
        )
    ops = build_split_ops(
        graph,
        "cat",
        [
            {
                "newCategory": {"id": "x1", "parentId": "cat", "type": "category", "title": "X1", "description": "1"},
                "take": ["a", "b"],
            },
            {
                "newCategory": {"id": "x2", "parentId": "cat", "type": "category", "title": "X2", "description": "2"},
                "take": ["b", "c"],
            },
        ],
    )
    x2_bring = next(o for o in ops if o["op"] == "setBring" and o["id"] == "x2")
    assert x2_bring["bring"] == ["c"]  # b already taken by x1

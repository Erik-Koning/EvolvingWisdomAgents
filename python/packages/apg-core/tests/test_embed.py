import pytest

from apg_core import Graph, MapEmbeddings, normalize_document, precompute_embeddings


def _doc() -> dict:
    return normalize_document(
        {
            "schemaVersion": "1.0",
            "graphId": "e",
            "profile": "L1",
            "nodes": [
                {"id": "root", "parentId": None, "type": "category", "title": "R", "description": "r", "routable": False},
                {"id": "a", "parentId": "root", "type": "category", "title": "A", "description": "aa"},
                {"id": "b", "parentId": "root", "type": "category", "title": "B", "description": "bb", "embedding": [9, 9]},
                {"id": "k", "parentId": "root", "type": "category", "title": "K", "description": "kk", "routable": False},
            ],
        }
    )


class ExplodingEmbeddings:
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise AssertionError("must not be called")


def test_embeds_only_routable_missing() -> None:
    base = _doc()
    next_doc = precompute_embeddings(base, MapEmbeddings({"A — aa": [1, 0]}))
    graph = Graph(next_doc)
    assert graph.get("a")["embedding"] == [1, 0]
    assert graph.get("b")["embedding"] == [9, 9]
    assert "embedding" not in graph.get("k")
    assert "embedding" not in Graph(base).get("a")  # input not mutated


def test_noop_when_complete() -> None:
    complete = precompute_embeddings(_doc(), MapEmbeddings({"A — aa": [1, 0]}))
    assert precompute_embeddings(complete, ExplodingEmbeddings()) is complete


def test_force_reembeds() -> None:
    next_doc = precompute_embeddings(_doc(), MapEmbeddings({"A — aa": [1, 0], "B — bb": [0, 1]}), force=True)
    assert Graph(next_doc).get("b")["embedding"] == [0, 1]

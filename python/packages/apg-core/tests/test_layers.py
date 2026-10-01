# Mirrors typescript/packages/core/tests/layers.test.ts.
from apg_core import (
    MemoryLayerStore,
    apply_changeset,
    load_with_layers,
    normalize_document,
    rebase_layer,
)


def _base() -> dict:
    return normalize_document(
        {
            "schemaVersion": "1.0",
            "graphId": "layered",
            "version": "1",
            "profile": "L0",
            "nodes": [
                {"id": "root", "parentId": None, "type": "category", "title": "R", "description": "r"},
                {"id": "a", "parentId": "root", "type": "category", "title": "A", "description": "aa"},
            ],
        }
    )


def _layer(ops: list[dict]) -> dict:
    return {
        "layerId": "user:erik",
        "baseGraphId": "layered",
        "baseVersion": "1",
        "scope": "user",
        "ownerId": "erik",
        "version": "u1",
        "ops": ops,
    }


def test_memory_layer_store_crud_with_scope_filtering() -> None:
    store = MemoryLayerStore()
    store.put_layer(_layer([]))
    store.put_layer({**_layer([]), "layerId": "tenant:acme", "scope": "tenant", "ownerId": "acme"})
    assert len(store.list_layers("layered")) == 2
    assert [layer["layerId"] for layer in store.list_layers("layered", "user")] == ["user:erik"]
    assert store.get_layer("user:erik")["ownerId"] == "erik"
    store.delete_layer("user:erik")
    assert store.get_layer("user:erik") is None


def test_rebase_layer_drops_and_flags_ops_the_new_base_broke() -> None:
    moved = apply_changeset(_base(), [{"op": "deleteNode", "id": "a", "orphans": "cascade"}])
    rebased = rebase_layer(moved, _layer([{"op": "updateNode", "id": "a", "patch": {"title": "X"}}]))
    assert rebased["baseVersion"] == moved["version"]
    assert len(rebased["conflicts"]) == 1
    assert "Unknown node id: a" in rebased["conflicts"][0]["reason"]
    assert len(rebased["ops"]) == 1  # ops never rewritten, only flagged


def test_load_with_layers_materializes_base_plus_layers_into_indexed_graph() -> None:
    result = load_with_layers(
        _base(),
        [
            _layer(
                [
                    {
                        "op": "addNode",
                        "parentId": "root",
                        "node": {
                            "id": "mine",
                            "parentId": "root",
                            "type": "category",
                            "title": "Mine",
                            "description": "m",
                        },
                    }
                ]
            )
        ],
    )
    assert len(result["conflicts"]) == 0
    assert result["graph"].has("mine") is True

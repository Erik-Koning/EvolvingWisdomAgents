from apg_core import MemoryGraphStore, StoreConflictError

import pytest


def _doc(version: str) -> dict:
    return {
        "schemaVersion": "1.0",
        "graphId": "g",
        "version": version,
        "nodes": [{"id": "root", "parentId": None, "type": "category", "title": "R", "description": "r"}],
    }


def test_load_latest_is_most_recently_saved() -> None:
    store = MemoryGraphStore()
    store.save(_doc("2"))
    store.save(_doc("1"))
    assert store.load("g")["version"] == "1"
    store.save(_doc("2"))  # re-save existing key must move it to latest
    assert store.load("g")["version"] == "2"


def test_cas_expected_version() -> None:
    store = MemoryGraphStore()
    store.save(_doc("1"), expected_version=None)  # create-only on empty: ok
    with pytest.raises(StoreConflictError):
        store.save(_doc("2"), expected_version=None)
    with pytest.raises(StoreConflictError, match="expected 0, found 1"):
        store.save(_doc("2"), expected_version="0")
    store.save(_doc("2"), expected_version="1")
    assert store.load("g")["version"] == "2"
    store.save(_doc("3"))  # unconditional save still works


def test_load_by_version() -> None:
    store = MemoryGraphStore()
    store.save(_doc("1"))
    store.save(_doc("2"))
    assert store.load("g", "1")["version"] == "1"
    with pytest.raises(ValueError, match="unknown version"):
        store.load("g", "3")

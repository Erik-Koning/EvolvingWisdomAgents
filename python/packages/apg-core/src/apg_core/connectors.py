# Connector ("driver") implementations. The TS runtime's connector methods are
# async; the Python kernel is deterministic-only, so they are plain sync
# methods with identical semantics. Connectors are passed around as a plain
# dict: {"llm": ..., "embeddings": ..., "tools": ..., "handoff": ..., ...}.
import copy
import math
from typing import Any, Callable

from ._json import json_stringify

# ---- host registry ("driver missing" is a load error, per the OS analogy) ----

_registry: dict[str, Callable[[dict], Any]] = {}


def register_connector(name: str, factory: Callable[[dict], Any]) -> None:
    _registry[name] = factory


def bind_connectors(doc: dict) -> dict:
    bound: dict[str, Any] = {}
    for role, decl in (doc.get("connectors") or {}).items():
        if decl.get("use") == "none":
            continue
        factory = _registry.get(decl["use"])
        if factory is None:
            raise ValueError(f'Driver missing: no connector registered for "{decl["use"]}" (role "{role}")')
        bound[role] = factory(decl.get("config") or {})
    return bound


# ---- shipped in-memory/mock implementations ----


class ScriptedLlm:
    """Scripted classifier/extractor: consumes queued responses in order (fixtures)."""

    def __init__(self, script: dict | None = None) -> None:
        script = script or {}
        self._classify_queue: list[list[dict]] = [c["matches"] for c in script.get("classify") or []]
        self._extract_queue: list[dict] = [e["vars"] for e in script.get("extract") or []]

    def classify(self, **_kwargs: Any) -> list[dict]:
        if not self._classify_queue:
            raise RuntimeError("ScriptedLlm: classify queue exhausted")
        return self._classify_queue.pop(0)

    def extract(self, **_kwargs: Any) -> dict:
        if not self._extract_queue:
            raise RuntimeError("ScriptedLlm: extract queue exhausted")
        return self._extract_queue.pop(0)


class MapEmbeddings:
    """Exact-text → vector map. A missing text is a fixture bug and raises."""

    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors

    def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for t in texts:
            v = self._vectors.get(t)
            if not v:
                raise ValueError(f"MapEmbeddings: no vector for text: {json_stringify(t)}")
            out.append(v)
        return out


class ScriptedTools:
    """Scripted tools connector keyed by tool name."""

    def __init__(self, responses: dict[str, dict]) -> None:
        self._responses = responses

    def call(self, name: str, _args: dict | None = None) -> dict:
        r = self._responses.get(name)
        if not r:
            raise ValueError(f"ScriptedTools: no scripted response for tool: {name}")
        return r

    def list(self) -> list[dict]:
        return [{"name": name} for name in self._responses]


class MemorySessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, dict] = {}

    def get(self, id: str) -> dict | None:
        return self._sessions.get(id)

    def put(self, s: dict) -> None:
        self._sessions[s["sessionId"]] = s


class StoreConflictError(Exception):
    """CAS violation on save: the stored latest no longer matches expectations."""


class MemoryGraphStore:
    def __init__(self) -> None:
        self._docs: dict[str, dict[str, dict]] = {}

    def load(self, graph_id: str, version: str | None = None) -> dict:
        versions = self._docs.get(graph_id)
        if not versions:
            raise ValueError(f"MemoryGraphStore: unknown graph {graph_id}")
        if version is not None:
            doc = versions.get(version)
            if doc is None:
                raise ValueError(f"MemoryGraphStore: unknown version {version} of {graph_id}")
            return doc
        return list(versions.values())[-1]

    def save(self, doc: dict, expected_version: str | None = ...) -> None:  # type: ignore[assignment]
        # CAS: a string must equal the stored latest's version; None means the
        # graph must not exist yet (create-only); omitted (Ellipsis sentinel)
        # saves unconditionally. Violations raise StoreConflictError.
        if expected_version is not ...:
            versions_existing = self._docs.get(doc["graphId"])
            latest = list(versions_existing.values())[-1].get("version") if versions_existing else None
            if expected_version is None and latest is not None:
                raise StoreConflictError(f"graph {doc['graphId']} already exists (latest {latest})")
            if expected_version is not None and latest != expected_version:
                raise StoreConflictError(f"graph {doc['graphId']} moved: expected {expected_version}, found {latest}")
        versions = self._docs.setdefault(doc["graphId"], {})
        # delete-then-set so "latest" is always the most recently saved, even
        # when re-saving an existing version key (dict keeps first-insert order)
        versions.pop(doc.get("version") or "0", None)
        versions[doc.get("version") or "0"] = copy.deepcopy(doc)

    def list_versions(self, graph_id: str) -> list[str]:
        return list(self._docs.get(graph_id, {}).keys())


class MemoryChangesetStore:
    def __init__(self) -> None:
        self._items: dict[str, dict] = {}

    def put(self, cs: dict) -> None:
        self._items[cs["id"]] = copy.deepcopy(cs)

    def get(self, id: str) -> dict | None:
        cs = self._items.get(id)
        return copy.deepcopy(cs) if cs is not None else None

    def list(self, graph_id: str | None = None, status: str | None = None) -> list[dict]:
        del graph_id  # Changeset carries baseGraphVersion, not graphId — hosts filter via convention
        return [copy.deepcopy(c) for c in self._items.values() if status is None or c["status"] == status]


class MemoryLayerStore:
    def __init__(self) -> None:
        self._layers: dict[str, dict] = {}

    def put_layer(self, layer: dict) -> None:
        self._layers[layer["layerId"]] = copy.deepcopy(layer)

    def get_layer(self, layer_id: str) -> dict | None:
        layer = self._layers.get(layer_id)
        return copy.deepcopy(layer) if layer is not None else None

    def list_layers(self, graph_id: str, scope: str | None = None) -> list[dict]:
        return [
            copy.deepcopy(layer)
            for layer in self._layers.values()
            if layer["baseGraphId"] == graph_id and (scope is None or layer.get("scope") == scope)
        ]

    def delete_layer(self, layer_id: str) -> None:
        self._layers.pop(layer_id, None)


class MemoryTranscriptStore:
    def __init__(self) -> None:
        self._items: dict[str, dict] = {}

    def put(self, t: dict) -> None:
        self._items[t["id"]] = copy.deepcopy(t)

    def get(self, id: str) -> dict | None:
        t = self._items.get(id)
        return copy.deepcopy(t) if t is not None else None

    def list(self, graph_id: str | None = None) -> list[dict]:
        return [
            copy.deepcopy(t)
            for t in self._items.values()
            if graph_id is None or t.get("graphId") == graph_id
        ]

    def append_turns(self, id: str, turns: list[dict]) -> dict:
        """Appends turns, creating the transcript if missing. Returns the updated transcript."""
        existing = self._items.get(id)
        if existing is None:
            existing = {"id": id, "turns": []}
        existing["turns"] = [*existing["turns"], *(copy.deepcopy(t) for t in turns)]
        self._items[id] = existing
        return copy.deepcopy(existing)


class MemoryAgentStateStore:
    """Small KV home for maintenance state (pressure ledger, lastSleepAt,
    identityHash) — kept OUT of doc.meta so sleep stamps never churn graph
    versions or race user CAS writes."""

    def __init__(self) -> None:
        self._items: dict[str, dict] = {}

    def get_state(self, agent_id: str) -> dict | None:
        s = self._items.get(agent_id)
        return copy.deepcopy(s) if s is not None else None

    def put_state(self, agent_id: str, state: dict) -> None:
        self._items[agent_id] = copy.deepcopy(state)


def count_tokens_fallback(text: str) -> int:
    """Pinned token-count fallback: ceil(Unicode code points / 4)."""
    return math.ceil(len(text) / 4)

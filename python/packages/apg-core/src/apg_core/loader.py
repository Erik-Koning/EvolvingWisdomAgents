import copy
import json
import os
from typing import Any

from .graph import Graph


def normalize_document(raw: dict, base_path: str | None = None, _seen_includes: set[str] | None = None) -> dict:
    """Normalize a raw document into canonical form:
    - defaults materialized (type, routable, recursiveBring, bringMode,
      maxBringDepth, fillPolicy, visitPolicy, isFallback, profile)
    - string prompts desugared to { slots: { task } }
    - $include documents grafted (their roots must name a mount node here)
    - inline relations (bring / choice / fallback / child) materialized into
      edges[] alongside authored seeAlso/aliasOf edges
    - nodes re-serialized in DFS order (parent first, authored sibling order)
    """
    doc = copy.deepcopy(raw)

    # resolve $include before normalization so grafted nodes normalize too
    if doc.get("$include"):
        base = base_path if base_path is not None else os.getcwd()
        seen = _seen_includes if _seen_includes is not None else set()
        for rel in doc["$include"]:
            abs_path = os.path.abspath(os.path.join(base, rel))
            if abs_path in seen:
                raise ValueError(f"$include cycle detected at: {abs_path}")
            seen.add(abs_path)
            with open(abs_path, encoding="utf-8") as f:
                child = json.load(f)
            child_norm = normalize_document(child, base_path=os.path.dirname(abs_path), _seen_includes=seen)
            for node in child_norm["nodes"]:
                if node.get("parentId") is None:
                    raise ValueError(
                        f"$include document {rel} has a parentId:null root; included roots must name a mount node"
                    )
                if any(n["id"] == node["id"] for n in doc["nodes"]):
                    raise ValueError(f"$include document {rel} collides on node id: {node['id']}")
                doc["nodes"].append(node)
    doc.pop("$include", None)

    doc["profile"] = doc.get("profile") if doc.get("profile") is not None else "L0"
    doc["version"] = doc.get("version") if doc.get("version") is not None else "0"
    doc["nodes"] = [normalize_node(n) for n in doc["nodes"]]

    # DFS re-serialization + edge materialization need indexes; build once.
    # Orphaned nodes (dangling parentId) are preserved after the DFS block, in
    # authored order, so the validator can flag them instead of losing them.
    graph = Graph(doc)
    ordered = graph.dfs()
    seen_ids = {n["id"] for n in ordered}
    doc["nodes"] = ordered + [n for n in doc["nodes"] if n["id"] not in seen_ids]
    doc["edges"] = materialize_edges(doc)
    return doc


def _nn(v: Any, default: Any) -> Any:
    return default if v is None else v


def normalize_node(n: dict) -> dict:
    node = dict(n)
    node["type"] = _nn(node.get("type"), "category")
    node["routable"] = _nn(node.get("routable"), True)
    if isinstance(node.get("prompt"), str):
        node["prompt"] = {"slots": {"task": node["prompt"]}}
    if "bring" in node or "recursiveBring" in node or "maxBringDepth" in node:
        node["recursiveBring"] = _nn(node.get("recursiveBring"), False)
        node["bringMode"] = _nn(node.get("bringMode"), "contextOnly")
        node["maxBringDepth"] = _nn(node.get("maxBringDepth"), 3)
    if "collect" in node or "decision" in node:
        node["fillPolicy"] = _nn(node.get("fillPolicy"), "opportunistic")
    node["visitPolicy"] = _nn(node.get("visitPolicy"), "repeatable")
    node["isFallback"] = _nn(node.get("isFallback"), False)
    return node


def materialize_edges(doc: dict) -> list[dict]:
    """Inline relations → edges[], preserving authored seeAlso/aliasOf edges."""
    edges: list[dict] = []
    for node in doc["nodes"]:
        if node.get("parentId") is not None:
            edges.append({"from": node["parentId"], "to": node["id"], "kind": "child"})
    for node in doc["nodes"]:
        for b in node.get("bring") or []:
            edges.append({"from": node["id"], "to": b, "kind": "bring"})
        for c in (node.get("decision") or {}).get("choices") or []:
            edges.append({"from": node["id"], "to": c["next"], "kind": "choice"})
        if node.get("fallbackNodeId"):
            edges.append({"from": node["id"], "to": node["fallbackNodeId"], "kind": "fallback"})
    for e in doc.get("edges") or []:
        if e.get("kind") in ("seeAlso", "aliasOf"):
            edges.append(e)
    return edges


def load_graph(source: dict | str, base_path: str | None = None) -> Graph:
    """Load and materialize a graph from a document or a *.apg.json path."""
    if isinstance(source, str):
        with open(source, encoding="utf-8") as f:
            raw = json.load(f)
        default_base = os.path.dirname(os.path.abspath(source))
        return Graph(normalize_document(raw, base_path=base_path if base_path is not None else default_base))
    return Graph(normalize_document(source, base_path=base_path))

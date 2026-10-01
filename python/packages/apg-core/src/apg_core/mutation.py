import copy
import json
import re
from typing import Any

from ._json import _jsify
from .graph import Graph
from .loader import materialize_edges, normalize_document, normalize_node
from .minischema import is_plain_object
from .validator import validate_graph

# ---- op application (§7.1: transactional and ordered) ----


def apply_op(doc: dict, op: dict) -> dict:
    """Apply a single op to a normalized document, returning a new document.
    Raises on structural failure (unknown ids, cycles, collisions). The nodes
    array is re-emitted in DFS order after every op."""
    next_doc = copy.deepcopy(doc)
    Graph(next_doc)  # structural precondition: a root exists

    def nodes() -> list[dict]:
        return next_doc["nodes"]

    def require(id: str, what: str = "node") -> dict:
        for n in nodes():
            if n["id"] == id:
                return n
        raise ValueError(f"Unknown {what} id: {id}")

    def child_ids(parent_id: str) -> list[str]:
        return [n["id"] for n in nodes() if n.get("parentId") == parent_id]

    def subtree_ids(root_id: str) -> set[str]:
        out = {root_id}
        grew = True
        while grew:
            grew = False
            for n in nodes():
                if n.get("parentId") is not None and n["parentId"] in out and n["id"] not in out:
                    out.add(n["id"])
                    grew = True
        return out

    # Sibling order is order of appearance in the flat array; a position among
    # siblings maps to a flat insertion point just before the sibling currently
    # at that position (or the end).
    def insert_at_sibling_position(node: dict, position: int | None) -> None:
        siblings = child_ids(node["parentId"])
        pos = len(siblings) if position is None else min(position, len(siblings))
        if pos >= len(siblings):
            next_doc["nodes"].append(node)
        else:
            before_id = siblings[pos]
            idx = next(i for i, n in enumerate(next_doc["nodes"]) if n["id"] == before_id)
            next_doc["nodes"].insert(idx, node)

    kind = op["op"]
    if kind == "addNode":
        require(op["parentId"], "parent")
        if any(n["id"] == op["node"]["id"] for n in nodes()):
            raise ValueError(f"Node id already exists: {op['node']['id']}")
        node = copy.deepcopy(op["node"])
        node["parentId"] = op["parentId"]
        node = normalize_node(node)
        insert_at_sibling_position(node, op.get("position"))
    elif kind == "updateNode":
        node = require(op["id"])
        if "id" in op["patch"]:
            raise ValueError("updateNode may not change id")
        if "parentId" in op["patch"]:
            raise ValueError("updateNode may not change parentId; use moveNode")
        deep_merge_into(node, op["patch"])
        # re-normalize so patches keep the doc canonical (string prompts
        # desugar; patched bring/collect/decision get their defaults)
        idx = next(i for i, n in enumerate(nodes()) if n["id"] == op["id"])
        next_doc["nodes"][idx] = normalize_node(node)
    elif kind == "moveNode":
        node = require(op["id"])
        if node.get("parentId") is None:
            raise ValueError("Cannot move the root node")
        require(op["newParentId"], "parent")
        if op["newParentId"] in subtree_ids(op["id"]):
            raise ValueError(f"moveNode would create a cycle: {op['id']} → {op['newParentId']}")
        next_doc["nodes"] = [n for n in nodes() if n["id"] != op["id"]]
        node["parentId"] = op["newParentId"]
        insert_at_sibling_position(node, op.get("position"))
    elif kind == "deleteNode":
        node = require(op["id"])
        if node.get("parentId") is None:
            raise ValueError("Cannot delete the root node")
        if op.get("orphans") == "cascade":
            doomed = subtree_ids(op["id"])
            for id in doomed:
                _assert_not_pinned(require(id), op.get("force"))
            next_doc["nodes"] = [n for n in nodes() if n["id"] not in doomed]
        else:
            _assert_not_pinned(node, op.get("force"))
            for n in nodes():
                if n.get("parentId") == op["id"]:
                    n["parentId"] = node["parentId"]
            next_doc["nodes"] = [n for n in nodes() if n["id"] != op["id"]]
    elif kind == "pruneSubtree":
        require(op["id"])
        for id in subtree_ids(op["id"]):
            _assert_not_pinned(require(id), op.get("force"))
        for id in subtree_ids(op["id"]):
            n = require(id)
            n["metadata"] = {**(n.get("metadata") or {}), "status": "pruned"}
    elif kind == "graftSubtree":
        require(op["parentId"], "parent")
        incoming = {n["id"] for n in op["nodes"]}
        for n in op["nodes"]:
            if any(x["id"] == n["id"] for x in nodes()):
                raise ValueError(f"graftSubtree collides on node id: {n['id']}")
        for n in op["nodes"]:
            node = normalize_node(copy.deepcopy(n))
            if node.get("parentId") is None or node["parentId"] not in incoming:
                node["parentId"] = op["parentId"]
            next_doc["nodes"].append(node)
    elif kind == "mergeNodes":
        into = require(op["intoId"], "merge target")
        for id in op["ids"]:
            if id == op["intoId"]:
                continue
            victim = require(id)
            _assert_not_pinned(victim, op.get("force"))  # merging INTO a pinned node is fine
            if op["intoId"] in subtree_ids(id):
                raise ValueError(f"mergeNodes target {op['intoId']} is inside merged subtree {id}")
            aliases = list(into.get("aliases") or [])
            for a in [victim.get("title"), *(victim.get("aliases") or [])]:
                if a is not None and a != "" and a not in aliases:
                    aliases.append(a)
            if aliases:
                into["aliases"] = aliases
            bring = list(into.get("bring") or [])
            for b in victim.get("bring") or []:
                if b not in bring and b != op["intoId"]:
                    bring.append(b)
            if bring:
                into["bring"] = bring
            for n in nodes():
                if n.get("parentId") == id:
                    n["parentId"] = op["intoId"]
            next_doc["nodes"] = [n for n in nodes() if n["id"] != id]
            _rewrite_references(next_doc, id, op["intoId"])
    elif kind == "splitNode":
        original = require(op["id"])
        for part in op["partitions"]:
            if any(x["id"] == part["node"]["id"] for x in nodes()):
                raise ValueError(f"splitNode collides on node id: {part['node']['id']}")
        for part in op["partitions"]:
            node = copy.deepcopy(part["node"])
            node["parentId"] = op["id"]
            node = normalize_node(node)
            takes = [t for t in part["takes"] if t in (original.get("aliases") or [])]
            if takes:
                original["aliases"] = [a for a in (original.get("aliases") or []) if a not in takes]
                merged = list(node.get("aliases") or [])
                for t in takes:
                    if t not in merged:
                        merged.append(t)
                node["aliases"] = merged
            next_doc["nodes"].append(node)
    elif kind == "reorderChildren":
        require(op["parentId"], "parent")
        current = child_ids(op["parentId"])
        if len(current) != len(op["order"]) or not all(id in op["order"] for id in current):
            raise ValueError(f"reorderChildren order must be a permutation of current children of {op['parentId']}")
        by_id = {n["id"]: n for n in nodes()}
        child_set = set(current)
        order_queue = [by_id[id] for id in op["order"]]
        next_doc["nodes"] = [order_queue.pop(0) if n["id"] in child_set else n for n in nodes()]
    elif kind == "setBring":
        node = require(op["id"])
        node["bring"] = list(op["bring"])
        rb = op.get("recursiveBring")
        if rb is None:
            rb = node.get("recursiveBring")
        node["recursiveBring"] = False if rb is None else rb
        node["bringMode"] = node.get("bringMode") if node.get("bringMode") is not None else "contextOnly"
        node["maxBringDepth"] = node.get("maxBringDepth") if node.get("maxBringDepth") is not None else 3
    elif kind == "linkChoice":
        node = require(op["decisionId"])
        if node.get("type") != "decision" or not node.get("decision"):
            raise ValueError(f"Node {op['decisionId']} is not a decision node")
        choices = node["decision"]["choices"]
        existing = next((i for i, c in enumerate(choices) if c["value"] == op["choice"]["value"]), -1)
        if existing >= 0:
            choices[existing] = dict(op["choice"])
        else:
            choices.append(dict(op["choice"]))
    elif kind == "unlinkChoice":
        node = require(op["decisionId"])
        if node.get("type") != "decision" or not node.get("decision"):
            raise ValueError(f"Node {op['decisionId']} is not a decision node")
        choices = node["decision"]["choices"]
        idx = next((i for i, c in enumerate(choices) if c["value"] == op["value"]), -1)
        if idx < 0:
            raise ValueError(f'No choice with value "{op["value"]}" on decision {op["decisionId"]}')
        choices.pop(idx)
    elif kind == "setEdge":
        edge = op["edge"]
        if edge["kind"] not in ("seeAlso", "aliasOf", "fallback"):
            raise ValueError(f"setEdge supports seeAlso|aliasOf|fallback, got: {edge['kind']}")
        require(edge["from"])
        require(edge["to"])
        if edge["kind"] == "fallback":
            require(edge["from"])["fallbackNodeId"] = edge["to"]
        else:
            if next_doc.get("edges") is None:
                next_doc["edges"] = []
            if not any(
                e["from"] == edge["from"] and e["to"] == edge["to"] and e["kind"] == edge["kind"]
                for e in next_doc["edges"]
            ):
                next_doc["edges"].append(dict(edge))
    elif kind == "removeEdge":
        edge = op["edge"]
        if edge["kind"] == "fallback":
            node = require(edge["from"])
            if node.get("fallbackNodeId") == edge["to"]:
                del node["fallbackNodeId"]
        else:
            next_doc["edges"] = [
                e
                for e in (next_doc.get("edges") or [])
                if not (e["from"] == edge["from"] and e["to"] == edge["to"] and e["kind"] == edge["kind"])
            ]
    elif kind == "updateGraphConfig":
        patch = op["patch"]
        if patch.get("defaults"):
            if next_doc.get("defaults") is None:
                next_doc["defaults"] = {}
            deep_merge_into(next_doc["defaults"], patch["defaults"])
        if patch.get("meta"):
            if next_doc.get("meta") is None:
                next_doc["meta"] = {}
            deep_merge_into(next_doc["meta"], patch["meta"])
        if patch.get("variables"):
            next_doc["variables"] = copy.deepcopy(patch["variables"])
    elif kind == "updateRoutingConfig":
        if next_doc.get("defaults") is None:
            next_doc["defaults"] = {}
        if next_doc["defaults"].get("routing") is None:
            next_doc["defaults"]["routing"] = {}
        patch = op["patch"]
        if patch.get("descriptor"):
            next_doc["defaults"]["routing"]["descriptor"] = list(patch["descriptor"])
        if patch.get("embedText"):
            next_doc["defaults"]["routing"]["embedText"] = list(patch["embedText"])
    else:
        raise ValueError(f"Unknown op: {json.dumps(_jsify(op), separators=(',', ':'), ensure_ascii=False)}")

    # re-emit DFS order + refreshed edges
    rebuilt = Graph(next_doc)
    next_doc["nodes"] = list(rebuilt.dfs())
    next_doc["edges"] = materialize_edges(next_doc)
    return next_doc


def _assert_not_pinned(node: dict, force: Any) -> None:
    """Pinned nodes are protected from removal ops; content edits stay legal (§9)."""
    if node.get("pinned") is True and force is not True:
        raise ValueError(f'Node "{node["id"]}" is pinned (pass force to override)')


def deep_merge_into(target: dict, patch: dict) -> None:
    """updateNode patch semantics: deep-merge; null deletes a key; arrays replace wholesale."""
    for key, value in patch.items():
        if value is None:
            target.pop(key, None)
        elif is_plain_object(value) and is_plain_object(target.get(key)):
            deep_merge_into(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _rewrite_references(doc: dict, from_id: str, to_id: str) -> None:
    for node in doc["nodes"]:
        if node.get("bring"):
            mapped = [to_id if b == from_id else b for b in node["bring"]]
            node["bring"] = _dedupe([b for b in mapped if b != node["id"]])
        if node.get("fallbackNodeId") == from_id:
            node["fallbackNodeId"] = to_id
        if node.get("decision"):
            for c in node["decision"]["choices"]:
                if c["next"] == from_id:
                    c["next"] = to_id
            if node["decision"].get("timeoutNext") == from_id:
                node["decision"]["timeoutNext"] = to_id
            if node["decision"].get("freeform"):
                node["decision"]["freeform"]["classifyInto"] = _dedupe(
                    [to_id if x == from_id else x for x in node["decision"]["freeform"]["classifyInto"]]
                )
        if node.get("action"):
            if node["action"].get("onSuccess") == from_id:
                node["action"]["onSuccess"] = to_id
            if node["action"].get("onError") == from_id:
                node["action"]["onError"] = to_id
        if (node.get("escalation") or {}).get("resumeNode") == from_id:
            node["escalation"]["resumeNode"] = to_id
    doc["edges"] = [
        {**e, "from": to_id if e["from"] == from_id else e["from"], "to": to_id if e["to"] == from_id else e["to"]}
        for e in doc.get("edges") or []
    ]


def _dedupe(xs: list) -> list:
    return list(dict.fromkeys(xs))


# ---- changesets (base/tenant scope: full pipeline, atomic) ----


def create_changeset(doc: dict, created_by: str, id: str = "cs-draft") -> dict:
    return {
        "id": id,
        "baseGraphVersion": doc.get("version") or "0",
        "ops": [],
        "status": "draft",
        "createdBy": created_by,
    }


def apply_changeset(doc: dict, ops: list[dict]) -> dict:
    """Transactional application: any op failure aborts the whole changeset;
    the result must pass structural validation; version suffix increments
    deterministically."""
    next_doc = doc
    for i, op in enumerate(ops):
        try:
            next_doc = apply_op(next_doc, op)
        except Exception as err:
            raise ValueError(f"Changeset aborted at op {i} ({op['op']}): {err}") from err
    report = validate_graph(next_doc)
    if not report["valid"]:
        first = report["errors"][0]
        at = f" at {first['nodeId']}" if first.get("nodeId") is not None else ""
        raise ValueError(f"Changeset produced an invalid graph: {first['code']}{at}")
    result = copy.deepcopy(next_doc)
    result["version"] = bump_version(doc.get("version") or "0")
    return result


_VERSION_RE = re.compile(r"^(.*)-(\d+)$")


def bump_version(version: str) -> str:
    m = _VERSION_RE.match(version)
    if m:
        return f"{m.group(1)}-{int(m.group(2)) + 1}"
    return f"{version}-1"


# ---- layers (per-scope evolution: drop-and-flag, never guess) ----


def materialize_layers(base: dict, layers: list[dict]) -> dict:
    """base ⊕ layers, in the given order. An op that fails to apply is
    dropped and flagged (never guessed); updateRoutingConfig is
    base-scope-only and is always dropped from layers.

    Returns {"doc": <canonical doc>, "conflicts": [...]}.
    """
    doc = copy.deepcopy(base)
    conflicts: list[dict] = []
    for layer in layers:
        for op_index, op in enumerate(layer["ops"]):
            if op["op"] == "updateRoutingConfig":
                conflicts.append(
                    {
                        "layerId": layer["layerId"],
                        "opIndex": op_index,
                        "reason": "updateRoutingConfig is a major change allowed on base scope only",
                        "droppedAt": layer["version"],
                    }
                )
                continue
            try:
                doc = apply_op(doc, op)
            except Exception as err:
                conflicts.append(
                    {
                        "layerId": layer["layerId"],
                        "opIndex": op_index,
                        "reason": str(err),
                        "droppedAt": layer["version"],
                    }
                )
    return {"doc": normalize_document(doc), "conflicts": conflicts}


def route_cache_key(query: str, base_version: str, layer_versions: list[str]) -> str:
    """Cache key derivation (§7.2): undiverged users share the base cache."""
    return json.dumps([query, base_version, *layer_versions], separators=(",", ":"), ensure_ascii=False)


def rebase_layer(base: dict, layer: dict) -> dict:
    """Rebase a layer onto a (newer) base: re-applies through the pinned
    materialize_layers machinery, writing drop-and-flag conflicts INTO the
    returned layer and stamping the new baseVersion. Never guesses."""
    conflicts = materialize_layers(base, [layer])["conflicts"]
    return {
        **copy.deepcopy(layer),
        "baseVersion": base.get("version") or "0",
        "conflicts": [
            {"opIndex": c["opIndex"], "reason": c["reason"], "droppedAt": c["droppedAt"]} for c in conflicts
        ],
    }


def load_with_layers(base: dict, layers: list[dict]) -> dict:
    """Convenience: base ⊕ layers, materialized and indexed in one call.

    Returns {"doc": ..., "graph": Graph, "conflicts": [...]}.
    """
    result = materialize_layers(base, layers)
    return {"doc": result["doc"], "graph": Graph(result["doc"]), "conflicts": result["conflicts"]}

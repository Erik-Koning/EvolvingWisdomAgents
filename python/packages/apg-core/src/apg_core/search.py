"""Node search / props-vocabulary discovery. Mirrors core/src/search.ts."""
from .graph import Graph, node_field


def find_nodes(graph: Graph, query: str, field: str | None = None, subtree_id: str | None = None) -> list[dict]:
    """Case-insensitive substring search over descriptor fields and props."""
    q = query.lower()
    hits = []
    for node in _scope(graph, subtree_id):
        fields = [field] if field else [*graph.descriptor_for(node["id"]), "aliases"]
        if any(q in node_field(node, f).lower() for f in fields):
            hits.append(node)
    return hits


def list_property_keys(graph: Graph, subtree_id: str | None = None) -> dict[str, int]:
    """Union of props.* keys in use (with counts)."""
    counts: dict[str, int] = {}
    for node in _scope(graph, subtree_id):
        for key in (node.get("props") or {}):
            counts[key] = counts.get(key, 0) + 1
    return counts


def _scope(graph: Graph, subtree_id: str | None) -> list[dict]:
    if subtree_id is None:
        return graph.dfs()
    return [n for n in graph.dfs() if any(a["id"] == subtree_id for a in graph.path_to(n["id"]))]

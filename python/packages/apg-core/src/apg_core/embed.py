"""Write-path half of the router's stored-vector preference: precompute
node.embedding for routable nodes missing one. Mirrors core/src/embed.ts."""
import copy
from typing import Any

from .graph import Graph
from .outline import embed_text


def precompute_embeddings(doc: dict, embeddings: Any, force: bool = False) -> dict:
    """Embed embedText fields (never prompt payloads) for every routable,
    non-pruned node missing a vector. Returns a new doc; zero connector calls
    when nothing is missing."""
    graph = Graph(doc)
    targets = [
        n["id"]
        for n in graph.dfs()
        if n.get("routable") is not False
        and not graph.is_pruned(n["id"])
        and (force or not n.get("embedding"))
    ]
    if not targets:
        return doc

    vectors = embeddings.embed([embed_text(graph, id) for id in targets])
    next_doc = copy.deepcopy(doc)
    by_id = {n["id"]: n for n in next_doc["nodes"]}
    for i, id in enumerate(targets):
        by_id[id]["embedding"] = vectors[i]
    return next_doc

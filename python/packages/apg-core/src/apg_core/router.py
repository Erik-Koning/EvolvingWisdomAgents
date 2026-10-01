import functools
import math

from .bring import resolve_bring
from .expr import eval_condition
from .graph import Graph
from .outline import embed_text, serialize_outline

CLASSIFY_SCHEMA = {
    "type": "object",
    "required": ["matches"],
    "properties": {
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["nodeId", "confidence"],
                "properties": {
                    "nodeId": {"type": "string"},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                },
            },
        },
    },
}


def route(query: str, graph: Graph, connectors: dict, session_vars: dict | None = None) -> dict:
    """Hybrid router (§7.2): eligibility gate → embedding shortlist →
    canonical outline → single-pass structured classification → confidence
    gate → tie-break → fallback. No randomness anywhere."""
    llm = connectors.get("llm")
    if llm is None:
        raise ValueError("Driver missing: llm connector is required for routing")
    routing = graph.routing()
    vars = session_vars or {}

    # 1. eligibility: routable, not pruned, entryCondition holds
    eligible = [
        n["id"]
        for n in graph.dfs()
        if n.get("routable") is not False
        and not graph.is_pruned(n["id"])
        and (eval_condition(n["entryCondition"], vars) if n.get("entryCondition") else True)
    ]

    # 2. embedding pre-filter. Stored node.embedding vectors are preferred;
    #    the connector is only called for the query plus nodes lacking a
    #    precomputed vector. Scores compute when the pool needs shrinking OR
    #    the graph opts into the embedBypass fast path (which needs them even
    #    for small pools).
    shortlist = eligible
    bypass: dict | None = None
    embeddings = connectors.get("embeddings")
    want_scores = (
        embeddings is not None
        and len(eligible) > 0
        and (len(eligible) > routing["shortlistK"] or routing["embedBypass"] is not None)
    )
    if embeddings is not None and want_scores:
        vectors: dict[str, list[float]] = {}
        missing: list[str] = []
        for id in eligible:
            stored = graph.get(id).get("embedding")
            if stored:
                vectors[id] = stored
            else:
                missing.append(id)
        vecs = embeddings.embed([query, *[embed_text(graph, id) for id in missing]])
        query_vec = vecs[0]
        for i, id in enumerate(missing):
            vectors[id] = vecs[i + 1]
        scored = [{"id": id, "sim": _cosine(query_vec, vectors[id])} for id in eligible]

        def cmp(a: dict, b: dict) -> int:
            if b["sim"] != a["sim"]:
                return -1 if b["sim"] < a["sim"] else 1
            return graph.compare_nodes(a["id"], b["id"])

        scored.sort(key=functools.cmp_to_key(cmp))

        # fast path: a decisive top-1 answers routing without the LLM. Two
        # gates (absolute similarity + margin over the runner-up); confidence
        # = cosine, reason "embedding". minConfidence governs only the
        # classify path.
        bp = routing["embedBypass"]
        if bp is not None and scored:
            top = scored[0]
            second = scored[1] if len(scored) > 1 else None
            if top["sim"] >= bp["minSimilarity"] and (
                second is None or top["sim"] - second["sim"] >= bp["minMargin"]
            ):
                bypass = {"nodeId": top["id"], "confidence": top["sim"], "reason": "embedding"}

        shortlist = [s["id"] for s in scored[: routing["shortlistK"]]]
        # restore DFS order for outline stability
        in_shortlist = set(shortlist)
        shortlist = [id for id in eligible if id in in_shortlist]

    fallback_used = False
    if bypass is not None:
        matches = [bypass]
    else:
        # 3. canonical outline over surviving branches
        outline = serialize_outline(graph, shortlist)
        outline_ids = set(shortlist)

        # 4. single-pass structured classification
        raw_response = llm.classify(query=query, outline=outline, schema=CLASSIFY_SCHEMA, multi=routing["allowMulti"])

        # dedupe by nodeId, keeping the highest-confidence entry
        by_node: dict[str, dict] = {}
        for m in raw_response:
            prior = by_node.get(m["nodeId"])
            if prior is None or m["confidence"] > prior["confidence"]:
                by_node[m["nodeId"]] = m
        raw = list(by_node.values())

        # 5. safety filter + confidence gate + tie-break total order
        gated = [m for m in raw if m["nodeId"] in outline_ids and m["confidence"] >= routing["minConfidence"]]
        gated.sort(key=functools.cmp_to_key(_compare_matches(graph)))

        matches = gated if routing["allowMulti"] else gated[:1]

        # 6. fallback: below-threshold top candidate's nearest fallbackNodeId →
        #    first isFallback node in DFS order → root
        if not matches:
            fallback_used = True
            raw_sorted = [m for m in raw if m["nodeId"] in outline_ids]
            raw_sorted.sort(key=functools.cmp_to_key(_compare_matches(graph)))
            target = _nearest_fallback(graph, raw_sorted[0]["nodeId"]) if raw_sorted else None
            if target is None:
                target = next(
                    (n["id"] for n in graph.dfs() if n.get("isFallback") is True and not graph.is_pruned(n["id"])),
                    None,
                )
            if target is None:
                target = graph.root_id
            matches = [{"nodeId": target, "confidence": 0, "reason": "fallback"}]

    # 7. companion context, unioned in match order
    brought_nodes: list[str] = []
    seen: set[str] = set()
    for m in matches:
        for b in resolve_bring(graph, m["nodeId"])["brought"]:
            if b not in seen:
                seen.add(b)
                brought_nodes.append(b)

    return {
        "matches": matches,
        "strategy": "multi" if len(matches) > 1 else "single",
        "fallbackUsed": fallback_used,
        "broughtNodes": brought_nodes,
        "shortlist": shortlist,
        "cacheHit": False,
    }


def _compare_matches(graph: Graph):
    def cmp(a: dict, b: dict) -> int:
        if a["confidence"] != b["confidence"]:
            return -1 if b["confidence"] < a["confidence"] else 1
        return graph.compare_nodes(a["nodeId"], b["nodeId"])

    return cmp


def _nearest_fallback(graph: Graph, id: str) -> str | None:
    path = graph.path_to(id)
    for node in reversed(path):
        fb = node.get("fallbackNodeId")
        if fb and graph.has(fb) and not graph.is_pruned(fb):
            return fb
    return None


def _cosine(a: list[float], b: list[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))

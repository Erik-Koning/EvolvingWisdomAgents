# Loop-3 growth utilities ("deep sleep"): deterministic math + op-building
# for taxonomy evolution. The LLM-judgment stages (labeling clusters,
# new-sibling vs boundary-fix) are host patterns; everything here is pure and
# mirrored in both runtimes. Resulting ops flow through the pinned
# apply_changeset, so behavior stays inside the conformance contract.
import copy
import math

from .graph import Graph


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    n = min(len(a), len(b))
    for i in range(n):
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    if na == 0 or nb == 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def cluster_by_similarity(vectors: list[list[float]], threshold: float, min_size: int = 2) -> list[list[int]]:
    """Deterministic greedy single-link clustering: items join the FIRST
    existing cluster containing any member within threshold, in input order —
    no randomness, no dependency. Returns clusters of input indices; clusters
    smaller than min_size are dropped as noise."""
    clusters: list[list[int]] = []
    for i in range(len(vectors)):
        placed = False
        for cluster in clusters:
            if any(cosine_similarity(vectors[i], vectors[j]) >= threshold for j in cluster):
                cluster.append(i)
                placed = True
                break
        if not placed:
            clusters.append([i])
    return [c for c in clusters if len(c) >= min_size]


def medoid(vectors: list[list[float]], indices: list[int]) -> int:
    """The most central member: max total similarity, tie → lowest index."""
    best = indices[0]
    best_score = -math.inf
    for i in indices:
        score = 0.0
        for j in indices:
            if i != j:
                score += cosine_similarity(vectors[i], vectors[j])
        if score > best_score:
            best_score = score
            best = i
    return best


def build_split_ops(graph: Graph, category_id: str, groups: list[dict]) -> list[dict]:
    """Ops that grow a category into subcategories: add each new subcategory
    under the category, MOVE the taken learnings beneath it, and emit one
    authoritative setBring per touched anchor (the removal-set lesson — no
    stale-snapshot clobbering). Validated by apply_changeset downstream.

    Each group is {"newCategory": <node with a new id>, "take": [node ids]}.
    """
    category = graph.get(category_id)
    resident = set(category.get("bring") or [])
    taken: set[str] = set()
    ops: list[dict] = []

    for group in groups:
        if graph.has(group["newCategory"]["id"]):
            raise ValueError(f"buildSplitOps: node id already exists: {group['newCategory']['id']}")
        take = [id for id in group["take"] if id in resident and id not in taken]
        if not take:
            continue
        for id in take:
            taken.add(id)
        ops.append(
            {
                "op": "addNode",
                "parentId": category_id,
                "node": {**copy.deepcopy(group["newCategory"]), "parentId": category_id},
            }
        )
        for id in take:
            ops.append({"op": "moveNode", "id": id, "newParentId": group["newCategory"]["id"]})
        ops.append({"op": "setBring", "id": group["newCategory"]["id"], "bring": take})

    if taken:
        ops.append(
            {
                "op": "setBring",
                "id": category_id,
                "bring": [id for id in (category.get("bring") or []) if id not in taken],
            }
        )
    return ops

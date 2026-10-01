from .graph import Graph


def resolve_bring(graph: Graph, landing_id: str) -> dict:
    """BFS bring expansion (spec §7.3): the landing node's recursiveBring
    governs the whole expansion (one hop only when false); seen-set cycle
    safety; depth capped by the landing node's maxBringDepth; tenant
    boundaries respected.

    Returns {"brought": [...], "depths": {...}, "dangling": [...],
    "tenantBlocked": [...]}: brought node ids in BFS order (a level's brings
    in array order); depth of each brought node relative to the landing node
    (direct = 1); references to unknown nodes (telemetry, never fatal at
    runtime); brings skipped for crossing a tenant boundary.
    """
    landing = graph.get(landing_id)
    recursive = landing.get("recursiveBring") or False
    max_depth = landing.get("maxBringDepth")
    if max_depth is None:
        max_depth = 3
    landing_tenant = (landing.get("metadata") or {}).get("tenantId")

    brought: list[str] = []
    depths: dict[str, int] = {}
    dangling: list[str] = []
    tenant_blocked: list[str] = []
    seen: set[str] = {landing_id}

    frontier: list[str] = list(landing.get("bring") or [])
    depth = 1
    while frontier and depth <= max_depth:
        next_frontier: list[str] = []
        for id in frontier:
            if id in seen:
                continue
            seen.add(id)
            if not graph.has(id):
                dangling.append(id)
                continue
            node = graph.get(id)
            if graph.is_pruned(id):
                continue
            node_tenant = (node.get("metadata") or {}).get("tenantId")
            if landing_tenant is not None and node_tenant is not None and node_tenant != landing_tenant:
                tenant_blocked.append(id)
                continue
            brought.append(id)
            depths[id] = depth
            if recursive:
                next_frontier.extend(node.get("bring") or [])
        frontier = next_frontier
        depth += 1
        if not recursive:
            break
    return {"brought": brought, "depths": depths, "dangling": dangling, "tenantBlocked": tenant_blocked}

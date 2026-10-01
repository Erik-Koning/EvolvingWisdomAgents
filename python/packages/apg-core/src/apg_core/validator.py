from .expr import parse_expr
from .graph import RESERVED_KEYS, ROUTING_DEFAULTS, node_field

PROFILE_ORDER = ["L0", "L1", "L2", "L3", "L4", "L5"]
DESCRIPTOR_RESERVED = frozenset(["title", "description", "aliases", "slug"])
DEPTH_LIMIT = 12
WIDTH_LIMIT = 50


def validate_graph(doc: dict) -> dict:
    """Structural + semantic validation of a canonical document (§7.9).
    Returns a report; never raises. Error codes are part of the conformance
    contract."""
    errors: list[dict] = []
    warnings: list[dict] = []

    def err(code: str, message: str, node_id: str | None = None) -> None:
        e: dict = {"code": code, "message": message}
        if node_id is not None:
            e["nodeId"] = node_id
        errors.append(e)

    def warn(code: str, message: str, node_id: str | None = None) -> None:
        e: dict = {"code": code, "message": message}
        if node_id is not None:
            e["nodeId"] = node_id
        warnings.append(e)

    # ---- identity & tree backbone ----
    by_id: dict[str, dict] = {}
    for node in doc["nodes"]:
        if node["id"] in by_id:
            err("DUPLICATE_ID", f"Duplicate node id: {node['id']}", node["id"])
        by_id[node["id"]] = node
    roots = [n for n in doc["nodes"] if n.get("parentId") is None]
    if len(roots) == 0:
        err("NO_ROOT", "Graph has no root node (parentId: null)")
    if len(roots) > 1:
        err("MULTIPLE_ROOTS", f"Graph has {len(roots)} roots: {', '.join(r['id'] for r in roots)}")
    for node in doc["nodes"]:
        if node.get("parentId") is not None and node["parentId"] not in by_id:
            err("DANGLING_PARENT", f"Node {node['id']} references unknown parent {node['parentId']}", node["id"])

    # parent cycles
    for node in doc["nodes"]:
        seen: set[str] = set()
        cur: dict | None = node
        while cur is not None and cur.get("parentId") is not None:
            if cur["id"] in seen:
                err("PARENT_CYCLE", f"Parent cycle through node {node['id']}", node["id"])
                break
            seen.add(cur["id"])
            cur = by_id.get(cur["parentId"])

    # sibling slug uniqueness
    slug_key: dict[str, str] = {}
    for node in doc["nodes"]:
        if not node.get("slug"):
            continue
        key = f"{node.get('parentId')}::{node['slug']}"
        prior = slug_key.get(key)
        if prior is not None:
            err(
                "DUPLICATE_SIBLING_SLUG",
                f"Slug \"{node['slug']}\" duplicated among children of {node.get('parentId')} ({prior}, {node['id']})",
                node["id"],
            )
        slug_key[key] = node["id"]

    # ---- reference integrity ----
    def ref(from_id: str, to_id: str | None, what: str) -> None:
        if to_id is not None and to_id not in by_id:
            err("DANGLING_REF", f"Node {from_id}: {what} references unknown node {to_id}", from_id)

    for node in doc["nodes"]:
        for b in node.get("bring") or []:
            ref(node["id"], b, "bring")
        ref(node["id"], node.get("fallbackNodeId"), "fallbackNodeId")
        if node.get("decision"):
            for c in node["decision"]["choices"]:
                ref(node["id"], c.get("next"), f"choice \"{c['value']}\"")
            ref(node["id"], node["decision"].get("timeoutNext"), "timeoutNext")
            for t in (node["decision"].get("freeform") or {}).get("classifyInto") or []:
                ref(node["id"], t, "freeform.classifyInto")
        if node.get("action"):
            ref(node["id"], node["action"].get("onSuccess"), "onSuccess")
            ref(node["id"], node["action"].get("onError"), "onError")
        ref(node["id"], (node.get("escalation") or {}).get("resumeNode"), "resumeNode")
    for e in doc.get("edges") or []:
        if e.get("kind") in ("seeAlso", "aliasOf"):
            if e["from"] not in by_id or e["to"] not in by_id:
                err(
                    "DANGLING_REF",
                    f"Edge {e['kind']} {e['from']} → {e['to']} references an unknown node",
                    e["from"] if e["from"] in by_id else None,
                )

    # ---- discriminated blocks ----
    for node in doc["nodes"]:
        if node.get("type") == "decision" and not node.get("decision"):
            err("TYPE_BLOCK_MISMATCH", f"Decision node {node['id']} has no decision block", node["id"])
        if node.get("type") != "decision" and node.get("decision"):
            err("TYPE_BLOCK_MISMATCH", f"Node {node['id']} has a decision block but type {node.get('type')}", node["id"])
        if node.get("type") == "action" and not node.get("action"):
            err("TYPE_BLOCK_MISMATCH", f"Action node {node['id']} has no action block", node["id"])
        if node.get("type") != "action" and node.get("action"):
            err("TYPE_BLOCK_MISMATCH", f"Node {node['id']} has an action block but type {node.get('type')}", node["id"])
        if node.get("type") == "answer" and "prompt" not in node:
            err(
                "ANSWER_WITHOUT_PROMPT",
                f"Answer node {node['id']} must carry a prompt — a terminal that says nothing is a bug",
                node["id"],
            )

    # ---- expressions parse ----
    for node in doc["nodes"]:
        for field, src in (
            ("entryCondition", node.get("entryCondition")),
            ("exitCondition", node.get("exitCondition")),
            ("skipCondition", node.get("skipCondition")),
            ("guard", (node.get("decision") or {}).get("guard")),
        ):
            if src is None:
                continue
            try:
                parse_expr(src)
            except Exception as e:
                err("EXPRESSION_PARSE_ERROR", f"Node {node['id']}: {field} does not parse: {e}", node["id"])

    # ---- descriptor invariants (v3.1) ----
    routing_defaults = (doc.get("defaults") or {}).get("routing") or {}
    graph_descriptor = routing_defaults.get("descriptor") or ROUTING_DEFAULTS["descriptor"]

    def check_descriptor_fields(fields: list[str], node_id: str | None = None) -> None:
        for f in fields:
            if f not in DESCRIPTOR_RESERVED and not f.startswith("props."):
                err(
                    "DESCRIPTOR_FIELD_INVALID",
                    f'Descriptor field "{f}" must be a reserved key or a props.* path',
                    node_id,
                )

    check_descriptor_fields(graph_descriptor)
    check_descriptor_fields(routing_defaults.get("embedText") or [])
    for node in doc["nodes"]:
        override = node.get("routingOverride") or {}
        if override.get("descriptor"):
            check_descriptor_fields(override["descriptor"], node["id"])
        if override.get("embedText"):
            check_descriptor_fields(override["embedText"], node["id"])

    # effective descriptor per node (nearest ancestor override incl. self)
    def effective_descriptor(node: dict) -> list[str]:
        cur: dict | None = node
        seen: set[str] = set()
        while cur is not None and cur["id"] not in seen:
            seen.add(cur["id"])
            ov = (cur.get("routingOverride") or {}).get("descriptor")
            if ov:
                return ov
            cur = None if cur.get("parentId") is None else by_id.get(cur["parentId"])
        return graph_descriptor

    for node in doc["nodes"]:
        if node.get("routable") is False or (node.get("metadata") or {}).get("status") == "pruned":
            continue
        fields = effective_descriptor(node)
        non_empty = any(node_field(node, f).strip() for f in fields)
        if not non_empty:
            err(
                "DESCRIPTOR_EMPTY",
                f"Routable node {node['id']} has no text in any effective descriptor field ({', '.join(fields)})",
                node["id"],
            )

    # reserved keys may not appear inside props
    for node in doc["nodes"]:
        for key in (node.get("props") or {}).keys():
            if key in RESERVED_KEYS:
                err("RESERVED_PROPS_KEY", f"Node {node['id']}: props may not contain reserved key \"{key}\"", node["id"])

    # ---- tenant boundaries (brings may not cross) ----
    for node in doc["nodes"]:
        from_tenant = (node.get("metadata") or {}).get("tenantId")
        if from_tenant is None:
            continue
        for b in node.get("bring") or []:
            to_tenant = ((by_id.get(b) or {}).get("metadata") or {}).get("tenantId")
            if to_tenant is not None and to_tenant != from_tenant:
                err(
                    "TENANT_CROSSING_BRING",
                    f"Node {node['id']} (tenant {from_tenant}) brings {b} (tenant {to_tenant})",
                    node["id"],
                )

    # ---- decision flows terminate ----
    for node in doc["nodes"]:
        if node.get("type") != "decision" or not node.get("decision"):
            continue
        if not _flow_reaches_terminal(node, by_id):
            err(
                "DECISION_UNTERMINATED",
                f"Decision {node['id']} has no reachable terminal (answer, escalation, or category)",
                node["id"],
            )

    # ---- bring cycles (runtime is seen-set safe; surface as warning) ----
    for node in doc["nodes"]:
        if not node.get("bring"):
            continue
        stack: set[str] = set()

        def visit(id: str) -> bool:
            if id in stack:
                return True
            stack.add(id)
            for b in (by_id.get(id) or {}).get("bring") or []:
                if visit(b):
                    return True
            stack.discard(id)
            return False

        if visit(node["id"]):
            warn("BRING_CYCLE", f"Bring cycle through node {node['id']} (runtime expansion is cycle-safe)", node["id"])
            break

    # ---- limits ----
    if len(roots) == 1 and all(e["code"] not in ("PARENT_CYCLE", "DANGLING_PARENT") for e in errors):

        def depth_of(node: dict) -> int:
            d = 0
            cur: dict | None = node
            while cur is not None and cur.get("parentId") is not None:
                cur = by_id.get(cur["parentId"])
                d += 1
            return d

        for node in doc["nodes"]:
            if depth_of(node) > DEPTH_LIMIT:
                warn("DEPTH_LIMIT", f"Node {node['id']} exceeds depth {DEPTH_LIMIT}", node["id"])
        width: dict = {}
        for node in doc["nodes"]:
            width[node.get("parentId")] = (width.get(node.get("parentId")) or 0) + 1
        for parent, count in width.items():
            if count > WIDTH_LIMIT:
                warn("WIDTH_LIMIT", f"Node {parent} has {count} children (limit {WIDTH_LIMIT})", parent)

    # ---- profile conformance ----
    declared = doc.get("profile") or "L0"
    required = detect_required_profile(doc)
    if PROFILE_ORDER.index(required) > PROFILE_ORDER.index(declared):
        err("PROFILE_VIOLATION", f"Graph declares profile {declared} but uses {required} features")

    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def _flow_reaches_terminal(start: dict, by_id: dict[str, dict]) -> bool:
    queue: list[str] = [start["id"]]
    seen: set[str] = set()
    while queue:
        id = queue.pop(0)
        if id in seen:
            continue
        seen.add(id)
        node = by_id.get(id)
        if node is None:
            continue
        escalation = node.get("escalation")
        is_terminal = (
            node.get("type") == "answer"
            or (escalation is not None and escalation.get("mode") != "none")
            or (node.get("type") == "category" and id != start["id"])
        )
        if is_terminal:
            return True
        if node.get("decision"):
            for c in node["decision"]["choices"]:
                queue.append(c["next"])
            if node["decision"].get("timeoutNext"):
                queue.append(node["decision"]["timeoutNext"])
            for t in (node["decision"].get("freeform") or {}).get("classifyInto") or []:
                queue.append(t)
        if node.get("action"):
            queue.append(node["action"]["onSuccess"])
            queue.append(node["action"]["onError"])
    return False


def detect_required_profile(doc: dict) -> str:
    """Lowest profile that covers the features a document uses. Detection
    ignores canonicalized defaults (e.g. visitPolicy "repeatable" or a
    desugared task-only prompt do not count as L1/L2 features)."""
    required = 0

    def need(level: int) -> None:
        nonlocal required
        if level > required:
            required = level

    if doc.get("variables"):
        need(1)
    routing = (doc.get("defaults") or {}).get("routing") or {}
    if routing.get("descriptor") or routing.get("embedText"):
        need(1)

    for node in doc["nodes"]:
        prompt = node.get("prompt")
        if isinstance(prompt, dict):
            slots = list(prompt.get("slots", {}).keys())
            if any(s != "task" for s in slots) or prompt.get("variables") or prompt.get("format"):
                need(1)
            if "queryRewrite" in slots:
                need(1)
        if node.get("bring"):
            need(1)
        if node.get("routable") is False:
            need(1)
        if node.get("props"):
            need(1)
        if node.get("routingOverride"):
            need(1)

        if node.get("collect"):
            need(2)
        if node.get("entryCondition") or node.get("exitCondition") or node.get("skipCondition"):
            need(2)
        if (node.get("decision") or {}).get("guard"):
            need(2)
        if node.get("visitPolicy") and node["visitPolicy"] != "repeatable":
            need(2)
        if node.get("outputSchema"):
            need(2)

        if node.get("type") in ("decision", "action", "answer"):
            need(3)
        if node.get("toolAllowlist"):
            need(3)
        if node.get("fallbackNodeId") or node.get("isFallback") is True:
            need(3)

        if node.get("escalation"):
            need(4)
    return PROFILE_ORDER[required]

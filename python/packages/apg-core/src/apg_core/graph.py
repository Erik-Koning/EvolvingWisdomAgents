# Materialized graph over a canonical document (plain dicts/lists).
from typing import Any

from ._json import js_str, json_stringify

ROUTING_DEFAULTS: dict = {
    "minConfidence": 0.55,
    "allowMulti": True,
    "shortlistK": 12,
    "descriptor": ["title", "description"],
    "embedText": ["title", "description", "aliases"],
    "embedBypass": None,  # fast path is opt-in per graph
}

BUDGET_DEFAULT_MAX_TOKENS = 6000

# Reserved structural keys that may not appear inside props.
RESERVED_KEYS = frozenset(
    [
        "id",
        "slug",
        "parentId",
        "type",
        "title",
        "description",
        "aliases",
        "props",
        "routingOverride",
        "routable",
        "pinned",
        "prompt",
        "composition",
        "fewShot",
        "outputSchema",
        "bring",
        "recursiveBring",
        "bringMode",
        "maxBringDepth",
        "decision",
        "action",
        "escalation",
        "collect",
        "fillPolicy",
        "entryCondition",
        "exitCondition",
        "visitPolicy",
        "skipCondition",
        "fallbackNodeId",
        "isFallback",
        "toolAllowlist",
        "modelOverride",
        "embedding",
        "metadata",
    ]
)


def _nn(v: Any, default: Any) -> Any:
    """Nullish coalescing: missing/None falls back to default; 0/False do not."""
    return default if v is None else v


class Graph:
    """Canonical doc + indexes. Nodes in the canonical doc are serialized in
    DFS order (parent before children, siblings in authored order); sibling
    order is order of appearance."""

    def __init__(self, doc: dict) -> None:
        self.doc = doc
        self.by_id: dict[str, dict] = {}
        self.children_of: dict[str, list[str]] = {}
        root: str | None = None
        for node in doc["nodes"]:
            self.by_id[node["id"]] = node
            if node["id"] not in self.children_of:
                self.children_of[node["id"]] = []
        for node in doc["nodes"]:
            if "parentId" in node and node["parentId"] is None:
                root = node["id"]
            elif node.get("parentId") in self.by_id:
                self.children_of[node["parentId"]].append(node["id"])
        if root is None:
            raise ValueError("Graph has no root node (parentId: null)")
        self.root_id: str = root

    def get(self, id: str) -> dict:
        n = self.by_id.get(id)
        if n is None:
            raise ValueError(f"Unknown node id: {id}")
        return n

    def has(self, id: str) -> bool:
        return id in self.by_id

    def children(self, id: str) -> list[dict]:
        return [self.get(c) for c in self.children_of.get(id, [])]

    def path_to(self, id: str) -> list[dict]:
        """root → … → id, inclusive."""
        path: list[dict] = []
        cur: dict | None = self.get(id)
        seen: set[str] = set()
        while cur is not None:
            if cur["id"] in seen:
                raise ValueError(f"Parent cycle at node: {cur['id']}")
            seen.add(cur["id"])
            path.append(cur)
            cur = None if cur.get("parentId") is None else self.by_id.get(cur["parentId"])
        path.reverse()
        return path

    def depth(self, id: str) -> int:
        return len(self.path_to(id)) - 1

    def dfs(self) -> list[dict]:
        """DFS order over the whole tree: parent first, siblings in authored order."""
        out: list[dict] = []

        def walk(id: str) -> None:
            out.append(self.get(id))
            for c in self.children_of.get(id, []):
                walk(c)

        walk(self.root_id)
        return out

    def sibling_index(self, id: str) -> int:
        node = self.get(id)
        if node.get("parentId") is None:
            return 0
        siblings = self.children_of.get(node["parentId"], [])
        return siblings.index(id) if id in siblings else -1

    def is_pruned(self, id: str) -> bool:
        return (self.get(id).get("metadata") or {}).get("status") == "pruned"

    def routing(self) -> dict:
        r = (self.doc.get("defaults") or {}).get("routing") or {}
        return {
            "minConfidence": _nn(r.get("minConfidence"), ROUTING_DEFAULTS["minConfidence"]),
            "allowMulti": _nn(r.get("allowMulti"), ROUTING_DEFAULTS["allowMulti"]),
            "shortlistK": _nn(r.get("shortlistK"), ROUTING_DEFAULTS["shortlistK"]),
            "descriptor": _nn(r.get("descriptor"), ROUTING_DEFAULTS["descriptor"]),
            "embedText": _nn(r.get("embedText"), ROUTING_DEFAULTS["embedText"]),
            "embedBypass": _nn(r.get("embedBypass"), ROUTING_DEFAULTS["embedBypass"]),
        }

    def max_prompt_tokens(self) -> int:
        budget = (self.doc.get("defaults") or {}).get("budget") or {}
        return _nn(budget.get("maxPromptTokens"), BUDGET_DEFAULT_MAX_TOKENS)

    def descriptor_for(self, id: str) -> list[str]:
        """Effective routing descriptor: nearest ancestor (including self)
        with routingOverride.descriptor wins; else the graph descriptor."""
        path = self.path_to(id)
        for node in reversed(path):
            ov = (node.get("routingOverride") or {}).get("descriptor")
            if ov:
                return ov
        return self.routing()["descriptor"]

    def embed_text_fields_for(self, id: str) -> list[str]:
        path = self.path_to(id)
        for node in reversed(path):
            ov = (node.get("routingOverride") or {}).get("embedText")
            if ov:
                return ov
        return self.routing()["embedText"]

    def compare_nodes(self, a: str, b: str) -> int:
        """Total tie-break order over nodes (after confidence): deeper node
        first, then sibling order along the path, then lexicographic id.
        Smaller sorts first."""
        da = self.depth(a)
        db = self.depth(b)
        if da != db:
            return db - da  # deeper wins
        pa = self.path_to(a)
        pb = self.path_to(b)
        for i in range(1, len(pa)):
            ia = self.sibling_index(pa[i]["id"])
            ib = self.sibling_index(pb[i]["id"])
            if ia != ib:
                return ia - ib
        return -1 if a < b else (1 if a > b else 0)


# ---- field access ----


def node_field(node: dict, field: str) -> str:
    """Resolve a descriptor/embedText field path on a node. Reserved keys are
    read directly; "props.x.y" walks the props bag. Arrays of strings join
    with ", "; non-string scalars stringify; null/missing/empty → ""."""
    value: Any
    if field.startswith("props."):
        cur: Any = node.get("props") or {}
        for part in field[len("props.") :].split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                cur = None
                break
        value = cur
    else:
        value = node.get(field)
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ", ".join(v if isinstance(v, str) else json_stringify(v) for v in value)
    if isinstance(value, (bool, int, float)):
        return js_str(value)
    return json_stringify(value)


def prompt_template(node: dict) -> dict | None:
    if "prompt" not in node:
        return None
    prompt = node["prompt"]
    if isinstance(prompt, str):
        return {"slots": {"task": prompt}}
    return prompt


def graph_defaults(doc: dict) -> dict:
    return doc.get("defaults") or {}

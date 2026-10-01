import re
from typing import Any

from ._json import json_stringify
from .bring import resolve_bring
from .connectors import count_tokens_fallback
from .graph import Graph, prompt_template

TEXT_SLOTS = ["persona", "task", "constraints", "knowledge", "examples", "outputFormat"]
CONTEXT_ONLY_SLOTS = ["knowledge", "constraints", "examples"]

# Pinned truncation priorities (§7.1). Higher = kept longer. Path constraints
# are never dropped.
PRIORITY_LEAF_CORE = 900
PRIORITY_PATH = 800
PRIORITY_BRING = 700
PRIORITY_BRING_DEPTH_STEP = 50
PRIORITY_EXAMPLES = 400
PRIORITY_OVERLAY = 100


def compose(graph: Graph, target_ids: list[str], opts: dict | None = None) -> dict:
    """Deterministic three-stage composition (§7.4): path (the author's
    intent) → brings + secondary matches (the graph's shared knowledge,
    contextOnly) → user overlays (this user's history), then priority-based
    token budgeting.

    opts keys: query, vars (call-site, highest precedence), sessionVars,
    memoryVars, tenantVars, overlays, maxPromptTokens, countTokens.
    """
    opts = opts or {}
    if not target_ids:
        raise ValueError("compose requires at least one target node")
    primary = target_ids[0]
    if graph.is_pruned(primary):
        raise ValueError(f'Node "{primary}" is pruned')
    path = graph.path_to(primary)
    path_ids = {n["id"] for n in path}

    # variable defaults are scoped to the nodes that can contribute fragments:
    # the primary path plus imports (secondary matches and brings) — a default
    # declared on an unrelated subtree must not leak into this composition
    scope_ids = set(path_ids)
    for t in target_ids[1:]:
        if graph.has(t):
            scope_ids.add(t)
    for t in target_ids:
        if not graph.has(t):
            continue
        for b in resolve_bring(graph, t)["brought"]:
            scope_ids.add(b)
    vars = merge_vars(graph, opts, scope_ids)
    unresolved: list[dict] = []
    seq_counter = [0]

    per_slot: dict[str, list[dict]] = {s: [] for s in TEXT_SLOTS}

    def add_fragment(slot: str, frag: dict, mode: str) -> None:
        lst = per_slot[slot]
        if mode == "override":
            lst.clear()
        if mode == "merge" and any(f["text"] == frag["text"] for f in lst):
            return
        if mode == "prepend":
            lst.insert(0, frag)
        else:
            lst.append(frag)

    def next_seq() -> int:
        seq_counter[0] += 1
        return seq_counter[0] - 1

    def render(node: dict, raw: str) -> str:
        return _interpolate(raw, node, vars, opts.get("query"), unresolved, _required_var_names(graph, node))

    # ---- stage 1: path ----
    rewritten_query: str | None = None
    has_rewrite = False
    for node in path:
        template = prompt_template(node)
        is_leaf = node["id"] == primary
        if template:
            for slot in TEXT_SLOTS:
                raw = template.get("slots", {}).get(slot)
                if raw is None or raw == "":
                    continue
                text = render(node, raw)
                priority = _path_priority(node, slot, is_leaf)
                add_fragment(
                    slot,
                    {
                        "nodeId": node["id"],
                        "slot": slot,
                        "text": text,
                        "priority": priority,
                        "droppable": slot != "constraints",
                        "seq": next_seq(),
                    },
                    _slot_mode(graph, node, slot),
                )
            rewrite = template.get("slots", {}).get("queryRewrite")
            if rewrite is not None and rewrite != "":
                rewritten_query = render(node, rewrite)  # deepest wins (override)
                has_rewrite = True
        for ex in node.get("fewShot") or []:
            add_fragment(
                "examples",
                {
                    "nodeId": node["id"],
                    "slot": "examples",
                    "text": f"Input: {ex['input']}\nOutput: {ex['output']}",
                    "priority": _composition_priority(node, PRIORITY_EXAMPLES),
                    "droppable": True,
                    "seq": next_seq(),
                },
                "append",
            )

    # ---- stage 2: secondary matches + brings (always append, contextOnly unless bringMode full) ----
    contributed: set[str] = set(path_ids)
    brought_nodes: list[str] = []

    def contribute_import(node: dict, slots: list[str], priority: int) -> None:
        template = prompt_template(node)
        if template:
            for slot in slots:
                raw = template.get("slots", {}).get(slot)
                if raw is None or raw == "":
                    continue
                add_fragment(
                    slot,
                    {
                        "nodeId": node["id"],
                        "slot": slot,
                        "text": render(node, raw),
                        "priority": _composition_priority(
                            node, PRIORITY_EXAMPLES if slot == "examples" else priority
                        ),
                        "droppable": True,
                        "seq": next_seq(),
                    },
                    "append",
                )
        if "examples" in slots:
            for ex in node.get("fewShot") or []:
                add_fragment(
                    "examples",
                    {
                        "nodeId": node["id"],
                        "slot": "examples",
                        "text": f"Input: {ex['input']}\nOutput: {ex['output']}",
                        "priority": _composition_priority(node, PRIORITY_EXAMPLES),
                        "droppable": True,
                        "seq": next_seq(),
                    },
                    "append",
                )

    for target_id in target_ids[1:]:
        if target_id in contributed or not graph.has(target_id):
            continue
        contributed.add(target_id)
        brought_nodes.append(target_id)
        contribute_import(graph.get(target_id), CONTEXT_ONLY_SLOTS, PRIORITY_BRING)

    for target_id in target_ids:
        if not graph.has(target_id):
            continue
        landing = graph.get(target_id)
        import_slots = TEXT_SLOTS if landing.get("bringMode") == "full" else CONTEXT_ONLY_SLOTS
        resolution = resolve_bring(graph, target_id)
        for id in resolution["brought"]:
            if id in contributed:
                continue
            contributed.add(id)
            brought_nodes.append(id)
            depth = resolution["depths"].get(id, 1)
            contribute_import(graph.get(id), import_slots, PRIORITY_BRING - PRIORITY_BRING_DEPTH_STEP * (depth - 1))

    # ---- stage 3: user overlays (contextOnly by construction, ancestors first) ----
    overlays = [o for o in (opts.get("overlays") or []) if o["nodeId"] in path_ids]
    overlays.sort(key=lambda o: _path_index(path, o["nodeId"]))
    for overlay in overlays:
        for slot in CONTEXT_ONLY_SLOTS:
            text = overlay.get("digest", {}).get(slot)
            if text is None or text == "":
                continue
            add_fragment(
                slot,
                {
                    "nodeId": overlay["nodeId"],
                    "slot": slot,
                    "text": text,
                    "priority": PRIORITY_OVERLAY,
                    "droppable": True,
                    "seq": next_seq(),
                },
                "append",
            )

    # ---- budgeting ----
    count_tokens = opts.get("countTokens") or count_tokens_fallback
    max_tokens = opts.get("maxPromptTokens")
    if max_tokens is None:
        max_tokens = graph.max_prompt_tokens()
    truncated: list[dict] = []

    def all_fragments() -> list[dict]:
        return [f for s in TEXT_SLOTS for f in per_slot[s]]

    total = sum(count_tokens(f["text"]) for f in all_fragments())
    while total > max_tokens:
        candidates = [f for f in all_fragments() if f["droppable"]]
        if not candidates:
            break
        victim = candidates[0]
        for f in candidates:
            if f["priority"] < victim["priority"] or (f["priority"] == victim["priority"] and f["seq"] > victim["seq"]):
                victim = f
        per_slot[victim["slot"]].remove(victim)
        truncated.append({"nodeId": victim["nodeId"], "slot": victim["slot"]})
        total -= count_tokens(victim["text"])

    # ---- assembly ----
    slots: dict[str, str] = {}
    sections: list[str] = []
    for slot in TEXT_SLOTS:
        texts = [f["text"] for f in per_slot[slot]]
        if not texts:
            continue
        joined = "\n\n".join(texts)
        slots[slot] = joined
        sections.append(joined)

    # contributors: nodes with >=1 SURVIVING fragment, first-contribution order
    # (ascending seq) — the usage-telemetry contract (§5)
    contributors: list[str] = []
    for frag in sorted(all_fragments(), key=lambda f: f["seq"]):
        if frag["nodeId"] not in contributors:
            contributors.append(frag["nodeId"])

    result: dict = {
        "slots": slots,
        "text": "\n\n".join(sections),
        "contributors": contributors,
        "truncated": truncated,
        "unresolved": unresolved,
    }
    if has_rewrite:
        result["rewrittenQuery"] = rewritten_query

    output_schema = _leaf_output_schema(path)
    if output_schema is not None:
        result["outputSchema"] = output_schema
    model_hints = _merge_model_hints(graph, path)
    if model_hints is not None:
        result["modelHints"] = model_hints
    allowlist = _effective_tool_allowlist(path)
    if allowlist is not None:
        result["toolAllowlist"] = allowlist
    return result


def _composition_priority(node: dict, default: int) -> int:
    p = (node.get("composition") or {}).get("priority")
    return default if p is None else p


def _path_priority(node: dict, slot: str, is_leaf: bool) -> int:
    p = (node.get("composition") or {}).get("priority")
    if p is not None:
        return p
    if slot == "constraints":
        return 1000  # never dropped anyway
    if slot == "examples":
        return PRIORITY_EXAMPLES
    if is_leaf and slot in ("persona", "task"):
        return PRIORITY_LEAF_CORE
    return PRIORITY_PATH


def _slot_mode(graph: Graph, node: dict, slot: str) -> str:
    comp = node.get("composition") or {}
    v = (comp.get("mode") or {}).get(slot)
    if v is not None:
        return v
    v = comp.get("defaultMode")
    if v is not None:
        return v
    defaults_comp = (graph.doc.get("defaults") or {}).get("composition") or {}
    v = (defaults_comp.get("mode") or {}).get(slot)
    if v is not None:
        return v
    v = defaults_comp.get("defaultMode")
    if v is not None:
        return v
    return "append"


def _path_index(path: list[dict], id: str) -> int:
    for i, n in enumerate(path):
        if n["id"] == id:
            return i
    return -1


def _leaf_output_schema(path: list[dict]) -> dict | None:
    for node in reversed(path):
        if node.get("outputSchema"):
            return node["outputSchema"]
    return None


def _merge_model_hints(graph: Graph, path: list[dict]) -> dict | None:
    merged = dict((graph.doc.get("defaults") or {}).get("model") or {})
    for node in path:
        merged.update(node.get("modelOverride") or {})
    return merged if merged else None


def _effective_tool_allowlist(path: list[dict]) -> list[str] | None:
    allow: list[str] | None = None
    for node in path:
        if not node.get("toolAllowlist"):
            continue
        if allow is None:
            allow = list(node["toolAllowlist"])
        else:
            allow = [t for t in allow if t in node["toolAllowlist"]]
    return allow


# ---- variables ----


def merge_vars(graph: Graph, opts: dict, scope_ids: set[str] | None = None) -> dict:
    """Precedence (low → high): graph defaults → tenant → memory → session →
    call-site. Template-level defaults apply only for nodes in scope_ids (the
    composition's path + imports); omit scope_ids to collect from all nodes."""
    bag: dict[str, Any] = {}
    for spec in graph.doc.get("variables") or []:
        if "default" in spec:
            bag[spec["name"]] = spec["default"]
    for node in graph.dfs():
        if scope_ids is not None and node["id"] not in scope_ids:
            continue
        template = prompt_template(node)
        for spec in (template or {}).get("variables") or []:
            if "default" in spec and spec["name"] not in bag:
                bag[spec["name"]] = spec["default"]
    for key in ("tenantVars", "memoryVars", "sessionVars", "vars"):
        bag.update(opts.get(key) or {})
    return bag


def _required_var_names(graph: Graph, node: dict) -> set[str]:
    required: set[str] = set()
    for spec in graph.doc.get("variables") or []:
        if spec.get("required"):
            required.add(spec["name"])
    template = prompt_template(node)
    for spec in (template or {}).get("variables") or []:
        if spec.get("required"):
            required.add(spec["name"])
    return required


MUSTACHE_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")
FSTRING_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_.]*)\}")

_MISSING = object()


def _interpolate(
    raw: str,
    node: dict,
    vars: dict,
    query: str | None,
    unresolved: list[dict],
    required: set[str],
) -> str:
    template = prompt_template(node)
    pattern = FSTRING_RE if (template or {}).get("format") == "f-string" else MUSTACHE_RE

    def replace(m: re.Match) -> str:
        name = m.group(1)
        if name == "query":
            return query if query is not None else ""
        if name.startswith("props."):
            value = _resolve_dotted(node.get("props") or {}, name[len("props.") :])
        else:
            value = _resolve_dotted(vars, name)
        if value is _MISSING or value is None:
            if name in required:
                raise ValueError(f'Missing required variable "{name}" at node "{node["id"]}"')
            unresolved.append({"nodeId": node["id"], "variable": name})
            return ""
        return value if isinstance(value, str) else json_stringify(value)

    return pattern.sub(replace, raw)


def _resolve_dotted(vars: dict, path: str) -> Any:
    cur: Any = vars
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur

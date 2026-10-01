import copy
import functools
import re
from typing import Any

from ._json import json_stringify
from .expr import eval_condition, eval_expr
from .graph import Graph, prompt_template
from .minischema import mini_validate
from .outline import serialize_outline

STEP_LIMIT = 100


def new_session(session_id: str) -> dict:
    return {"sessionId": session_id, "mode": "routing", "vars": {}, "visited": {}, "stepCount": 0}


def session_step(graph: Graph, session: dict, input: dict, connectors: dict | None = None) -> dict:
    """Deterministic session stepping (§7.6): zero-LLM traversal of flow
    edges, except scoped freeform mini-classification and opportunistic fill,
    both of which go through the llm connector.

    Returns {"session": <new state>, "effects": [...]}.
    """
    connectors = connectors or {}
    s = copy.deepcopy(session)
    effects: list[dict] = []
    pending: dict | None = input

    def record(node_id: str, event: str) -> None:
        if s.get("history") is None:
            s["history"] = []
        s["history"].append({"at": f"#{s['stepCount']}", "nodeId": node_id, "event": event})

    def arrive(node_id: str, event: str) -> None:
        s["currentNodeId"] = node_id
        s["visited"][node_id] = (s["visited"].get(node_id) or 0) + 1
        s["stepCount"] += 1
        record(node_id, event)

    # ---- awaitingHuman: only a human answer moves the session ----
    if s["mode"] == "awaitingHuman":
        if pending is None or pending.get("kind") != "humanAnswer":
            return {"session": s, "effects": effects}
        held = s.pop("pendingHuman", None)
        held_node = graph.get(held["nodeId"]) if held else None
        if held:
            effects.append({"kind": "humanSaid", "nodeId": held["nodeId"], "text": pending["text"]})
        resume = ((held_node or {}).get("escalation") or {}).get("resumeNode")
        if resume and graph.has(resume):
            s["mode"] = "walking"
            arrive(resume, "resume")
            pending = None
        else:
            s["mode"] = "routing"
            s.pop("currentNodeId", None)
            effects.append({"kind": "walkComplete"})
            return {"session": s, "effects": effects}
    elif pending is not None and pending.get("kind") == "enter":
        if not graph.has(pending["nodeId"]):
            # stale/unknown target (e.g. the graph mutated since routing): reroute
            s["mode"] = "routing"
            effects.append({"kind": "reroute"})
            return {"session": s, "effects": effects}
        s["mode"] = "walking"
        arrive(pending["nodeId"], "enter")
        pending = None

    if s["mode"] != "walking" or s.get("currentNodeId") is None or not graph.has(s["currentNodeId"]):
        s["mode"] = "routing"
        effects.append({"kind": "reroute"})
        return {"session": s, "effects": effects}

    # ---- opportunistic fill: scan free text once against open schemas ----
    if pending is not None and pending.get("kind") == "user":
        node = graph.get(s["currentNodeId"])
        policy = node.get("fillPolicy") or "opportunistic"
        llm = connectors.get("llm")
        if policy == "opportunistic" and llm is not None and hasattr(llm, "extract"):
            schema = _open_vars_schema(node)
            if schema is not None:
                extracted = llm.extract(text=pending["text"], schema=schema)
                for k, v in extracted.items():
                    if k not in s["vars"] and v is not None:
                        s["vars"][k] = v

    # ---- walk loop: auto-advance until user input is needed or terminal ----
    iterations = 0
    diverted_once: set[str] = set()
    while iterations < STEP_LIMIT and s["stepCount"] <= STEP_LIMIT:
        iterations += 1
        node = graph.get(s["currentNodeId"])

        # visitPolicy "once": a revisit diverts to the nearest fallback, else ends
        # the walk; a divert cycle within one step (once-nodes whose fallbacks
        # point at each other) also ends the walk instead of burning the limit
        if node.get("visitPolicy") == "once" and s["visited"].get(node["id"], 0) > 1:
            fb = _nearest_fallback(graph, node["id"])
            if fb is not None and fb != node["id"] and node["id"] not in diverted_once:
                diverted_once.add(node["id"])
                arrive(fb, "onceRevisit")
                continue
            s["mode"] = "routing"
            s.pop("currentNodeId", None)
            effects.append({"kind": "walkComplete"})
            break

        # entry gate
        if node.get("entryCondition") and not eval_condition(node["entryCondition"], s["vars"]):
            fb = _nearest_fallback(graph, node["id"])
            if fb is not None:
                arrive(fb, "entryConditionFallback")
                continue
            s["mode"] = "routing"
            effects.append({"kind": "reroute"})
            break

        # mandatory human gate
        escalation = node.get("escalation") or {}
        if escalation.get("mode") == "require" and not s.get("pendingHuman"):
            missing = _missing_vars(escalation.get("collectBeforeHandoff") or [], s["vars"])
            if missing is not None:
                consumed = _try_explicit_fill(node, missing, pending, s, effects)
                if consumed:
                    pending = None
                still = _missing_vars(escalation.get("collectBeforeHandoff") or [], s["vars"])
                if still is not None:
                    if not any(e["kind"] == "elicit" for e in effects):
                        effects.append(
                            {
                                "kind": "elicit",
                                "nodeId": node["id"],
                                "variable": still["name"],
                                "prompt": still.get("elicitationPrompt") or f"Please provide {still['name']}",
                            }
                        )
                    break
            ticket_id = f"ticket-{node['id']}-{s['stepCount']}"
            s["mode"] = "awaitingHuman"
            s["pendingHuman"] = {"ticketId": ticket_id, "nodeId": node["id"], "since": f"#{s['stepCount']}"}
            handoff = connectors.get("handoff")
            if handoff is not None:
                handoff.open(
                    {"nodeId": node["id"], "queue": escalation.get("queue"), "vars": s["vars"]}
                )
            effect: dict = {"kind": "escalate", "nodeId": node["id"], "ticketId": ticket_id}
            if "queue" in escalation and escalation["queue"] is not None:
                effect["queue"] = escalation["queue"]
            effects.append(effect)
            record(node["id"], "escalate")
            break

        # intake
        skipping = eval_condition(node["skipCondition"], s["vars"]) if node.get("skipCondition") else False
        if node.get("collect") and not skipping:
            missing = _missing_vars(node["collect"], s["vars"])
            if missing is not None:
                consumed = _try_explicit_fill(node, missing, pending, s, effects)
                if consumed:
                    pending = None
                still = _missing_vars(node["collect"], s["vars"])
                if still is not None:
                    if not any(e["kind"] == "elicit" for e in effects):
                        effects.append(
                            {
                                "kind": "elicit",
                                "nodeId": node["id"],
                                "variable": still["name"],
                                "prompt": still.get("elicitationPrompt") or f"Please provide {still['name']}",
                            }
                        )
                    break

        if node.get("type") == "decision":
            d = node["decision"]
            if skipping:
                next_id = d.get("timeoutNext") or d["choices"][0]["next"]
                arrive(next_id, "skip")
                continue
            # 1. already answered: saveAs var matches a choice
            known = s["vars"].get(d["saveAs"]) if d.get("saveAs") is not None else None
            known_choice = next((c for c in d["choices"] if _strict_same(c["value"], known)), None)
            if known_choice is not None:
                if not _leave_allowed(node, s, effects):
                    break
                arrive(known_choice["next"], f"choice:{known_choice['value']}")
                continue
            # 2. guard expression resolving to a choice value
            if d.get("guard"):
                g = eval_expr(d["guard"], s["vars"])
                guard_choice = (
                    next((c for c in d["choices"] if c["value"] == g), None) if isinstance(g, str) else None
                )
                if guard_choice is not None:
                    if d.get("saveAs"):
                        s["vars"][d["saveAs"]] = guard_choice["value"]
                    if not _leave_allowed(node, s, effects):
                        break
                    arrive(guard_choice["next"], f"guard:{guard_choice['value']}")
                    continue
            # 3. explicit user input
            if pending is not None and pending.get("kind") in ("choice", "user"):
                text = pending["value"] if pending["kind"] == "choice" else pending["text"]
                match = _match_choice(d["choices"], text)
                if match is not None:
                    pending = None
                    if d.get("saveAs"):
                        s["vars"][d["saveAs"]] = match["value"]
                    if not _leave_allowed(node, s, effects):
                        break
                    arrive(match["next"], f"choice:{match['value']}")
                    continue
                # 4. scoped freeform mini-classification
                if pending["kind"] == "user" and d.get("freeform") and connectors.get("llm") is not None:
                    scope = [id for id in d["freeform"]["classifyInto"] if graph.has(id)]
                    outline = serialize_outline(graph, scope)
                    raw = connectors["llm"].classify(query=pending["text"], outline=outline, schema={}, multi=False)
                    pending = None

                    def cmp(a: dict, b: dict) -> int:
                        if a["confidence"] != b["confidence"]:
                            return -1 if b["confidence"] < a["confidence"] else 1
                        return graph.compare_nodes(a["nodeId"], b["nodeId"])

                    gated = [
                        m
                        for m in raw
                        if m["nodeId"] in scope and m["confidence"] >= graph.routing()["minConfidence"]
                    ]
                    gated.sort(key=functools.cmp_to_key(cmp))
                    if gated:
                        arrive(gated[0]["nodeId"], "freeform")
                        continue
            effects.append(
                {
                    "kind": "ask",
                    "nodeId": node["id"],
                    "question": d["question"],
                    "choices": [{"label": c["label"], "value": c["value"]} for c in d["choices"]],
                }
            )
            break

        if node.get("type") == "action":
            a = node["action"]
            allow = _effective_allowlist(graph, node["id"])
            ok = False
            result: Any = None
            if allow is not None and a["tool"] not in allow:
                ok = False
            else:
                tools = connectors.get("tools")
                if tools is None:
                    raise ValueError("Driver missing: tools connector is required for action nodes")
                args = dict(a.get("args") or {})
                for name in a.get("argsFromVars") or []:
                    args[name] = s["vars"].get(name)
                r = tools.call(a["tool"], args)
                ok = bool(r["ok"]) and (
                    len(mini_validate(r["result"], a["resultSchema"])) == 0 if a.get("resultSchema") else True
                )
                result = r["result"]
            if ok and a.get("saveResultAs"):
                s["vars"][a["saveResultAs"]] = result
            effects.append({"kind": "toolCall", "nodeId": node["id"], "tool": a["tool"], "ok": ok})
            arrive(a["onSuccess"] if ok else a["onError"], "onSuccess" if ok else "onError")
            continue

        if node.get("type") == "answer":
            template = prompt_template(node)
            text = _render_answer((template or {}).get("slots", {}).get("task") or "", node, s["vars"])
            effects.append({"kind": "say", "nodeId": node["id"], "text": text})
            record(node["id"], "say")
            s["mode"] = "routing"
            s.pop("currentNodeId", None)
            effects.append({"kind": "walkComplete"})
            break

        # category: exitCondition gates the exit to composition (loopUntilValid intake)
        if not _leave_allowed(node, s, effects):
            break
        effects.append({"kind": "composeReady", "nodeId": node["id"]})
        s["mode"] = "routing"
        break

    if s["stepCount"] > STEP_LIMIT:
        s["mode"] = "routing"
        s.pop("currentNodeId", None)
        effects.append({"kind": "walkComplete"})
    return {"session": s, "effects": effects}


def _strict_same(a: Any, b: Any) -> bool:
    """JS strict equality for choice values (bool is not a number)."""
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    return a == b


def _leave_allowed(node: dict, s: dict, effects: list[dict]) -> bool:
    """exitCondition gates leaving; visitPolicy "once" gates re-entry downstream."""
    if node.get("exitCondition") and not eval_condition(node["exitCondition"], s["vars"]):
        effects.append(
            {
                "kind": "elicit",
                "nodeId": node["id"],
                "variable": node["exitCondition"],
                "prompt": f"Exit condition not met: {node['exitCondition']}",
            }
        )
        return False
    return True


def _match_choice(choices: list[dict], text: str) -> dict | None:
    t = text.strip().lower()
    for c in choices:
        if c["value"].lower() == t:
            return c
    for c in choices:
        if c["label"].lower() == t:
            return c
    return None


def _missing_vars(specs: list[dict], vars: dict) -> dict | None:
    for spec in specs:
        if spec.get("required") and spec["name"] not in vars:
            return spec
    return None


def _try_explicit_fill(node: dict, spec: dict, pending: dict | None, s: dict, effects: list[dict]) -> bool:
    """explicit fill: consume the raw user text as the first pending variable."""
    if pending is None or pending.get("kind") != "user":
        return False
    if (node.get("fillPolicy") or "opportunistic") != "explicit":
        return False
    value: Any = pending["text"]
    if spec.get("schema") and len(mini_validate(_coerce(value, spec["schema"]), spec["schema"])) > 0:
        effects.append(
            {
                "kind": "elicit",
                "nodeId": node["id"],
                "variable": spec["name"],
                "prompt": spec.get("elicitationPrompt") or f"Please provide {spec['name']}",
            }
        )
        return True
    s["vars"][spec["name"]] = _coerce(value, spec["schema"]) if spec.get("schema") else value
    return True


# Pinned: only plain decimal literals coerce — keeps JS Number() and Python
# float() from disagreeing on hex, underscores, "nan"/"inf", etc.
_NUMERIC_LITERAL_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)$")


def _coerce(value: Any, schema: dict) -> Any:
    if isinstance(value, str) and schema.get("type") in ("number", "integer"):
        text = value.strip()
        if not _NUMERIC_LITERAL_RE.match(text):
            return value
        n = float(text)
        return int(n) if n.is_integer() else n
    return value


def _nearest_fallback(graph: Graph, id: str) -> str | None:
    for node in reversed(graph.path_to(id)):
        fb = node.get("fallbackNodeId")
        if fb and graph.has(fb) and not graph.is_pruned(fb):
            return fb
    return None


def _effective_allowlist(graph: Graph, id: str) -> list[str] | None:
    allow: list[str] | None = None
    for node in graph.path_to(id):
        if not node.get("toolAllowlist"):
            continue
        if allow is None:
            allow = list(node["toolAllowlist"])
        else:
            allow = [t for t in allow if t in node["toolAllowlist"]]
    return allow


def _open_vars_schema(node: dict) -> dict | None:
    """Union mini-schema of everything the current node could learn from free text."""
    properties: dict[str, Any] = {}
    escalation = node.get("escalation") or {}
    for spec in (node.get("collect") or []) + (escalation.get("collectBeforeHandoff") or []):
        properties[spec["name"]] = spec.get("schema") or {"type": "string"}
    d = node.get("decision") or {}
    if d.get("saveAs"):
        properties[d["saveAs"]] = {"enum": [c["value"] for c in d["choices"]]}
    if not properties:
        return None
    return {"type": "object", "properties": properties}


_MUSTACHE_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")


def _render_answer(raw: str, node: dict, vars: dict) -> str:
    def replace(m: re.Match) -> str:
        name = m.group(1)
        if name.startswith("props."):
            cur = _dig(node.get("props") or {}, name[len("props.") :])
        else:
            cur = _dig(vars, name)
        if cur is None:
            return ""
        return cur if isinstance(cur, str) else json_stringify(cur)

    return _MUSTACHE_RE.sub(replace, raw)


def _dig(bag: dict, path: str) -> Any:
    cur: Any = bag
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur

"""End-to-end Python demo: deterministic session walking over the device-triage
template — zero LLM calls. Mirrors examples/walk-triage-flow.mjs step for step;
the two runtimes share one fixture-pinned walker.

Run from the repo root:
    cd python && uv run python ../examples/walk_triage_flow.py
"""
import json
import os

from apg_core import ScriptedTools, load_graph, new_session, session_step

graph = load_graph(os.path.join(os.path.dirname(__file__), "..", "templates", "l3-triage-flows.apg.json"))
connectors = {
    "tools": ScriptedTools({"checkWarranty": {"ok": True, "result": {"inWarranty": True, "until": "2027-01-01"}}}),
}


def show(label: str, effects: list[dict]) -> None:
    print(f"\n== {label}")
    for e in effects:
        print("  ", json.dumps(e))


step = session_step(graph, new_session("demo"), {"kind": "enter", "nodeId": "wont-start"}, connectors)
show("enter wont-start → decision asks", step["effects"])

step = session_step(graph, step["session"], {"kind": "choice", "value": "yes"}, connectors)
show("choice: powers on → next decision asks", step["effects"])

step = session_step(graph, step["session"], {"kind": "choice", "value": "yes"}, connectors)
show("choice: screen damaged → action node elicits the serial number", step["effects"])

step = session_step(graph, step["session"], {"kind": "user", "text": "SN-12345"}, connectors)
show("user: SN-12345 → explicit fill, tool call, answer", step["effects"])

print("\nfinal vars:", json.dumps(step["session"]["vars"], indent=2))

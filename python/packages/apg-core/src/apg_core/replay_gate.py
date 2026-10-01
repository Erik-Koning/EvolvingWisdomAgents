# The replay evidence gate — the pure half of the "preservation-biased replay"
# policy (docs/library-roadmap.md): replay may freely add, refine-additively,
# and reinforce, but an op that DEGRADES stored wisdom passes only with a
# mechanically verified citation — a verbatim quote from a USER turn of a
# stored transcript. Uncited degrades are dropped, never applied.
#
# Degrade classification over the op algebra:
# - always degrading: deleteNode, pruneSubtree, mergeNodes, unlinkChoice,
#   removeEdge, updateGraphConfig, updateRoutingConfig
# - setBring: degrading iff the new array drops any id currently in the bring
# - updateNode: degrading iff the patch nulls any key (at any depth) or
#   replaces an existing prompt slot with strictly shorter text
# - everything else (addNode, moveNode, graftSubtree, splitNode,
#   reorderChildren, linkChoice, setEdge): additive
#
# Citation verification is mechanical, not model-trusted: the quote must
# appear (whitespace-normalized, case-sensitive) inside the cited turn's
# content AND that turn's role must be "user" — assistant turns carry no
# degrade authority (the agent must not launder its own inferences).
#
# Mirrors typescript/packages/core/src/replay-gate.ts (normative).
import re

_ALWAYS_DEGRADING = frozenset(
    {
        "deleteNode",
        "pruneSubtree",
        "mergeNodes",
        "unlinkChoice",
        "removeEdge",
        "updateGraphConfig",
        "updateRoutingConfig",
    }
)

# Drop reasons: "no-citation" | "transcript-not-found" | "turn-out-of-range"
# | "not-user-turn" | "quote-not-found"


def _slot_texts(prompt) -> dict:
    if prompt is None:
        return {}
    if isinstance(prompt, str):
        return {"task": prompt}
    return dict(prompt.get("slots") or {})


def _patch_nulls_any_key(patch) -> bool:
    if patch is None:
        return True
    if isinstance(patch, list):
        return False  # arrays replace wholesale; not a keyed deletion
    if not isinstance(patch, dict):
        return False
    return any(_patch_nulls_any_key(v) for v in patch.values())


def is_degrading_op(doc: dict, op: dict) -> bool:
    """Whether an op degrades stored wisdom, judged against the current doc."""
    if op["op"] in _ALWAYS_DEGRADING:
        return True
    if op["op"] == "setBring":
        node = next((n for n in doc["nodes"] if n["id"] == op["id"]), None)
        current = (node.get("bring") if node is not None else None) or []
        next_ids = set(op["bring"])
        return any(id not in next_ids for id in current)
    if op["op"] == "updateNode":
        if _patch_nulls_any_key(op["patch"]):
            return True
        node = next((n for n in doc["nodes"] if n["id"] == op["id"]), None)
        if node is None:
            return False  # dangling target fails at apply time, not here
        patch = op["patch"]
        if not isinstance(patch, dict) or "prompt" not in patch:
            return False
        current = _slot_texts(node.get("prompt"))
        nxt = _slot_texts(patch["prompt"])
        return any(
            isinstance(current.get(slot), str) and len(current[slot]) > 0 and len(text) < len(current[slot])
            for slot, text in nxt.items()
        )
    return False


def _normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def verify_citation(evidence: dict, transcripts: list[dict]) -> str | None:
    """Verify one citation against the transcripts. Returns None when it
    holds, otherwise the most specific failure reason."""
    transcript = next((t for t in transcripts if t["id"] == evidence["transcriptId"]), None)
    if transcript is None:
        return "transcript-not-found"
    turns = transcript.get("turns") or []
    turn_index = evidence["turnIndex"]
    turn = turns[turn_index] if 0 <= turn_index < len(turns) else None
    if turn is None:
        return "turn-out-of-range"
    if turn["role"] != "user":
        return "not-user-turn"
    if _normalize_ws(evidence["quote"]) not in _normalize_ws(turn["content"]):
        return "quote-not-found"
    return None


def apply_evidence_gate(
    doc: dict,
    ops: list[dict],
    evidence: list[dict] | None = None,
    transcripts: list[dict] | None = None,
) -> dict:
    """Filter a replay op batch through the evidence gate. Additive ops always
    pass; degrading ops pass only with at least one verified citation.
    Evidence rows for kept ops are re-indexed to positions in the kept array
    so the result is self-consistent for changeset assembly."""
    evidence = evidence or []
    transcripts = transcripts or []
    kept: list[dict] = []
    kept_evidence: list[dict] = []
    dropped: list[dict] = []

    for op_index, op in enumerate(ops):
        citations = [e for e in evidence if e["opIndex"] == op_index]
        if not is_degrading_op(doc, op):
            at = len(kept)
            kept.append(op)
            kept_evidence.extend({**e, "opIndex": at} for e in citations)
            continue
        if not citations:
            dropped.append({"opIndex": op_index, "op": op, "reason": "no-citation"})
            continue
        reason = "no-citation"
        verified: list[dict] = []
        for e in citations:
            failure = verify_citation(e, transcripts)
            if failure is not None:
                reason = failure
            else:
                verified.append(e)
        if not verified:
            dropped.append({"opIndex": op_index, "op": op, "reason": reason})
            continue
        at = len(kept)
        kept.append(op)
        kept_evidence.extend({**e, "opIndex": at} for e in verified)

    return {"kept": kept, "evidence": kept_evidence, "dropped": dropped}

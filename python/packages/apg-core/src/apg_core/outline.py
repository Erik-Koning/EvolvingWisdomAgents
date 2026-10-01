import re
import unicodedata

from .graph import Graph, node_field

_NEWLINE_RUNS = re.compile(r"\s*[\r\n]+\s*")


def serialize_outline(graph: Graph, shortlist: list[str] | None = None) -> str:
    """Canonical router outline (determinism contract §7.1):
    - depth-first, authored sibling order
    - two-space indent per rendered-ancestor count
    - one line per node: `{id}: {descriptor fields joined " — "}`
    - descriptor fields render in declared order; empty fields skipped
    - text NFC-normalized; newlines collapsed to a single space
    - routable, non-pruned nodes only; a shortlist restricts to those nodes
      plus their rendered ancestors

    The outline for a given (graph, shortlist) is byte-stable: it is both a
    cache-key input and a fixture assertion.
    """
    include = _render_set(graph, shortlist)
    lines: list[str] = []

    def walk(id: str, rendered_depth: int) -> None:
        node = graph.get(id)
        rendered = id in include
        if rendered:
            fields = [clean_text(node_field(node, f)) for f in graph.descriptor_for(id)]
            fields = [s for s in fields if s]
            lines.append(f"{'  ' * rendered_depth}{id}: {' — '.join(fields)}")
        for child in graph.children_of.get(id, []):
            walk(child, rendered_depth + 1 if rendered else rendered_depth)

    walk(graph.root_id, 0)
    return "\n".join(lines)


def _render_set(graph: Graph, shortlist: list[str] | None) -> set[str]:
    """Nodes rendered in the outline: eligible targets plus their eligible ancestors."""

    def eligible(id: str) -> bool:
        n = graph.get(id)
        return n.get("routable") is not False and not graph.is_pruned(id)

    include: set[str] = set()
    if shortlist is None:
        for n in graph.dfs():
            if eligible(n["id"]):
                include.add(n["id"])
        return include
    for id in shortlist:
        if not graph.has(id) or not eligible(id):
            continue
        for anc in graph.path_to(id):
            if eligible(anc["id"]):
                include.add(anc["id"])
    return include


def clean_text(s: str) -> str:
    return _NEWLINE_RUNS.sub(" ", unicodedata.normalize("NFC", s)).strip()


def embed_text(graph: Graph, id: str) -> str:
    """Text indexed by the embedding pre-filter for a node."""
    node = graph.get(id)
    fields = [clean_text(node_field(node, f)) for f in graph.embed_text_fields_for(id)]
    return " — ".join(s for s in fields if s)

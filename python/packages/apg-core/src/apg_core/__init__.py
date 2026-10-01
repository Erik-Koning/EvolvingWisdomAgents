# Adaptive Prompt Graph (APG) kernel — Python runtime.
# Public API mirrors the TypeScript kernel (typescript/packages/core); both
# runtimes pass the identical conformance fixtures in schema/conformance.
from .bring import resolve_bring
from .compose import compose, merge_vars
from .connectors import (
    MapEmbeddings,
    StoreConflictError,
    MemoryAgentStateStore,
    MemoryChangesetStore,
    MemoryGraphStore,
    MemoryLayerStore,
    MemorySessionStore,
    MemoryTranscriptStore,
    ScriptedLlm,
    ScriptedTools,
    bind_connectors,
    count_tokens_fallback,
    register_connector,
)
from .embed import precompute_embeddings
from .evolve import build_split_ops, cluster_by_similarity, cosine_similarity, medoid
from .expr import eval_condition, eval_expr, parse_expr
from .graph import (
    BUDGET_DEFAULT_MAX_TOKENS,
    RESERVED_KEYS,
    ROUTING_DEFAULTS,
    Graph,
    graph_defaults,
    node_field,
    prompt_template,
)
from .lifecycle import (
    add_ops,
    approve_changeset,
    changeset_focus_nodes,
    commit_changeset,
    discard_changeset,
    validate_changeset,
)
from .loader import load_graph, materialize_edges, normalize_document, normalize_node
from .minischema import is_plain_object, mini_validate
from .search import find_nodes, list_property_keys
from .mutation import (
    apply_changeset,
    apply_op,
    bump_version,
    create_changeset,
    deep_merge_into,
    load_with_layers,
    materialize_layers,
    rebase_layer,
    route_cache_key,
)
from .outline import clean_text, embed_text, serialize_outline
from .regress import assert_regression, eval_routing, labeled_from_meta
from .replay_gate import apply_evidence_gate, is_degrading_op, verify_citation
from .router import route
from .session import new_session, session_step
from .validator import detect_required_profile, validate_graph

__all__ = [
    "labeled_from_meta",
    "assert_regression",
    "eval_routing",
    "StoreConflictError",
    "precompute_embeddings",
    "list_property_keys",
    "find_nodes",
    "BUDGET_DEFAULT_MAX_TOKENS",
    "Graph",
    "MapEmbeddings",
    "MemoryAgentStateStore",
    "MemoryChangesetStore",
    "MemoryGraphStore",
    "MemoryLayerStore",
    "MemorySessionStore",
    "MemoryTranscriptStore",
    "RESERVED_KEYS",
    "ROUTING_DEFAULTS",
    "ScriptedLlm",
    "ScriptedTools",
    "add_ops",
    "apply_changeset",
    "apply_evidence_gate",
    "apply_op",
    "approve_changeset",
    "bind_connectors",
    "build_split_ops",
    "bump_version",
    "changeset_focus_nodes",
    "clean_text",
    "cluster_by_similarity",
    "commit_changeset",
    "compose",
    "cosine_similarity",
    "count_tokens_fallback",
    "create_changeset",
    "deep_merge_into",
    "detect_required_profile",
    "discard_changeset",
    "embed_text",
    "eval_condition",
    "eval_expr",
    "graph_defaults",
    "is_degrading_op",
    "is_plain_object",
    "load_graph",
    "load_with_layers",
    "materialize_edges",
    "materialize_layers",
    "medoid",
    "merge_vars",
    "mini_validate",
    "new_session",
    "node_field",
    "normalize_document",
    "normalize_node",
    "parse_expr",
    "prompt_template",
    "rebase_layer",
    "register_connector",
    "resolve_bring",
    "route",
    "route_cache_key",
    "serialize_outline",
    "session_step",
    "validate_changeset",
    "validate_graph",
    "verify_citation",
]

# Shared JSON.stringify-compatible helpers. The TS kernel leans on
# JSON.stringify for rendering non-string values and for structural equality;
# these helpers pin the same behavior for Python (bool vs number distinction,
# integral floats render like JS numbers, no ASCII escaping).
import json
import math
from typing import Any


def _jsify(v: Any) -> Any:
    """Recursively convert integral floats to ints (JS has one number type)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        if math.isfinite(v) and v.is_integer():
            return int(v)
        return v
    if isinstance(v, list):
        return [_jsify(x) for x in v]
    if isinstance(v, dict):
        return {k: _jsify(x) for k, x in v.items()}
    return v


def json_stringify(v: Any) -> str:
    """Match JSON.stringify(v): compact separators, no ASCII escaping."""
    return json.dumps(_jsify(v), separators=(",", ":"), ensure_ascii=False)


def js_str(v: Any) -> str:
    """Match JS String(v) for scalars used by nodeField."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if math.isfinite(v) and v.is_integer():
            return str(int(v))
        return repr(v)
    return str(v)


def deep_equal(a: Any, b: Any) -> bool:
    """JSON-structural equality with JS semantics (bool != number, 3 == 3.0)."""
    return json.dumps(_jsify(a), sort_keys=True, ensure_ascii=False) == json.dumps(
        _jsify(b), sort_keys=True, ensure_ascii=False
    )

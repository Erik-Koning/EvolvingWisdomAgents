# Pinned mini JSON Schema subset used for ActionSpec.resultSchema and
# VariableSpec.schema validation inside the kernel: type / required /
# properties / items / enum / const. Full-document validation lives outside
# the kernel; this subset keeps the two runtimes byte-identical without a
# heavyweight dependency in the hot path.
from typing import Any

from ._json import deep_equal


def mini_validate(value: Any, schema: dict, path: str = "$") -> list[str]:
    errors: list[str] = []
    if "const" in schema:
        if not deep_equal(value, schema["const"]):
            errors.append(f"{path}: not const")
        return errors
    if isinstance(schema.get("enum"), list):
        hit = any(deep_equal(e, value) for e in schema["enum"])
        if not hit:
            errors.append(f"{path}: not in enum")
        return errors
    type_ = schema.get("type")
    if isinstance(type_, str) and not _type_matches(value, type_):
        errors.append(f"{path}: expected {type_}")
        return errors
    if type_ == "object" or (type_ is None and is_plain_object(value)):
        if is_plain_object(value):
            required = schema.get("required")
            for key in required if isinstance(required, list) else []:
                if key not in value:
                    errors.append(f"{path}.{key}: required")
            props = schema.get("properties")
            for key, sub in (props if is_plain_object(props) else {}).items():
                if key in value and is_plain_object(sub):
                    errors.extend(mini_validate(value[key], sub, f"{path}.{key}"))
    if type_ == "array" and isinstance(value, list) and is_plain_object(schema.get("items")):
        for i, item in enumerate(value):
            errors.extend(mini_validate(item, schema["items"], f"{path}[{i}]"))
    return errors


def _type_matches(value: Any, type_: str) -> bool:
    if type_ == "string":
        return isinstance(value, str)
    if type_ == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_ == "integer":
        if isinstance(value, bool):
            return False
        if isinstance(value, int):
            return True
        return isinstance(value, float) and value.is_integer()
    if type_ == "boolean":
        return isinstance(value, bool)
    if type_ == "null":
        return value is None
    if type_ == "object":
        return is_plain_object(value)
    if type_ == "array":
        return isinstance(value, list)
    return True


def is_plain_object(v: Any) -> bool:
    return isinstance(v, dict)

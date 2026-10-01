# Every shipped template must: normalize, pass the semantic validator,
# declare a profile at or above the features it uses, and round-trip stably
# (normalize is idempotent). JSON-Schema validation of templates is covered
# by the TypeScript suite (Ajv); the Python kernel stays stdlib-only.
import json
from pathlib import Path

import pytest

from apg_core import detect_required_profile, normalize_document, validate_graph

TEMPLATES_DIR = Path(__file__).resolve().parents[4] / "templates"
TEMPLATE_FILES = sorted(f.name for f in TEMPLATES_DIR.glob("*.apg.json"))

ORDER = ["L0", "L1", "L2", "L3", "L4", "L5"]


def _load(file: str) -> dict:
    return json.loads((TEMPLATES_DIR / file).read_text(encoding="utf-8"))


@pytest.mark.parametrize("file", TEMPLATE_FILES)
def test_passes_semantic_validation_after_normalization(file: str) -> None:
    report = validate_graph(normalize_document(_load(file)))
    assert report["errors"] == []
    assert report["valid"] is True


@pytest.mark.parametrize("file", TEMPLATE_FILES)
def test_declares_a_profile_covering_its_features(file: str) -> None:
    raw = _load(file)
    required = detect_required_profile(normalize_document(raw))
    assert ORDER.index(required) <= ORDER.index(raw.get("profile") or "L0")


@pytest.mark.parametrize("file", TEMPLATE_FILES)
def test_normalization_is_idempotent(file: str) -> None:
    once = normalize_document(_load(file))
    twice = normalize_document(once)
    assert twice == once

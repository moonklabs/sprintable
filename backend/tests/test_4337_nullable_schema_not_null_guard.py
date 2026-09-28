"""story #4337 AC3 — 요청 스키마 `X | None` × DB 칸 NOT NULL 짝이 새로 생기면 RED.

짝 찾기(손 목록 아님): app/schemas의 Pydantic 모델 중 이름이 `<Model>Create/Update/Patch/Request/In/Body`인 것 × 같은 이름의 ORM 모델 · 이름이 그 모양이
아닌 것은 IRREGULAR_PAIRS에 적는다. 짝의 필드가 `X | None`이고 같은 이름 칸이 NOT NULL이면 둘 중 하나여야 한다:
- 명시 null을 422로 거절한다 — `NOT_NULL_FIELDS`에 적고, 이 테스트가 `{필드: None}`을 실제로 검증해 `null_not_allowed`가 나는지 본다.
- EXCEPTIONS 표(쓰는 경로가 null을 저장까지 보내지 않는 자리 · 이유와 함께). 표의 자리가 더는 짝이 아니면 RED(헛도는 예외 0).
"""
from __future__ import annotations

import importlib
import inspect
import pkgutil
import sys
import types
import typing

import pytest
from pydantic import BaseModel, ValidationError

IRREGULAR_PAIRS: dict[str, str] = {
    # 스키마 이름 → ORM 모델 이름(이름이 <Model>Update 모양이 아닌 요청 스키마).
    "UpdateAgentRun": "AgentRun",
    "UpdateAction": "RetroAction",
}

# (스키마, 필드) → 명시 null이 저장까지 안 가는 이유(쓰는 경로 파일:줄 · 2026-09-26 develop 229721164 기준).
EXCEPTIONS: dict[tuple[str, str], str] = {
    ("DocUpdate", "slug"): "무시 — routers/docs.py가 dump에서 빼고 `is not None`일 때만 적용",
    ("DocUpdate", "slug_locked"): "무시 — routers/docs.py가 dump에서 빼고 `is not None`일 때만 적용",
    ("GoalUpdate", "status"): "422 — routers/goals.py가 현재 상태와 비교해 «/transition을 쓰라»로 거절",
    ("HypothesisCreate", "owner_member_id"): "뜻 있음 — None이면 휴먼 호출자가 주인 · 에이전트는 HUMAN_OWNER_REQUIRED(services/hypothesis.py)",
    ("SprintUpdate", "status"): "무시 — routers/sprints.py가 dump에서 빼고 `is not None`일 때만 전이",
    ("ArtifactNodeIn", "id"): "뜻 있음 — routers/visual_artifacts.py가 `n.id or uuid4()`로 새 id",
}

_SUFFIXES = ("Create", "Update", "Patch", "Request", "In", "Body")


def _load():
    import app.models as M
    import app.schemas as S
    from app.core.database import Base

    for pkg, prefix in ((S, "app.schemas."), (M, "app.models.")):
        for m in pkgutil.walk_packages(pkg.__path__, prefix):
            importlib.import_module(m.name)
    models = {mp.class_.__name__: mp.class_ for mp in Base.registry.mappers}
    schemas: dict[str, type[BaseModel]] = {}
    for modname, mod in list(sys.modules.items()):
        if not modname.startswith("app.schemas."):
            continue
        for name, cls in inspect.getmembers(mod, inspect.isclass):
            if issubclass(cls, BaseModel) and cls.__module__ == modname:
                schemas.setdefault(name, cls)
    return models, schemas


def _is_optional(annotation) -> bool:
    return typing.get_origin(annotation) in (typing.Union, types.UnionType) and type(None) in typing.get_args(annotation)


def _model_for(schema_name: str, models: dict) -> str | None:
    if schema_name in IRREGULAR_PAIRS:
        return IRREGULAR_PAIRS[schema_name]
    for suffix in _SUFFIXES:
        if schema_name.endswith(suffix) and schema_name[: -len(suffix)] in models:
            return schema_name[: -len(suffix)]
    return None


def find_pairs(models, schemas) -> list[tuple[str, str, type[BaseModel]]]:
    """(스키마 이름, 필드, 스키마 클래스) — 스키마 `X | None` × 같은 이름 칸 NOT NULL."""
    out = []
    for name, cls in schemas.items():
        model_name = _model_for(name, models)
        if model_name is None:
            continue
        table = models[model_name].__table__
        for field, info in cls.model_fields.items():
            if field in table.c and not table.c[field].nullable and _is_optional(info.annotation):
                out.append((name, field, cls))
    return sorted(out, key=lambda p: (p[0], p[1]))


def rejects_explicit_null(cls: type[BaseModel], field: str) -> bool:
    """`{field: None}`을 실제로 검증 — 그 필드 자리에 `null_not_allowed`가 나면 True(다른 필수 필드 누락 오류는 무시)."""
    try:
        cls.model_validate({field: None})
    except ValidationError as exc:
        return any(e["type"] == "null_not_allowed" and e["loc"] == (field,) for e in exc.errors())
    return False


@pytest.fixture(scope="module")
def loaded():
    return _load()


def test_irregular_pairs_resolve(loaded):
    models, schemas = loaded
    for schema_name, model_name in IRREGULAR_PAIRS.items():
        assert schema_name in schemas, schema_name
        assert model_name in models, model_name


def test_every_pair_rejects_null_or_is_an_explained_exception(loaded):
    """⭐새 짝(스키마 nullable × 칸 NOT NULL)이 생기면 RED — 422로 거절하거나 예외 표에 이유를 적을 것."""
    models, schemas = loaded
    pairs = find_pairs(models, schemas)
    assert len(pairs) >= 40, f"짝을 실제로 찾았다(헛돌지 않게) — {len(pairs)}"
    open_pairs = [
        f"{name}.{field}" for name, field, cls in pairs
        if (name, field) not in EXCEPTIONS and not rejects_explicit_null(cls, field)
    ]
    assert open_pairs == [], (
        "요청 스키마는 null을 받는데 DB 칸은 NOT NULL — NOT_NULL_FIELDS에 넣어 422로 거절하거나(생략은 그대로 허용) "
        "쓰는 경로가 null을 저장까지 안 보내면 EXCEPTIONS에 이유와 함께: " + ", ".join(open_pairs)
    )


def test_exceptions_are_live_pairs_that_do_not_reject(loaded):
    """예외 표의 자리가 실제 짝이고 · 422로 막히지도 않는다(고쳐졌거나 사라졌으면 표에서 지운다)."""
    models, schemas = loaded
    pairs = {(name, field): cls for name, field, cls in find_pairs(models, schemas)}
    stale = [k for k in EXCEPTIONS if k not in pairs]
    now_rejected = [k for k in EXCEPTIONS if k in pairs and rejects_explicit_null(pairs[k], k[1])]
    assert (stale, now_rejected) == ([], [])


def test_not_null_fields_point_at_not_null_columns(loaded):
    """거꾸로 — NOT_NULL_FIELDS에 적은 필드는 짝의 NOT NULL 칸이다(엉뚱한 이름 · nullable 칸에 걸어 null을 막지 않게)."""
    from app.schemas.not_null_fields import RejectsExplicitNull

    models, schemas = loaded
    pair_keys = {(name, field) for name, field, _ in find_pairs(models, schemas)}
    wrong = [
        f"{name}.{field}" for name, cls in schemas.items()
        if issubclass(cls, RejectsExplicitNull) and cls is not RejectsExplicitNull
        for field in cls.NOT_NULL_FIELDS if (name, field) not in pair_keys
    ]
    assert wrong == []


def test_positive_control_new_pair_is_caught(loaded):
    """양성 대조 — nullable 필드를 가진 가짜 `<Model>Update`를 끼우면 그 짝이 잡힌다."""
    from app.schemas.not_null_fields import RejectsExplicitNull

    models, schemas = loaded

    class MeetingPatch(BaseModel):  # 이름 규칙(<Model>Patch) · title은 NOT NULL 칸
        title: str | None = None

    class MeetingPatchFixed(RejectsExplicitNull):
        NOT_NULL_FIELDS = frozenset({"title"})
        title: str | None = None

    caught = [(n, f) for n, f, c in find_pairs(models, {"MeetingPatch": MeetingPatch}) if not rejects_explicit_null(c, f)]
    assert caught == [("MeetingPatch", "title")]
    assert rejects_explicit_null(MeetingPatchFixed, "title")
    assert MeetingPatchFixed.model_validate({}).title is None  # 생략은 그대로 허용

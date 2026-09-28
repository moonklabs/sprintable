"""story #4330 — 요청 **본문**의 일시 값도 4294(쿼리)와 같은 규칙: 오프셋이 없으면 422 `DATETIME_OFFSET_REQUIRED`.

오프셋 없는 일시는 asyncpg가 앱 프로세스 로컬 시간대로 바꿔 보낸다(맥 = KST · Cloud Run = UTC) — 같은 요청이 환경마다 9시간
다르게 저장된다. 본문 일시 필드는 전부 `OffsetDatetime`(app/core/datetime_query.py) 한 타입으로 모으고, 검증 오류는 `main.py`가
쿼리와 같은 봉투(`param` = 본문 경로 · `hint`)로 바꾼다.

- 가드: 모든 라우트의 본문 모델(중첩 모델 · 목록 포함)에서 `datetime` 필드는 전부 `OffsetDatetime` — 새 필드도 자동으로 걸린다 + 양성대조.
- 실 DB: KST 자정 경계(`2026-09-18T00:00:00+09:00`은 정확히 `2026-09-17T15:00Z`로 저장) · naive는 422 · 다른 검증 오류 모양은 그대로.
"""
from __future__ import annotations

import os
import types
import typing
import uuid
from datetime import UTC, datetime

import pytest
from pydantic import BaseModel
from sqlalchemy import text

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 가드 ────────────────────────────────────────────────────────────────────────────────────────────
def _leaves(ann: typing.Any, checked: bool = False) -> list[tuple[typing.Any, bool]]:
    """(말단 타입, 오프셋 검사가 붙었나). `OffsetDatetime | None`처럼 검사는 합집합 안쪽 `Annotated`에 붙는다."""
    from app.core.datetime_query import _require_offset

    origin = typing.get_origin(ann)
    if origin is typing.Annotated:
        base, *meta = typing.get_args(ann)
        return _leaves(base, checked or any(getattr(m, "func", None) is _require_offset for m in meta))
    if origin in (typing.Union, types.UnionType, list, tuple, set, dict):
        return [leaf for arg in typing.get_args(ann) for leaf in _leaves(arg, checked)]
    return [(ann, checked)]


def naive_datetime_fields(model: type[BaseModel], prefix: str = "", _stack: tuple = ()) -> list[str]:
    """본문 모델에서 `datetime`인데 오프셋 검사(`OffsetDatetime`)가 없는 필드 경로."""
    from app.core.datetime_query import _require_offset

    if model in _stack:
        return []
    out: list[str] = []
    for name, info in model.model_fields.items():
        path = f"{prefix}{info.alias or name}"
        on_field = any(getattr(m, "func", None) is _require_offset for m in info.metadata)
        for leaf, checked in _leaves(info.annotation, on_field):
            if leaf is datetime and not checked:
                out.append(path)
            elif isinstance(leaf, type) and issubclass(leaf, BaseModel):
                out += naive_datetime_fields(leaf, f"{path}.", _stack + (model,))
    return out


def test_every_request_body_datetime_field_requires_an_offset():
    from app.main import app

    bodies = 0
    gaps: list[str] = []
    for route in app.router.routes:
        body = getattr(route, "body_field", None)
        model = body.field_info.annotation if body is not None else None
        if isinstance(model, type) and issubclass(model, BaseModel):
            bodies += 1
            gaps += [f"{sorted(route.methods)} {route.path} {model.__name__}.{f}" for f in naive_datetime_fields(model)]
    assert bodies > 100, "본문 모델을 실제로 훑는지(공허 통과 방지)"
    assert gaps == [], "오프셋 검사 없는 본문 일시 필드 — `OffsetDatetime`으로"


def test_control_plain_and_nested_datetimes_are_caught():
    from app.core.datetime_query import OffsetDatetime

    class Inner(BaseModel):
        at: datetime

    class Outer(BaseModel):
        ok: OffsetDatetime | None = None
        plain: datetime | None = None
        items: list[Inner] = []

    assert naive_datetime_fields(Outer) == ["plain", "items.at"]


# ── 실 DB ──────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_kst_midnight_body_value_is_stored_exactly_and_a_naive_value_is_refused():
    """뮤테이션: `_require_offset`이 naive를 통과시키면 naive가 201로 RED · 핸들러가 기본 처리로 넘기면 봉투 대신 detail 목록이라 RED."""
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from tests.test_e_security_sec_s8_ratchet_round7_activity_logs_stream_realdb import (
        _client_for,
        _session_factory,
        _setup_app,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"b-{user_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
            s.add(om)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member"))
            await s.commit()
        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            base = {"project_id": str(project.id), "org_id": str(org.id)}
            r = await client.post("/api/v2/stories", json={**base, "title": "kst", "measure_after": "2026-09-18T00:00:00+09:00"})
            assert r.status_code in (200, 201), r.text
            story_id = (r.json().get("data") or r.json())["id"]
            async with Session() as s:
                stored = (await s.execute(text("SELECT measure_after FROM stories WHERE id = :id"), {"id": story_id})).scalar_one()
            assert stored == datetime(2026, 9, 17, 15, 0, tzinfo=UTC), "KST 자정 = 전날 15:00Z 정확히"

            r = await client.post("/api/v2/stories", json={**base, "title": "naive", "measure_after": "2026-09-18T00:00:00"},
                                  headers={"Accept-Language": "en"})
            assert r.status_code == 422, r.text
            err = r.json()["error"]
            assert (err["code"], err["param"]) == ("DATETIME_OFFSET_REQUIRED", "measure_after")
            assert "Z" in err["hint"] and "+09:00" in err["hint"]
            assert "Add a timezone offset" in err["message"]

            r = await client.patch(f"/api/v2/stories/{story_id}", json={"title": "x", "expected_updated_at": "2026-09-18T00:00:00"})
            assert r.status_code == 422, r.text
            assert r.json()["error"]["param"] == "expected_updated_at"

            r = await client.post("/api/v2/stories", json={**base, "measure_after": "2026-09-18T00:00:00+09:00"})
            assert r.status_code == 422, r.text
            assert "detail" in r.json() and "error" not in r.json(), "다른 검증 오류(필수 title 없음)는 FastAPI 기본 모양 그대로"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

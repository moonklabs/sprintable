"""story #2274(C-1c) — entity-references-orphan-check cron endpoint 실PG 검증.

⛔#2273 때 이 엔드포인트의 첫 버전은 CI를 전역 401로 깼다 — 원인은 엔드포인트가 아니라
그때 테스트가 `app.routers.cron.CRON_SECRET`을 monkeypatch 없이 직접 대입하고 복원을 안 한
것(#2274 AC1, 재현까지 완료된 원인 규명). 이 파일은 `monkeypatch.setattr`을 써서 pytest가
테스트 종료 시 자동으로 원래 값을 복원하게 한다 — 같은 사고가 재발하지 않는 자리.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_member(session):
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.user import User
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.flush()
    member = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user.id, name="Test Human")
    session.add(member)
    await session.flush()
    return org, project, member


@pytest.mark.anyio
async def test_orphan_check_endpoint_rejects_missing_auth(monkeypatch):
    """AC7 — 다른 cron 엔드포인트와 같은 verify_cron() 게이트를 그대로 쓴다(새 인증 발명 없음).
    ⛔monkeypatch.setattr — 이 테스트가 끝나면 pytest가 자동으로 원래 CRON_SECRET을 복원한다
    (직접 대입+finally 없음 방식이었던 #2273 때의 사고를 구조적으로 재발 불가능하게 만든다)."""
    import app.routers.cron as cron_module
    from app.routers.cron import entity_references_orphan_check
    from fastapi import HTTPException
    from starlette.requests import Request as StarletteRequest

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    request = StarletteRequest(scope={"type": "http", "headers": []})  # 인증 헤더 없음
    with pytest.raises(HTTPException) as exc_info:
        await entity_references_orphan_check(request, session=None)
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_orphan_check_endpoint_calls_count_orphan_types(monkeypatch):
    """⭐AC4 핵심 — cron endpoint가 실제로 count_orphan_types를 호출하는 「도는 자리」임을
    직접 증명한다(라우터 함수를 직접 호출 — HTTP 계층 우회, story #2554 세션에서 확立한
    패턴). ⛔DB가 공유돼(로컬 재사용) 절대값 0을 기대하면 다른 테스트의 잔여 데이터에
    깨지기 쉬우므로, 정상 타입 삽입 **전후 delta**로 증명한다."""
    import app.routers.cron as cron_module
    from app.routers.cron import entity_references_orphan_check
    from app.services.reference_core import insert_reference
    from starlette.requests import Request as StarletteRequest

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            def _request():
                return StarletteRequest(scope={
                    "type": "http", "headers": [(b"authorization", b"Bearer the-real-secret")],
                })

            resp_before = await entity_references_orphan_check(_request(), session=session)
            total_before = json.loads(resp_before.body)["data"]["total"]

            # registry에 있는 정상 타입만 하나 심는다 — orphan이 아닌 것.
            await insert_reference(
                session, org_id=org.id, source_type="story", source_field="description",
                source_id=uuid.uuid4(), target_type="doc", target_id=uuid.uuid4(),
                form="mention", created_by=member.id,
            )
            await session.commit()

            resp_after = await entity_references_orphan_check(_request(), session=session)
            body_after = json.loads(resp_after.body)
            assert body_after["data"]["total"] == total_before, (
                f"정상 타입 삽입인데 orphan 총계가 늘었다({total_before} → "
                f"{body_after['data']['total']}) — orphans={body_after['data']['orphans']}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_orphan_check_endpoint_flags_real_orphan(monkeypatch):
    """⭐AC5 기준선 — registry 밖 타입이 실제로 있으면 total이 그만큼 늘어나는 것(정상은
    0이지만, 0이 아닐 수 있다는 것도 같이 증명 — «항상 0을 반환하는 죽은 코드»가 아님을
    보인다)."""
    import app.routers.cron as cron_module
    from app.routers.cron import entity_references_orphan_check
    from app.models.reference import Reference
    from starlette.requests import Request as StarletteRequest

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            def _request():
                return StarletteRequest(scope={
                    "type": "http", "headers": [(b"authorization", b"Bearer the-real-secret")],
                })

            resp_before = await entity_references_orphan_check(_request(), session=session)
            body_before = json.loads(resp_before.body)
            total_before = body_before["data"]["total"]
            orphan_key_before = body_before["data"]["orphans"].get("target:definitely_not_registered", 0)

            session.add(Reference(
                id=uuid.uuid4(), org_id=org.id, source_type="story", source_field="description",
                source_id=uuid.uuid4(), target_type="definitely_not_registered",
                target_id=uuid.uuid4(), form="mention", created_by=member.id,
            ))
            await session.commit()

            resp_after = await entity_references_orphan_check(_request(), session=session)
            body_after = json.loads(resp_after.body)
            assert body_after["data"]["total"] == total_before + 1
            assert body_after["data"]["orphans"].get("target:definitely_not_registered") == orphan_key_before + 1
    finally:
        await engine.dispose()

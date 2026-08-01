"""story #2277(E-CONNECT) — 「이것을 가리키는 것이 0건」 감사, ㉠「도는 자리」 실PG 검증.

AC1: target_type은 #2266이 세운 `BACKLINKS_ALLOWED_TARGET_TYPES`(doc·story)와 같은 허용목록.
AC2: 도는 자리 — cron endpoint(#2274 패턴 그대로, verify_cron·read-only). ⛔이 cron 자체엔
  AC5(권한)를 안 붙인다 — PO 판정(2026-07-29): cron엔 「보는 사람」이 없어 권한 축이 안 선다.
AC2 후속(PO 정정, 2026-07-29 dev 실측 후): 표·노출층은 **짓지 않는다**. dev 실측
  doc 871/883·story 2497/2512가 zero_referenced였으나 `entity_references` 총행수가 62뿐이라
  — 이 수는 「고아」가 아니라 「참조추적 자체가 아직 안 돈 것」(분모미채움)이다. 표를 지으면
  2497건이 「고아」로 보여 거짓 지표가 선다. AC2는 「지금은 없다」로 명시하고 닫는다 — 만료
  조건: `entity_references` 총행수가 일감 수(story_number 총량) 대비 유의미해질 때(예:
  1/10 초과) 이 수가 비로소 「고아」를 뜻하기 시작하고, 그때 표·노출층을 짓는다.
AC3: ⛔문안은 디디가 세운 것 글자 그대로 — "관찰된 참조 0건(수집범위: mention/embed,
  source=chat_message·doc만 — PR/커밋/증거자유텍스트는 미수집이라 이 수에 없음)".
  ⛔PO 추가지적: 응답·로그에 **분모**(`entity_references_total`)를 zero_referenced/total과
  항상 같이 싣는다 — 안 그러면 다음 사람이 절대값(예 "2497")을 「고아 2497건」으로 오독한다.
AC6: 이 파일의 delta-based 측정 + 뮤테이션 자가검증이 「돈다」의 증거(#2274 선례 그대로 —
  PO 확認: 실PG 통합테스트+뮤테이션 자가검증=충분, 라이브 GCP 트리거는 불필요. 실제 dev DB
  수치는 `sprintable-verify-oneoff` Cloud Run job 재실행으로 별도 확認 완료 — CRON_SECRET
  불필요).

이 파일은 #2274의 test_2274_cron_orphan_check_realdb.py와 동형 패턴(공유 DB라 절대값 0을
기대하지 않고 delta로 증명 · monkeypatch.setattr로 CRON_SECRET 자동복원 · 라우터 함수 직접
호출로 HTTP 계층 우회)을 그대로 따른다(재구현 0).
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


async def _make_doc(session, org_id, project_id, title="Doc"):
    from app.models.doc import Doc
    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.flush()
    return doc


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.flush()
    return story


def _request():
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={
        "type": "http", "headers": [(b"authorization", b"Bearer the-real-secret")],
    })


@pytest.mark.anyio
async def test_zero_referenced_check_endpoint_rejects_missing_auth(monkeypatch):
    """AC2 — 다른 cron 엔드포인트와 같은 verify_cron() 게이트(새 인증 발명 없음)."""
    import app.routers.cron as cron_module
    from app.routers.cron import zero_referenced_entities_check
    from fastapi import HTTPException
    from starlette.requests import Request as StarletteRequest

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    request = StarletteRequest(scope={"type": "http", "headers": []})
    with pytest.raises(HTTPException) as exc_info:
        await zero_referenced_entities_check(request, session=None)
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_zero_referenced_check_counts_unreferenced_doc_and_story(monkeypatch):
    """⭐AC1/AC4 핵심 — 참조가 0건인 doc·story가 정확히 카운트되는지 delta로 증명한다
    (공유 DB라 절대값 0 가정 안 함 — #2274 패턴)."""
    import app.routers.cron as cron_module
    from app.routers.cron import zero_referenced_entities_check

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            resp_before = await zero_referenced_entities_check(_request(), session=session)
            body_before = json.loads(resp_before.body)
            doc_before = body_before["data"]["zero_referenced"]["doc"]
            story_before = body_before["data"]["zero_referenced"]["story"]

            await _make_doc(session, org.id, project.id, title="Unreferenced Doc")
            await _make_story(session, org.id, project.id, title="Unreferenced Story")
            await session.commit()

            resp_after = await zero_referenced_entities_check(_request(), session=session)
            body_after = json.loads(resp_after.body)
            assert body_after["data"]["zero_referenced"]["doc"] == doc_before + 1
            assert body_after["data"]["zero_referenced"]["story"] == story_before + 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_zero_referenced_check_excludes_referenced_doc():
    """⭐뮤테이션 대응 축 — 참조가 «있는» doc은 zero_referenced에 안 잡혀야 한다(항상
    +1되는 죽은 카운터가 아님을 증명 — #2274의 「real orphan 잡기」테스트와 동형 목적)."""
    from app.routers.cron import zero_referenced_entities_check
    from app.services.reference_core import insert_reference
    import app.routers.cron as cron_module

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            resp_before = await zero_referenced_entities_check(_request(), session=session)
            doc_before = json.loads(resp_before.body)["data"]["zero_referenced"]["doc"]

            referenced_doc = await _make_doc(session, org.id, project.id, title="Referenced Doc")
            unreferenced_doc = await _make_doc(session, org.id, project.id, title="Unreferenced Doc")
            await session.commit()

            await insert_reference(
                session, org_id=org.id, source_type="story", source_field="description",
                source_id=uuid.uuid4(), target_type="doc", target_id=referenced_doc.id,
                form="mention", created_by=member.id,
            )
            await session.commit()

            resp_after = await zero_referenced_entities_check(_request(), session=session)
            doc_after = json.loads(resp_after.body)["data"]["zero_referenced"]["doc"]
            assert doc_after == doc_before + 1, (
                f"referenced_doc은 안 잡히고 unreferenced_doc({unreferenced_doc.id}) 하나만 "
                f"늘어야 한다(before={doc_before}, after={doc_after})"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_zero_referenced_check_response_carries_ac3_exact_wording():
    """⛔AC3 — 디디가 세운 정확한 문안을 응답에 그대로 싣는다. bare 「출처 없음」·「참조 없음」은
    금지(미수집을 「없음」으로 표시하면 거짓이라는 게 AC3의 핵심)."""
    from app.routers.cron import zero_referenced_entities_check

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            resp = await zero_referenced_entities_check(_request(), session=session)
            body = json.loads(resp.body)
            assert body["data"]["caveat"] == (
                "관찰된 참조 0건(수집범위: mention/embed, source=chat_message·doc만 — "
                "PR/커밋/증거자유텍스트는 미수집이라 이 수에 없음)"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_zero_referenced_check_response_always_carries_denominator():
    """⛔PO 정정(2026-07-29, dev 실측 후) — zero_referenced/total 절대값만 실으면 다음
    사람이 「고아 수」로 오독한다(실측: doc 871/883·story 2497/2512인데 entity_references
    총행수가 62뿐이라 실은 「참조추적이 아직 안 돈 것」이었다). 응답에 `entity_references_total`
    이 항상 같이 실려 있어야 이 오독을 구조적으로 막는다."""
    from app.routers.cron import zero_referenced_entities_check

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            resp = await zero_referenced_entities_check(_request(), session=session)
            body = json.loads(resp.body)
            assert "entity_references_total" in body["data"]
            assert isinstance(body["data"]["entity_references_total"], int)
    finally:
        await engine.dispose()

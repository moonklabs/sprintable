"""story #2923(P0-E AQ1) 카디르 QA HIGH1(PR#3352, 2026-08-22): InboxRepository.list()에
project_id 필터가 없어 같은 member가 소속된 다른 프로젝트의 inbox 항목까지 섞여 나왔다
(Attention Queue 7개 cap을 무관 항목이 잠식). 이 테스트는 실 PG WHERE절이 project_id로
정확히 걸러지는지 — 목(mock) 아닌 실 SQL 레벨로 고정한다.

project_id는 InboxItem 모델에서 nullable=False + 양쪽 생성 경로(createInboxItemSchema·
incomingInboxItemSchema)에서 필수라 NULL 행이 존재할 수 없다(전체 쓰기경로 코드감사로 확인
— 이 환경엔 라이브 DB 조회 권한이 없어 "실측"은 이 감사+아래 실 PG 테스트로 갈음한다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


async def _seed(session):
    """org(project_a, project_b) + 같은 member가 project_a·project_b 양쪽에 pending inbox
    항목을 하나씩 보유(같은 assignee_member_id — 두 프로젝트 모두에 참여하는 실사용자 패턴)."""
    from app.models.notification import InboxItem
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    member_id = uuid.uuid4()

    item_a = InboxItem(
        id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, assignee_member_id=member_id,
        kind="approval", title="Project A 결재 요청", origin_chain=[], options=[],
        priority="normal", state="pending", source_type="webhook", source_id=f"a-{uuid.uuid4().hex[:8]}",
        waiting_since=datetime.now(timezone.utc), created_at=datetime.now(timezone.utc),
    )
    item_b = InboxItem(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, assignee_member_id=member_id,
        kind="approval", title="Project B 결재 요청", origin_chain=[], options=[],
        priority="normal", state="pending", source_type="webhook", source_id=f"b-{uuid.uuid4().hex[:8]}",
        waiting_since=datetime.now(timezone.utc), created_at=datetime.now(timezone.utc),
    )
    session.add_all([item_a, item_b])
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "member_id": member_id, "item_a_id": item_a.id, "item_b_id": item_b.id,
    }


@pytest.mark.anyio
async def test_inbox_list_scoped_to_project_excludes_other_project_items():
    """카디르 QA HIGH1 회귀가드 — project_a로 조회하면 project_b 항목이 절대 안 섞인다."""
    from app.repositories.notification import InboxRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async with Session() as s:
            repo = InboxRepository(s, seeded["org_id"])
            items_a = await repo.list(assignee_member_id=seeded["member_id"], project_id=seeded["project_a_id"])

        ids = {i.id for i in items_a}
        assert seeded["item_a_id"] in ids
        assert seeded["item_b_id"] not in ids
        assert len(items_a) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_inbox_list_project_b_excludes_project_a_items():
    """대칭 확인 — project_b로 조회해도 project_a 항목이 안 섞인다(한쪽만 우연히 맞는 걸 배제)."""
    from app.repositories.notification import InboxRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async with Session() as s:
            repo = InboxRepository(s, seeded["org_id"])
            items_b = await repo.list(assignee_member_id=seeded["member_id"], project_id=seeded["project_b_id"])

        ids = {i.id for i in items_b}
        assert seeded["item_b_id"] in ids
        assert seeded["item_a_id"] not in ids
        assert len(items_b) == 1
    finally:
        await engine.dispose()

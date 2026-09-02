"""story #3287([도메인탈고정·축1 Phase1] org 표시 라벨 레이어) — 실 PG 검증.

AC1: 마이그가 org_domain_label만 additive로 만들고, 기존 status/entity-type 저장 컬럼(예:
stories.status)은 손 안 댐 — 마이그레이션 실행 자체가 아니라(그건 alembic upgrade가 별도로
검증) 여기서는 "이 테이블이 다른 어떤 테이블에도 FK/컬럼 추가를 안 한다"를 스키마 introspect
로 고정.

AC3: workflow_violation.check_transition()이 org_domain_label에 라벨 오버라이드가 실제로
있는 org에서도(=행이 실존) 오버라이드 없는 경우와 정확히 동일한 결과를 낸다 — "기존 로직이
이 테이블의 존재를 모른다"는 설계 주장을 실 DB 행으로 실증(mock이 아니라 실제로 심은 행)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.domain_label import OrgDomainLabel

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        # 이 테이블만 additive로 세운다(FK 0 — 다른 테이블 무접촉이 설계 자체의 일부).
        await conn.run_sync(OrgDomainLabel.metadata.create_all, tables=[OrgDomainLabel.__table__])
        # create_all은 모델에 선언 안 된 부분 유니크 인덱스를 안 만든다(hitl_gate_config와
        # 동일 관례 — 인덱스는 마이그레이션 전용, migration 0296과 정확히 같은 DDL을 여기서도
        # 실행해야 on_conflict_do_update의 conflict target이 실제로 존재한다).
        await conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_org_domain_label_org_default "
                "ON org_domain_label (org_id, domain, canonical_slug) WHERE project_id IS NULL"
            )
        )
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.anyio
async def test_org_domain_label_table_has_no_foreign_keys():
    """⭐AC1 pin — 이 테이블은 다른 어떤 테이블에도 FK로 안 묶인다(완전 additive, 기존
    status/entity-type 컬럼을 건드릴 방법 자체가 구조적으로 없음을 스키마로 고정)."""
    from app.models.domain_label import OrgDomainLabel

    assert list(OrgDomainLabel.__table__.foreign_keys) == []


@pytest.mark.anyio
async def test_check_transition_identical_with_and_without_label_override():
    """⭐AC3 핵심 pin — 실 org_domain_label 행이 존재해도 workflow_violation.check_transition
    은 canonical status 문자열만 보고 판정하며, 라벨 오버라이드 유무와 무관하게 결과가
    동일하다(그 함수가 이 테이블을 아예 import조차 안 한다는 설계 주장의 실측 증거)."""
    from app.services import workflow_violation
    from app.services.domain_label import set_org_domain_label

    engine, Session = await _session_factory()
    try:
        org_id = uuid.uuid4()

        # 오버라이드 없는 기준선.
        baseline = workflow_violation.check_transition("backlog", "done")

        # 실제로 org_domain_label 행을 심는다(mock 아님) — backlog→"아이디어" 라벨 오버라이드.
        async with Session() as s:
            await set_org_domain_label(
                s, org_id=org_id, domain="status", canonical_slug="backlog",
                label_ko="아이디어", label_en="Idea", created_by=uuid.uuid4(),
            )
            await s.commit()

        # 오버라이드가 실존하는 상태에서 같은 전이를 다시 판정 — canonical 값("backlog","done")
        # 자체는 안 바뀌었으므로 workflow_violation은 이 오버라이드 존재를 몰라야 한다.
        after_override = workflow_violation.check_transition("backlog", "done")

        assert after_override == baseline
        assert after_override.violated is True  # 2단계 이상 건너뛰는 전진 — 원래도 위반.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_set_and_list_and_delete_roundtrip_against_real_pg():
    """서비스 레이어 CRUD가 실 PG의 부분 유니크 인덱스(uq_org_domain_label_org_default)를
    conflict target으로 실제로 upsert하는지 — 목 세션으로는 이 인덱스 존재 자체를 못 잡는다."""
    from app.services.domain_label import (
        delete_org_domain_label,
        list_org_domain_labels,
        set_org_domain_label,
    )

    engine, Session = await _session_factory()
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await set_org_domain_label(
                s, org_id=org_id, domain="entity_type", canonical_slug="story",
                label_ko="캠페인", label_en="Campaign", created_by=uuid.uuid4(),
            )
            await s.commit()

            rows = await list_org_domain_labels(s, org_id=org_id)
            assert len(rows) == 1
            assert rows[0].label_ko == "캠페인"

            # 같은 (org, domain, slug)에 재-PUT — upsert(새 행 추가 아니라 갱신).
            await set_org_domain_label(
                s, org_id=org_id, domain="entity_type", canonical_slug="story",
                label_ko="이니셔티브", label_en="Initiative", created_by=uuid.uuid4(),
            )
            await s.commit()

            rows = await list_org_domain_labels(s, org_id=org_id)
            assert len(rows) == 1  # 여전히 1행(upsert 확인 — 중복 insert 아님)
            assert rows[0].label_ko == "이니셔티브"

            deleted = await delete_org_domain_label(s, org_id=org_id, domain="entity_type", canonical_slug="story")
            await s.commit()
            assert deleted is True

            rows = await list_org_domain_labels(s, org_id=org_id)
            assert rows == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_put_does_not_500_on_unique_violation():
    """⭐TOCTOU pin — 동일 (org, domain, slug)에 대한 두 "동시" PUT이 SELECT-then-INSERT였다면
    부분 유니크 위반 500이 났을 시나리오. on_conflict_do_update가 실제로 그 레이스를 흡수하는지
    순차 재현(진짜 동시성은 아니지만 같은 conflict-target 경로를 두 번 타는 것으로 검증)."""
    from app.services.domain_label import set_org_domain_label

    engine, Session = await _session_factory()
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            r1 = await set_org_domain_label(
                s, org_id=org_id, domain="status", canonical_slug="done",
                label_ko="완료", label_en="Done", created_by=uuid.uuid4(),
            )
            r2 = await set_org_domain_label(
                s, org_id=org_id, domain="status", canonical_slug="done",
                label_ko="완료됨", label_en="Completed", created_by=uuid.uuid4(),
            )
            await s.commit()
        assert r1.id == r2.id  # 같은 행(축당 1행) — 새 INSERT가 아니라 UPDATE였다.
        assert r2.label_ko == "완료됨"
    finally:
        await engine.dispose()

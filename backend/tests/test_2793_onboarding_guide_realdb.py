"""story #2793(2790 P2) — GET /api/v2/events/onboarding-guide realdb 검증. fresh migrated
DB(story #2792 P1의 preset.workflow.* 컴파일 결과가 이미 실려 있음, 0260) 기준. DB env
없으면 skip(CI alembic-fresh 잡에서 실행)."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_onboarding_guide_includes_stage_metadata_role_action():
    """사이클형 프리셋(preset.workflow.scrum_3step, story #2792 P1 컴파일)의 stage_metadata
    role/action이 가이드 텍스트에 실제로 등장 — "기대 행동" 공란 결함ⓑ가 이 respec으로
    실제 닫혔는지 종단 확인."""
    from app.routers.events import get_onboarding_guide
    from app.dependencies.auth import AuthContext

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO organizations (id,name,slug,plan) VALUES (:id,'GuideOrg',:slug,'free')"
            ), {"id": str(org_id), "slug": f"guideorg-{org_id.hex[:8]}"})
            await s.commit()

        async with Session() as s:
            result = await get_onboarding_guide(db=s, org_id=org_id)

        assert result.event_count > 0
        assert "한 번에 한 단계만" in result.philosophy  # 카드 서두 철학 — 한 번에 한 행동
        # scrum_3step의 실 stage_metadata(story #2792 0260) — role=PO, action="기능 명세 및 AC 작성".
        assert "3단계 스크럼" in result.guide
        assert "PO" in result.guide
        assert "기능 명세 및 AC 작성" in result.guide
        assert "kickoff" in result.guide
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_onboarding_guide_excludes_disabled_definitions():
    """⭐결정적 축 — disabled 정의는 가이드에서 빠져야 한다(list_event_definitions는
    admin 감사용이라 disabled도 보여주지만, 이건 "지금 뭘 할 수 있는지"라 다르다).
    signal형 프리셋 하나를 org 스코프로 비활성화해 실제로 사라지는지 확인."""
    from app.routers.events import get_onboarding_guide

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO organizations (id,name,slug,plan) VALUES (:id,'DisableOrg',:slug,'free')"
            ), {"id": str(org_id), "slug": f"disorg-{org_id.hex[:8]}"})
            await s.commit()

            before = await get_onboarding_guide(db=s, org_id=org_id)
            assert "칸반 심플" in before.guide  # preset.workflow.kanban_simple, 활성 상태

            # org 스코프 커스텀 오버라이드가 아니라 — 여기선 간단히 프리셋 자체를 org
            # 컨텍스트 밖에서 직접 비활성화(실 운영에선 #2636 org override가 이 축을 맡음,
            # 이 테스트는 순수 enabled 필터링 자체만 본다).
            await s.execute(text(
                "UPDATE event_definitions SET enabled = false WHERE key = 'preset.workflow.kanban_simple'"
            ))
            await s.commit()

            after = await get_onboarding_guide(db=s, org_id=org_id)
        assert "칸반 심플" not in after.guide
        assert after.event_count == before.event_count - 1
    finally:
        # 원복(다른 테스트가 같은 DB를 계속 쓸 수 있으므로 프리셋 상태를 되돌린다).
        async with Session() as s:
            await s.execute(text(
                "UPDATE event_definitions SET enabled = true WHERE key = 'preset.workflow.kanban_simple'"
            ))
            await s.commit()
        await engine.dispose()

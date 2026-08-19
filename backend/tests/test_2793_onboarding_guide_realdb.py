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


@pytest.mark.anyio
async def test_onboarding_guide_isolates_malformed_stage_metadata_instead_of_500ing():
    """⭐카디르군 QA 실재현(2026-08-19) — 정의 1건의 stage_metadata가 malformed(값이 dict가
    아님)여도 그 org 온보딩 가이드 전체가 안 죽는다. 쓰기 시점 가드(validate_stage_metadata)
    를 우회해 DB에 직접 malformed 값을 심어(레거시/경합 시뮬레이션) 렌더러의 방어 격리
    자체를 검증 — 다른 정의(프리셋 등)는 정상 렌더되고, 오염된 정의만 조용히 빠진다."""
    from app.routers.events import get_onboarding_guide

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO organizations (id,name,slug,plan) VALUES (:id,'MalformedOrg',:slug,'free')"
            ), {"id": str(org_id), "slug": f"malorg-{org_id.hex[:8]}"})
            await s.commit()

            # validate_stage_metadata를 거치지 않고(raw UPDATE) preset.workflow.solo의
            # stage_metadata를 malformed하게 오염 — "쓰기 시점 가드를 어떻게든 우회한
            # 레거시 데이터"를 시뮬레이션(렌더러는 이런 데이터가 와도 안전해야 함).
            await s.execute(text(
                "UPDATE event_definitions SET stage_metadata = "
                "'{\"assign_step_1\": \"이건 dict가 아니라 string\"}'::jsonb "
                "WHERE key = 'preset.workflow.solo'"
            ))
            await s.commit()

            # 500(예외)이 아니라 정상 응답이어야 한다 — 이게 이 테스트의 핵심 단언.
            result = await get_onboarding_guide(db=s, org_id=org_id)

        assert "Solo" not in result.guide or "assign_step_1" not in result.guide  # 오염된 정의는 빠짐
        # 나머지(프리셋·다른 컴파일 정의)는 정상 생존 — 폭발 반경이 1건으로 격리됐는지 확인.
        assert "게이트 판정" in result.guide
        assert "3단계 스크럼" in result.guide
        assert "PO" in result.guide
    finally:
        async with Session() as s:
            await s.execute(text(
                "UPDATE event_definitions SET stage_metadata = "
                "'{\"assign_step_1\": {\"role\": \"Worker\", \"action\": \"담당자 배정\"}}'::jsonb "
                "WHERE key = 'preset.workflow.solo'"
            ))
            await s.commit()
        await engine.dispose()

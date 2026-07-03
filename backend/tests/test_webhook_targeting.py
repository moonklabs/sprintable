"""E-EVENT-1CONFIG: active_webhook_member_ids 공용 SSOT 가드.

이중수신 박멸의 단일 진실원. member-bound(project-독립) 활성 webhook 보유 멤버만 반환하고,
입력 None 필터·fail-open(조회 실패=빈 집합=스킵 0)을 결정적으로 가드한다.

예측 semantics(project-독립·broadcast 제외·org 격리)는 실DB 가드(아래 _requires_db)에서 검증.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.webhook_targeting import active_webhook_member_ids


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalars_result(member_ids: list[uuid.UUID]) -> MagicMock:
    """select(WebhookConfig.member_id) → scalars().all() 결과 mock."""
    result = MagicMock()
    result.scalars.return_value.all.return_value = member_ids
    return result


@pytest.mark.anyio
async def test_empty_member_ids_short_circuits_no_db():
    """빈 입력 → DB 조회 없이 빈 집합."""
    db = AsyncMock()
    db.execute = AsyncMock()
    out = await active_webhook_member_ids(db, uuid.uuid4(), [])
    assert out == set()
    db.execute.assert_not_called()


@pytest.mark.anyio
async def test_only_none_member_ids_short_circuits():
    """None만 들어오면(예: 익명/미해소) DB 조회 없이 빈 집합 — None 필터."""
    db = AsyncMock()
    db.execute = AsyncMock()
    out = await active_webhook_member_ids(db, uuid.uuid4(), [None, None])
    assert out == set()
    db.execute.assert_not_called()


@pytest.mark.anyio
async def test_returns_members_with_active_member_bound_webhook():
    """member-bound 활성 webhook 보유 멤버만 반환."""
    covered = uuid.uuid4()
    uncovered = uuid.uuid4()
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalars_result([covered]))
    out = await active_webhook_member_ids(db, uuid.uuid4(), [covered, uncovered])
    assert out == {covered}


@pytest.mark.anyio
async def test_fail_open_on_db_error_returns_empty():
    """조회 실패 → 빈 집합(아무도 스킵 안 함). webhook 판정 실패가 SSE 전달을 막지 않는다."""
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=RuntimeError("boom"))
    out = await active_webhook_member_ids(db, uuid.uuid4(), [uuid.uuid4()])
    assert out == set()


@pytest.mark.anyio
async def test_none_filtered_but_real_ids_still_queried():
    """None 섞여 있어도 실 멤버는 정상 조회(None만 제거)."""
    real = uuid.uuid4()
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalars_result([real]))
    out = await active_webhook_member_ids(db, uuid.uuid4(), [None, real])
    assert out == {real}
    db.execute.assert_called_once()


# ─── 실DB 예측 semantics 가드 (project-독립·broadcast 제외·org 격리) ──────────────

_ASYNCPG_URL = (
    os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    or None
)
_requires_db = pytest.mark.skipif(
    not _ASYNCPG_URL, reason="DATABASE_URL not set — real DB test skipped"
)


@_requires_db
@pytest.mark.xfail(
    strict=False,
    reason="story 18eefc31 — 원 xfail 사유(order-dependent, 배치별 asyncio loop RuntimeError)는 "
    "test_event1config_webhook_targets.py::test_resolve_predicate_realdb 와 동일 근본원인(공유 "
    "singleton `app.core.database.async_session_factory` 를 pytest-asyncio 함수-스코프 루프에서 "
    "사용)이라 동일 수정(테스트 전용 엔진+dispose)으로 해결했으나, 그 뒤에 남는 두 번째 에러 "
    "(webhook_configs.member_id NotNullViolation, broadcast 행 member_id=None 시드)는 별개의 "
    "이미-에스컬된 product 버그다 — §AC2 project-wide broadcast webhook 은 member_id NOT NULL "
    "제약 때문에 100% 도달 불가 dead code(follow-up story 34b3a8fb 에서 폐기 vs 복구 결정 대기). "
    "그 story 의 결정·구현 완료 後 이 xfail 도 함께 해소. story 18eefc31 트래킹.",
)
@pytest.mark.anyio
async def test_predicate_semantics_realdb():
    """실DB: member-bound는 project 독립으로 covered, broadcast(null)은 제외, 타 org 격리."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.webhook_config import WebhookConfig

    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    proj_x, proj_y = uuid.uuid4(), uuid.uuid4()
    agent_member_proj = uuid.uuid4()   # webhook이 proj_x 스코프인 member-bound
    agent_broadcast_only = uuid.uuid4()  # 자기 webhook 없음, broadcast만 존재
    agent_cross_org = uuid.uuid4()     # 타 org webhook
    agent_inactive = uuid.uuid4()      # is_active=False

    # story 18eefc31: 테스트 전용 엔진(+dispose) — 프로덕션 전역 싱글턴 대신
    # (다른 realdb 테스트와 동일 관례, "attached to a different loop" 방지).
    engine = create_async_engine(_ASYNCPG_URL.replace("postgresql://", "postgresql+asyncpg://"))
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as db:
            db.add_all([
                WebhookConfig(id=uuid.uuid4(), org_id=org_a, project_id=proj_x,
                              member_id=agent_member_proj, url="https://h/1", is_active=True),
                WebhookConfig(id=uuid.uuid4(), org_id=org_a, project_id=proj_x,
                              member_id=None, url="https://h/bcast", is_active=True),
                WebhookConfig(id=uuid.uuid4(), org_id=org_b, project_id=proj_y,
                              member_id=agent_cross_org, url="https://h/2", is_active=True),
                WebhookConfig(id=uuid.uuid4(), org_id=org_a, project_id=proj_x,
                              member_id=agent_inactive, url="https://h/3", is_active=False),
            ])
            await db.commit()
            try:
                # org_a 기준 조회: proj_y 대화여도 member-bound는 project 독립으로 covered.
                out = await active_webhook_member_ids(
                    db, org_a,
                    [agent_member_proj, agent_broadcast_only, agent_cross_org, agent_inactive],
                )
                assert agent_member_proj in out, "member-bound는 project 독립으로 covered"
                assert agent_broadcast_only not in out, "broadcast(null)은 멤버 커버 아님 — 제외"
                assert agent_cross_org not in out, "타 org webhook 격리"
                assert agent_inactive not in out, "비활성 webhook 제외"
            finally:
                for mid in (agent_member_proj, agent_cross_org, agent_inactive):
                    await db.execute(
                        WebhookConfig.__table__.delete().where(WebhookConfig.member_id == mid)
                    )
                await db.execute(
                    WebhookConfig.__table__.delete().where(
                        WebhookConfig.org_id.in_([org_a, org_b]),
                        WebhookConfig.member_id.is_(None),
                    )
                )
                await db.commit()
    finally:
        await engine.dispose()

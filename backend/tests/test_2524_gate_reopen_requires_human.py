"""story #2524([조사·게이트], low) — `_reopen_rejected_gate`가 재오픈 時 requires_human을
갱신하지 않던 결함(codex 지적·#2520 QA 파생).

그라운딩(디디, 2026-08-08): AC1(non-merge gate_type이 실제로 reopen되는 경로가 있는가) —
`gate_type="qa"`가 `_ALWAYS_MANUAL_GATE_TYPES`(doc_approval·loop_decision·artifact_canonicalize,
disposition 무관 항상 pending 강제)에 없어 disposition=deny 時 status="rejected"로 창설될 수
있고, `stories.py`(POST .../verify-request)가 명시적으로 "재요청 시 기존 pending 재사용,
rejected는 자동 재오픈"이라 create_gate()를 같은 work_item에 재호출하는 실 경로다 — 0이 아니다.

AC2 재현: qa 게이트를 disposition=deny(status=rejected→requires_human=False, create_gate
창설 시 규칙대로)로 만든 뒤, 그 사이 조직 정책이 ask로 바뀐 상태에서 재요청 — 재오픈이
status를 pending으로 올리는데 requires_human은 여전히 False로 남는다(수정 前).

AC3: `_reopen_rejected_gate`가 new_status 계산 직후 `gate.requires_human = (new_status ==
"pending")`을 직접 재기록(merge-type의 evaluate_merge_gate와 동일 chokepoint 원칙)."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
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
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_and_story(session):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Gate reopen target")
    session.add(story)
    await session.commit()

    return {"org_id": org.id, "story_id": story.id}


@pytest.mark.anyio
async def test_reopen_rejected_qa_gate_refreshes_requires_human_to_true_realdb():
    """⭐본체 — deny 정책으로 rejected(requires_human=False)로 창설된 qa 게이트가, 그 사이
    정책이 ask로 바뀐 뒤 재요청(create_gate 재호출)되면 status=pending과 함께
    requires_human도 True로 갱신돼야 한다(수정 前엔 False로 고정돼 「사람 승인 필요한데
    안 필요로 표기」됐다)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_and_story(s)
            member_id, role_id = uuid.uuid4(), uuid.uuid4()

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("deny", "org_policy")),
            ):
                gate = await create_gate(
                    s, seeded["org_id"], seeded["story_id"], "story", "qa", member_id, role_id,
                )
                await s.commit()

            assert gate.status == "rejected"
            assert gate.requires_human is False, "deny 창설 직후엔 False가 맞다(사람이 볼 게 없음)"

            # 그 사이 조직이 정책을 ask로 완화 — 재요청(같은 work_item, create_gate 재호출).
            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("ask", "org_policy")),
            ):
                reopened = await create_gate(
                    s, seeded["org_id"], seeded["story_id"], "story", "qa", member_id, role_id,
                )
                await s.commit()

            assert reopened.id == gate.id, "재오픈은 같은 row 재사용(신규 row 생성 안 함)"
            assert reopened.status == "pending"
            assert reopened.requires_human is True, (
                "status=pending인데 requires_human=False로 남음 — #2524 미수복"
                "(사람 승인 필요한데 인박스에 안 뜬다)"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_still_rejected_when_policy_unchanged_requires_human_stays_false_realdb():
    """회귀 0 — 정책이 여전히 deny면 재오픈해도 다시 rejected로 떨어지고(#2150 AC③ 그대로),
    requires_human도 False 그대로 유지돼야 한다(멀쩡한 rejected를 이 수정이 잘못 True로
    뒤집으면 그것도 다른 방향의 결함)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_and_story(s)
            member_id, role_id = uuid.uuid4(), uuid.uuid4()

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("deny", "org_policy")),
            ):
                gate = await create_gate(
                    s, seeded["org_id"], seeded["story_id"], "story", "qa", member_id, role_id,
                )
                await s.commit()
                reopened = await create_gate(
                    s, seeded["org_id"], seeded["story_id"], "story", "qa", member_id, role_id,
                )
                await s.commit()

            assert reopened.status == "rejected"
            assert reopened.requires_human is False
    finally:
        await engine.dispose()

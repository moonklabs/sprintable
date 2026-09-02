"""story #2965(PO 판정 2026-08-23) — H1-FIX-2 되돌림: merge 게이트 approve가 더 이상 스토리를
done으로 자동전진시키지 않는다.

원래(H1-FIX-2, 이 파일명의 유래): 사람이 approve하면 `_advance_story_on_merge_approve`가 story를
즉시 done까지 진행시켰다. 실사고(2933→2931→2952→2958, 하루 4회 재발): 그 approve 시점에 PR이
아직 미머지(design 라벨·CLEAN 대기)인 채로 board가 done을 보여줘 no-fiction 위반이었다 — 매번
PO가 in-review로 수동 되돌렸다.

처방 재검토: "PR 머지 웹훅으로 done 트리거"(스토리 원안)는 기각 — story #2327(2026-07-30)이 같은
이유("머지 ≠ done, done은 사람 확認 後")로 정확히 그 메커니즘(close-on-merge)을 이미 정지시켰다.
트리거만 바꿔 되살리면 동일 사고가 재발한다. 채택안: `_advance_story_on_merge_approve` 자체를
gate_service.py에서 제거 — gate approve는 게이트 상태만 바꾸고 story.status는 건드리지 않는다.
done은 사람이 board에서 명시 PATCH하는 경로 하나로 통일.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.verdict  # noqa: F401 — #2662: app.models 벌크 import에 안 잡힘, create_all 전 명시 필요.
    import app.models.activity_log  # noqa: F401 — 동일 이유(transition_gate가 ActivityLog 기록).

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.anyio
async def test_transition_approve_does_not_advance_story_to_done_real_db():
    """⭐핵심 — merge 게이트 approve는 story.status를 건드리지 않는다(in-review 그대로)."""
    from sqlalchemy import text as _text

    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id, resolver, gate_id = (uuid.uuid4() for _ in range(4))
    try:
        from app.models.gate import Gate

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="in-review", story_points=3),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                Gate(id=gate_id, org_id=org, work_item_id=story_id, work_item_type="story",
                     gate_type="merge", status="pending"),
            ])
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            await transition_gate(s, org, gate_id, "approved", resolver_id=resolver)
            await s.commit()

        async with Session() as s:
            status = (await s.execute(
                _text("SELECT status FROM stories WHERE id=:id"), {"id": story_id}
            )).scalar()
            assert status == "in-review", (
                f"approve 후에도 story.status는 불변이어야(done은 사람 명시 PATCH 몫), got {status}"
            )
    finally:
        from app.core.database import Base

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_transition_reject_does_not_advance_story_either():
    """양성대조 — reject도 당연히 story.status 불변(원래도 진행 안 했음, 회귀 없음 확인)."""
    from sqlalchemy import text as _text

    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id, resolver, gate_id = (uuid.uuid4() for _ in range(4))
    try:
        from app.models.gate import Gate

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="in-review", story_points=3),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                Gate(id=gate_id, org_id=org, work_item_id=story_id, work_item_type="story",
                     gate_type="merge", status="pending"),
            ])
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            # story #3334 — transition_gate("rejected")가 이제 사유 필수. 이 테스트의
            # 관심사(story.status 미전진 확인)와 무관하므로 명시로 실어 대상 밖임을 밝힌다.
            await transition_gate(s, org, gate_id, "rejected", resolver_id=resolver, note="양성대조용 반려")
            await s.commit()

        async with Session() as s:
            status = (await s.execute(
                _text("SELECT status FROM stories WHERE id=:id"), {"id": story_id}
            )).scalar()
            assert status == "in-review"
    finally:
        from app.core.database import Base

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()

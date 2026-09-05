"""story #3505(위생·BE·소형, 디디 3502 그라운딩 부수 발견, 2026-09-05) —
`recipe_repeat_scheduler.py`가 Story를 직접 만들 때 `allocate_story_number()`를 안
불러 `story_number`가 NULL로 남던 갭.

fix는 `app/services/recipe_repeat_scheduler.py::_create_next_story`에 1줄(같은
트랜잭션에서 `allocate_story_number()` 호출) — 회귀 pin은 `tests/test_3337_recipe_
repeat_scheduler.py`의 기존 통합 테스트에 이미 심었다(새 세팅 재발명 금지). 이 파일은
① 「Story()를 직접 만드는 파일 전수가 allocate_story_number를 부른다」는 파일-레벨
가드(새 경로가 생기면 RED) ② 백필 마이그(0337) SQL 자체를 직접 실행해 검증."""
from __future__ import annotations

import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_BACKEND_ROOT = Path(__file__).resolve().parents[1]

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _session_factory():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_REAL_DB_URL.replace("postgresql://", "postgresql+asyncpg://").replace("postgresql+psycopg2://", "postgresql+asyncpg://"))
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_and_projects(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="3505 Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([project_a, project_b])
    await session.commit()
    return org.id, project_a.id, project_b.id


async def _seed_raw_story(session, *, org_id, project_id, title, story_number=None, created_at=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, story_number=story_number,
        created_at=created_at or datetime.now(timezone.utc),
    )
    session.add(story)
    await session.commit()
    return story.id


_BACKFILL_SQL = """
    WITH null_rows AS (
        SELECT id, project_id,
               ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
        FROM stories
        WHERE story_number IS NULL
    ),
    project_max AS (
        SELECT project_id, COALESCE(MAX(story_number), 0) AS max_num
        FROM stories
        GROUP BY project_id
    )
    UPDATE stories
    SET story_number = project_max.max_num + null_rows.rn
    FROM null_rows
    JOIN project_max ON project_max.project_id = null_rows.project_id
    WHERE stories.id = null_rows.id
"""
# 페드루 리뷰 관례(PR#3852) — 이 테스트는 마이그 0337의 SQL 문자열을 alembic 구동 없이
# 직접 복제 실행한다(destructive_schema가 create_all 기반이라 alembic 리비전 그래프
# 밖 — 이 스위트 전체의 관례와 동형). 마이그 문이 나중에 바뀌면 이 복제본은 자동으로
# 안 따라오는 «한 겹 얕은 원본»이다.


@pytest.mark.anyio
async def test_backfill_migration_assigns_sequential_numbers_continuing_from_max_per_project():
    from sqlalchemy import select, text as sa_text
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a, project_b = await _seed_org_and_projects(s)

            # 프로젝트 A — 이미 번호 있는 행 2개(1·2) + NULL 행 3개(생성순).
            await _seed_raw_story(s, org_id=org_id, project_id=project_a, title="A1", story_number=1,
                                   created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
            await _seed_raw_story(s, org_id=org_id, project_id=project_a, title="A2", story_number=2,
                                   created_at=datetime(2026, 1, 2, tzinfo=timezone.utc))
            a_null_1 = await _seed_raw_story(s, org_id=org_id, project_id=project_a, title="A-null-1",
                                              created_at=datetime(2026, 1, 3, tzinfo=timezone.utc))
            a_null_2 = await _seed_raw_story(s, org_id=org_id, project_id=project_a, title="A-null-2",
                                              created_at=datetime(2026, 1, 4, tzinfo=timezone.utc))

            # 프로젝트 B — 번호 있는 행 없이 전부 NULL(2개, 다른 프로젝트끼리 값 공간
            # 안 겹치는지 확인).
            b_null_1 = await _seed_raw_story(s, org_id=org_id, project_id=project_b, title="B-null-1",
                                              created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
            b_null_2 = await _seed_raw_story(s, org_id=org_id, project_id=project_b, title="B-null-2",
                                              created_at=datetime(2026, 1, 2, tzinfo=timezone.utc))

            await s.execute(sa_text(_BACKFILL_SQL))
            await s.commit()

            rows = (await s.execute(
                select(Story.id, Story.story_number).where(Story.project_id.in_([project_a, project_b]))
            )).all()
            numbers = {row.id: row.story_number for row in rows}

        assert numbers[a_null_1] == 3, "프로젝트 A의 기존 최대(2) 이어서 채번돼야 한다"
        assert numbers[a_null_2] == 4
        assert numbers[b_null_1] == 1, "번호가 하나도 없던 프로젝트는 1부터 시작해야 한다(다른 프로젝트 값 공간과 안 겹침)"
        assert numbers[b_null_2] == 2
        assert None not in numbers.values(), "백필 뒤에도 NULL이 남았다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_backfill_migration_idempotent_second_run_no_op():
    """이미 전부 채워진 뒤 다시 돌려도(재배포 등) 값이 안 바뀐다(WHERE story_number IS
    NULL이 0행을 골라 UPDATE 자체가 no-op)."""
    from sqlalchemy import select, text as sa_text
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a, _project_b = await _seed_org_and_projects(s)
            null_id = await _seed_raw_story(s, org_id=org_id, project_id=project_a, title="A-null")

            await s.execute(sa_text(_BACKFILL_SQL))
            await s.commit()
            first_number = (await s.execute(
                select(Story.story_number).where(Story.id == null_id)
            )).scalar_one()

            await s.execute(sa_text(_BACKFILL_SQL))
            await s.commit()
            second_number = (await s.execute(
                select(Story.story_number).where(Story.id == null_id)
            )).scalar_one()

        assert first_number == second_number == 1
    finally:
        await engine.dispose()


def test_direct_story_constructor_files_call_allocate_story_number():
    """가드 — `Story(`를 직접(=`StoryRepository.create()`를 거치지 않고) 생성하는 모든
    프로덕션 파일이 같은 파일 안에서 `allocate_story_number`를 부른다. 새 파일이
    Story()를 직접 만들면서 채번을 안 부르면 이 테스트가 잡는다(story #3505 재발
    방지). `BaseRepository.create()`는 제네릭(`self.model(...)`)이라 리터럴 `Story(`
    로 안 잡힌다 — grep 대상 밖(의도)."""
    # 페드루 리뷰 관례 동형 — 줄 끝 앵커(`Story($`)로 실제 다중행 생성자 호출만 잡고
    # 프로즈(주석·docstring 안의 "Story(...)" 언급)를 뺀다(2건 실측 오탐 — insights_
    # board.py 주석·gates.py docstring, 둘 다 "Story(" 뒤에 같은 줄에서 문장이 이어짐).
    result = subprocess.run(
        ["grep", "-rlE", r"\bStory\($", "app/services", "app/routers"],
        cwd=_BACKEND_ROOT, capture_output=True, text=True, check=False,
    )
    files = sorted(line for line in result.stdout.splitlines() if line.strip())
    assert files == ["app/routers/oss.py", "app/services/recipe_repeat_scheduler.py"], (
        "Story()를 직접 생성하는 파일 목록이 바뀌었다(추가/제거) — 이 테스트를 갱신하고 "
        f"새 자리가 allocate_story_number를 부르는지 직접 확인할 것: {files}"
    )
    for rel_path in files:
        source = (_BACKEND_ROOT / rel_path).read_text()
        assert "allocate_story_number" in source, (
            f"{rel_path}가 Story()를 직접 만드는데 allocate_story_number를 안 부른다"
            "(story_number NULL 갭 재발, story #3505)"
        )

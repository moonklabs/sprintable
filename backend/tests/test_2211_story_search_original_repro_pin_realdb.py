"""story #2211([결함] 일감 검색이 번호로도, 두 낱말로도, 본문으로도 안 찾아진다) — PO 원문
그대로의 재현 문장을 회귀 pin으로 고정한다.

그라운딩(judgment 87699de3, 2026-08-16) 결과: 착수 前 라이브 dev 재현에서 AC1(번호 검색)·
AC2(다중 낱말 검색)는 **이미 해소**된 상태로 확인됐다 — story #2645(번호 OR 매치)·#2619
(다중 토큰 AND 매치)가 이 스토리보다 먼저 랜딩·배포됨. PO의 원 반례 `search_stories(
"cross-org 유출")` 0건은 그 스토리의 실제 제목에 그 두 낱말이 **리터럴로 존재하지 않아서**
난 것 — AND 토큰매치(부분일치, 의미검색 아님)가 설계대로 정확히 거절한 것이지 결함이
아니었다(PO 판정, 2026-08-16: ⓐ+ⓑ 병합 — AC1/AC2는 해소로 기록하고, 이 원문 그대로의
pin 하나만 남겨 "0건 = 결함"으로 나중에 다시 열리지 않게 한다).

이 파일은 `test_2619_title_search_tokenized_and_match.py`/`test_2645_story_number_search_
or_match.py`가 이미 구조적으로 커버하는 축(AND 결합·번호 OR 매치)을 재검증하지 않는다 —
PO가 실제로 타이핑한 두 문장(`"2206"`류 순수 번호·`"cross-org 유출"`류 리터럴-없는 다중
낱말)을 글자 그대로 pin하는 것이 유일한 목적이다."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_2645_story_number_search_or_match import _call_list_stories

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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


async def _seed_repro_story(session):
    """PO 원 사례(#2206류)의 정확한 형태 재현 — 실 제목엔 「cross-org 유출」이 리터럴로
    없고, 번호는 title과 무관(story_number 컬럼 별도)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.repositories.story import allocate_story_number

    org = Organization(id=uuid.uuid4(), name="Org2211", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    number = await allocate_story_number(session, project.id)
    story = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, status="backlog",
        title="[보안·critical] 스토리 댓글·활동 조회에 org 조건이 아예 없다 — 스토리 UUID 만 알면 다른 조직의 것도 읽힌다",
        story_number=number,
    )
    session.add(story)
    await session.commit()
    return org.id, project.id, agent.id, story.id, number


async def test_po_original_repro_bare_number_now_finds_the_story():
    """PO가 실제로 타이핑한 문장 — `search_stories("2206")`류 순수 번호 하나만. #2645
    (번호 OR 매치)로 이미 해소돼 있어야 한다 — 원문 그대로 pin(회귀 시 이 자리가 먼저 깨짐)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, number = await _seed_repro_story(s)

            result = await _call_list_stories(s, org_id, agent_id, project_id=project_id, q=str(number))
            ids = {str(r.id) for r in result}
            assert str(story_id) in ids, (
                f"PO 원 재현 — q={number!r}(순수 번호)가 그 스토리를 못 찾으면 #2645 회귀"
            )
    finally:
        await engine.dispose()


async def test_po_original_repro_multiword_phrase_correctly_returns_zero_by_design():
    """PO가 실제로 타이핑한 문장 — `search_stories("cross-org 유출")`류, 그 스토리 실제
    제목에 리터럴로 없는 두 낱말. **0건이 정답이다**(AND 리터럴 부분일치 — 의미검색 아님,
    PO 판정 2026-08-16 명시) — 이 테스트는 「0건=결함」으로 나중에 다시 여는 것을 막는
    양성 pin이다. 그 스토리 실제 제목에 리터럴로 있는 두 낱말(「UUID」·「조직」)로는 정상
    1건이 나옴을 대조로 같이 고정한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, number = await _seed_repro_story(s)

            # 리터럴로 없는 두 낱말 — 0건이 정상(설계: AND 부분일치, 의미검색 아님).
            zero_result = await _call_list_stories(
                s, org_id, agent_id, project_id=project_id, q="cross-org 유출",
            )
            assert list(zero_result) == [], (
                "이 쿼리는 그 스토리 실제 제목에 리터럴로 없는 낱말 조합이라 0건이 «정답»이다 — "
                "0건 자체를 결함으로 다시 보고하지 말 것(PO 판정 2026-08-16)."
            )

            # 대조군 — 실제 제목에 리터럴로 있는 두 낱말은 정상 매치(회귀 있으면 여기서 잡힘).
            positive_result = await _call_list_stories(
                s, org_id, agent_id, project_id=project_id, q="UUID 조직",
            )
            positive_ids = {str(r.id) for r in positive_result}
            assert str(story_id) in positive_ids, (
                "제목에 리터럴로 실재하는 다중 낱말(UUID·조직)까지 0건이면 #2619 회귀"
            )
    finally:
        await engine.dispose()

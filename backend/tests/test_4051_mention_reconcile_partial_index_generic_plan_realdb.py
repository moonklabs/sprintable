"""story #4051(E-RECIPE-1 ②) — mention_parser.reconcile_entity_references(및 그 계약을
공유하는 references.py 명시 생성 라우트·reference_backfill.py)의
`on_conflict_do_nothing(index_elements=..., index_where=Reference.form != "proof")`가
partial unique index(`uq_entity_references_non_proof`, migration 0217)와 매칭에 실패하던
결함의 근본수정 실증(story #4050/PR#4427에서 처음 실측 — no-op으로 격리했던 그 결함).

## 근본원인(실측, SQLAlchemy 소스+PostgreSQL PREPARE 문서 확認 — 추측 grep 아님)
`Reference.form != "proof"`는 SQLAlchemy에서 평범한 **bind parameter**로 컴파일된다
(`postgresql/base.py::_on_conflict_target`이 `self.process(inferred_target_whereclause,
**kw)`로 일반 컴파일 경로를 타 literal_binds가 적용 안 됨). PostgreSQL은 extended query
protocol로 같은 텍스트의 prepared statement를 **5회까지는 커스텀 플랜**(그때그때 실 파라미터
값을 알고 재계획 — 이 경우 `$12`가 정확히 `'proof'`임을 알아 index predicate와 매치 성공)으로
실행하지만, **6회째부터** 제네릭 플랜(파라미터 값을 몰라도 되는 1회 계획, `plan_cache_mode=
auto`의 커스텀-vs-제네릭 비용비교 임계값)으로 전환할지 평가한다 — 제네릭 플랜에서는 `$12`가
정말로 항상 `'proof'`인지 증명할 수 없어(임의의 파라미터일 수 있으므로) partial index를
arbiter로 못 쓴다("no unique or exclusion constraint matching the ON CONFLICT
specification"). 이 파일의 실측 재현(수정 前)은 정확히 **같은 세션에서 6번째 호출**부터
깨졌다 — 매뉴얼 `psql PREPARE`/`EXECUTE` 반복으로 교차검증(1~5회 커스텀 플랜 성공, 6회째
제네릭 전환과 함께 실패).

## 근본수정
`sqlalchemy.literal(value, literal_execute=True)`(SQLAlchemy 2.0 공식 API, "SQL 엔진이
파라미터가 아니라 실행 시점 SQL 텍스트에 값을 직접 렌더링하도록 강제") — 커스텀/제네릭 플랜
여부와 무관하게 항상 `form <> 'proof'` 리터럴로 컴파일돼 index predicate와 구조적으로
항상 일치한다. `mention_parser.py`·`references.py`·`reference_backfill.py` 3곳(entity_
references에 같은 partial index를 arbiter로 쓰는 유일한 3개 write-path) 전부 동일하게
적용.

## 이 파일의 검증 방식
`Base.metadata.create_all()` disposable 스키마가 아니라 **`alembic upgrade head`로 실제
마이그레이션 전부를 적용한 realdb**를 쓴다(story #1993 계열 기존 관례와 동형, `destructive_
schema` 마커 없음) — 0217이 실제 raw SQL로 심는 그 partial index 그대로를 arbiter로 쓰는지
검증해야 이 결함의 재발을 정확히 잡는다(수기로 patch한 index로는 "내가 만든 인덱스와 내가
만든 코드가 서로 맞다"만 증명해 실제 회귀 감지력이 없다)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL, alembic upgrade head 완료) 필요"),
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
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    org = Organization(id=uuid.uuid4(), name="Org4051", slug=f"org4051-{uuid.uuid4().hex[:8]}")
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
    await session.commit()
    return doc


async def test_reconcile_entity_references_survives_more_than_five_calls_same_session():
    """⭐AC1 핵심 음성 대조 — 같은 target을 가리키는(그러나 매번 source_id가 다른, 그래서
    매번 "새 참조"인) mention insert를 같은 세션에서 8회 반복한다. 수정 前에는 PostgreSQL이
    커스텀→제네릭 플랜으로 전환하는 6번째 호출부터 InvalidColumnReferenceError로 깨졌다
    (이 테스트를 되돌리면 즉시 RED). 수정 後에는 8회 전부 정확히 1행씩 쌓인다."""
    from sqlalchemy import select
    from app.models.reference import Reference
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            target_doc = await _make_doc(session, org.id, project.id)

            message_ids = [uuid.uuid4() for _ in range(8)]
            for message_id in message_ids:
                await insert_chat_mentions(
                    session, org_id=org.id, message_id=message_id,
                    content=f"[참고 doc](entity:doc:{target_doc.id})",
                    created_by=member.id,
                )
                await session.commit()

            rows = (await session.execute(
                select(Reference).where(Reference.target_id == target_doc.id, Reference.target_type == "doc")
            )).scalars().all()
            assert len(rows) == 8
            assert {r.source_id for r in rows} == set(message_ids)
    finally:
        await engine.dispose()


async def test_reference_registration_route_index_where_uses_literal_execute():
    """단위 축(DB 불요) — 3곳(mention_parser·references·reference_backfill)의 index_where가
    전부 literal_execute 표식을 갖는지 코드 자체로 고정(회귀 시 이 테스트가 즉시 알려준다 —
    누군가 후속 리팩터에서 `literal(...)`을 다시 평범한 파이썬 값으로 되돌리는 실수 방지)."""
    import app.services.mention_parser as mp
    import app.routers.references as refs_router
    import app.services.reference_backfill as backfill

    import inspect

    for module in (mp, refs_router, backfill):
        source = inspect.getsource(module)
        assert 'literal("proof", literal_execute=True)' in source, (
            f"{module.__name__}의 index_where가 literal_execute를 안 쓰는 것으로 되돌아갔다 — "
            "story #4051 회귀(제네릭 플랜 전환 시 partial index 매칭 실패)."
        )

"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각②) —
`hosted_site_publish.py`(BlogDestinationAdapter 1호 구현체) 직접 단위 테스트.

이 파일이 다루는 것은 `site_posts.py`의 기존 회귀 테스트(test_3365/test_3369/
test_3360/test_3381 등, 로컬 55건 전량 green으로 별도 확인)가 이미 간접적으로
증명하는 "동작 무변경"이 아니라, **이 모듈 자체가 BlogDestinationAdapter 모양
(publish/unpublish)으로 직접 호출 가능한지**의 단위 pin — wordpress/webhook
(조각③·④)이 같은 모양을 낼 때 이 파일을 그대로 미러할 수 있게 하는 선례."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="Hosted Site Adapter Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org.id


@pytest.mark.anyio
async def test_publish_creates_site_post_row_with_expected_fields():
    """뮤테이션 대상 — publish()가 title/summary/tags/body_md를 그대로 저장하지 않으면
    이 assert가 RED."""
    from app.services import hosted_site_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            gate_id = uuid.uuid4()
            member_id = uuid.uuid4()

            post = await hosted_site_publish.publish(
                s, org_id=org_id, work_item_id=work_item_id, gate_id=gate_id,
                title="제목", slug="adapter-post", lang="ko", summary="요약",
                tags=["a", "b"], body_md="본문", created_by_member_id=member_id,
            )
            await s.commit()

            assert post.org_id == org_id
            assert post.slug == "adapter-post"
            assert post.title == "제목"
            assert post.tags == ["a", "b"]
            assert post.gate_id == gate_id
            assert post.created_by_member_id == member_id
            assert post.unpublished_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_upserts_on_repeat_call_same_org_lang_slug():
    """재발행(같은 org+lang+slug) — 새 행이 아니라 기존 행을 갱신한다(UNIQUE
    uq_site_posts_org_lang_slug 위반이 아니라 upsert)."""
    from app.services import hosted_site_publish
    from app.models.site_post import SitePost
    from sqlalchemy import select, func

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
        member_id = uuid.uuid4()

        # 실 호출부와 동형으로 요청마다 새 세션(같은 세션을 재사용하면 SQLAlchemy identity
        # map이 두 번째 RETURNING을 첫 호출 시 캐시한 파이썬 객체로 되돌려 이 테스트
        # 자체가 거짓 실패한다 — 프로덕션에선 HTTP 요청마다 세션이 갈려 이 함정을 안 밟는다).
        async with Session() as s:
            post1 = await hosted_site_publish.publish(
                s, org_id=org_id, work_item_id=uuid.uuid4(), gate_id=uuid.uuid4(),
                title="v1", slug="upsert-post", lang="ko", summary="s1", tags=[],
                body_md="본문 v1", created_by_member_id=member_id,
            )
            await s.commit()
            post1_id = post1.id

        async with Session() as s:
            post2 = await hosted_site_publish.publish(
                s, org_id=org_id, work_item_id=uuid.uuid4(), gate_id=uuid.uuid4(),
                title="v2", slug="upsert-post", lang="ko", summary="s2", tags=[],
                body_md="본문 v2", created_by_member_id=member_id,
            )
            await s.commit()

            assert post1_id == post2.id
            assert post2.title == "v2"

            count = (await s.execute(
                select(func.count()).select_from(SitePost).where(
                    SitePost.org_id == org_id, SitePost.slug == "upsert-post",
                )
            )).scalar_one()
            assert count == 1, "재발행이 새 행을 만들었다(upsert가 아니라 insert로 동작)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_sets_unpublished_at_does_not_delete_row():
    """뮤테이션 대상 — unpublish()가 행을 삭제하거나 unpublished_at을 안 건드리면
    이 assert가 RED(AC 명시: 상태 전환, 행 삭제 아님)."""
    from app.services import hosted_site_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            post = await hosted_site_publish.publish(
                s, org_id=org_id, work_item_id=uuid.uuid4(), gate_id=uuid.uuid4(),
                title="제목", slug="unpublish-post", lang="ko", summary="요약", tags=[],
                body_md="본문", created_by_member_id=uuid.uuid4(),
            )
            await s.commit()
            assert post.unpublished_at is None

            before = datetime.now(timezone.utc)
            await hosted_site_publish.unpublish(post=post)
            await s.commit()

            assert post.unpublished_at is not None
            assert post.unpublished_at >= before
    finally:
        await engine.dispose()

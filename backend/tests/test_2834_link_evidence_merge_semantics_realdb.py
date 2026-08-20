"""story #2834(PO AC 확定 2026-08-20, #2832 그라운딩에서 파생 — 디디 실측) — `upsert_link`
(explicit-link API 전용)가 evidence를 **전체 교체**해 웹훅이 이미 채워 둔 필드를 지우던 결함의
회귀. 실 사고(#2832 방아쇠): 07:13:59 웹훅이 head_sha를 채움 → 07:14:09 explicit-link 호출이
`{"by":"explicit_api"}`로 evidence를 통째로 갈아 끼워 head_sha 소실.

fix: `upsert_link`/`merge_link_evidence` 공유 `_merge_evidence`(dict-merge, 전체 교체 금지).

그라운딩(소비처 전수 grep)이 확인한 top-level 키 비겹침(head_sha/scope_check/webhook_merge/by)
전제 — 이 파일의 두 테스트가 그 실측을 그대로 고정한다. AC②의 "진짜 양성대조"는 scope_check쪽
— trust_pipeline.batch_scope_violation이 실제로 그 값을 읽는 소비처라서(head_sha쪽은 #2832가
gate 자체 필드로 이미 우회해 둔 터라 링크 레벨만으론 소비처 실증이 약하다)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
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
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드.
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_story(session):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="link evidence merge")
    session.add(story)
    await session.commit()
    return org, project, story


@pytest.mark.anyio
async def test_explicit_link_preserves_webhook_head_sha_realdb():
    """①: 웹훅이 head_sha를 이미 채운 링크에 explicit-link(upsert_link)를 걸어도 head_sha가
    살아있어야 한다 — #2832 실사고(07:13:59 웹훅 → 07:14:09 explicit-link가 지웠던 것) 재현."""
    from app.services.pr_story_link import merge_link_evidence, upsert_link

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s)

            await merge_link_evidence(
                s, org.id, story.id, "acme/repo", 42,
                link_source="sid", confidence="high",
                patch={"head_sha": "sha-from-webhook"},
            )
            await s.commit()

            link = await upsert_link(
                s, org.id, story.id, "acme/repo", 42,
                link_source="explicit", confidence="high",
                evidence={"by": "explicit_api"},
            )
            await s.commit()

            assert link.evidence.get("head_sha") == "sha-from-webhook", link.evidence
            assert link.evidence.get("by") == "explicit_api", link.evidence
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_link_preserves_scope_violation_signal_realdb():
    """②(양성대조, AC②): scope_check.violated=true가 이미 찍힌 링크에 explicit-link를 걸어도
    trust_pipeline.batch_scope_violation이 그 story를 여전히 위반으로 잡아야 한다 — 실 소비처를
    통해 값이 진짜 안 지워졌는지 실증(단순 dict 재조회보다 강한 증거)."""
    from app.services.pr_story_link import merge_link_evidence, upsert_link
    from app.services.trust_pipeline import batch_scope_violation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s)

            await merge_link_evidence(
                s, org.id, story.id, "acme/repo", 43,
                link_source="sid", confidence="high",
                patch={"scope_check": {"violated": True, "out_of_scope_files": ["x.py"]}},
            )
            await s.commit()

            await upsert_link(
                s, org.id, story.id, "acme/repo", 43,
                link_source="explicit", confidence="high",
                evidence={"by": "explicit_api"},
            )
            await s.commit()

            violated_ids = await batch_scope_violation(s, org.id, [story.id])
            assert story.id in violated_ids, "explicit-link 후에도 scope_check.violated 소비처가 여전히 잡아야 한다"
    finally:
        await engine.dispose()

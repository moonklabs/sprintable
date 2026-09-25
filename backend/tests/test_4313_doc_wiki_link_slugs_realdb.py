"""story #4313 — 문서 상세(slug 단건 경로) 응답의 `wiki_link_slugs`: 본문 위키 링크 후보 중 같은 프로젝트에 실재하는 문서 slug만.

FE는 이 집합에 든 것만 진짜 링크로 그리고 나머지는 글자 그대로 둔다(없는 문서로 가는 깨진 링크 0 · 요청 추가 0).
실재 판정(삭제 제외 · 같은 프로젝트 · 같은 org)은 실DB 쿼리라 mock으로는 못 잡는다. DB env 없으면 skip(realdb 관례).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers.docs import wiki_link_slug_candidates

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
realdb = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("43130000-0000-0000-0000-000000000001")
OTHER_ORG = uuid.UUID("43130000-0000-0000-0000-000000000002")
PROJ = uuid.UUID("43130000-0000-0000-0000-0000000000c1")
OTHER_PROJ = uuid.UUID("43130000-0000-0000-0000-0000000000c2")
FOREIGN_PROJ = uuid.UUID("43130000-0000-0000-0000-0000000000c3")

BODY = (
    "앞 [[onboarding]] · 별칭 [[onboarding|온보딩 안내]] · 없는 [[feedback_memory_file]] · 지운 [[gone-doc]] · "
    "다른 프로젝트 [[other-proj-doc]] · 다른 org [[foreign-doc]] · 에디터 span "
    '<span data-type="wikiLink" data-doc-id="x" data-title="설계" data-slug="design-doc">설계</span>\n'
    "```\n[[in-code]]\n```\n"
)


def test_candidates_cover_both_syntaxes_and_span_dedup_in_order():
    assert wiki_link_slug_candidates(BODY) == [
        "onboarding", "feedback_memory_file", "gone-doc", "other-proj-doc", "foreign-doc", "design-doc", "in-code",
    ]
    # 후보의 상위집합만 뽑는다 — 코드 안 «[[in-code]]»도 후보(문맥 판정은 FE 렌더러).
    assert wiki_link_slug_candidates(None) == []
    # 빈 «[[]]» · 줄바꿈 낀 것 · 홑대괄호는 후보 아님 · «[[c|d|e]]»는 slug c + 글 «d|e».
    assert wiki_link_slug_candidates("[[a|]] [[ b ]] [[]] [[x\ny]] [not] [[c|d|e]]") == ["a", "b", "c"]


def test_candidate_limit_bounds_the_in_list():
    body = " ".join(f"[[s{i}]]" for i in range(500))
    assert len(wiki_link_slug_candidates(body)) == 200


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed(session) -> None:
    for sql in [
        f"DELETE FROM docs WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{OTHER_ORG}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','4313 Org','org-4313','free')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{OTHER_ORG}','4313 Other','org-4313-b','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{OTHER_PROJ}','{ORG}','Q')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{FOREIGN_PROJ}','{OTHER_ORG}','R')",
    ]:
        await session.execute(text(sql))
    rows = [
        (ORG, PROJ, "Main", "main-doc", BODY, None),
        (ORG, PROJ, "Onboarding", "onboarding", "x", None),
        (ORG, PROJ, "Design", "design-doc", "x", None),
        (ORG, PROJ, "In code", "in-code", "x", None),
        (ORG, PROJ, "Gone", "gone-doc", "x", "now()"),
        (ORG, OTHER_PROJ, "Other", "other-proj-doc", "x", None),
        (OTHER_ORG, FOREIGN_PROJ, "Foreign", "foreign-doc", "x", None),
    ]
    for org, proj, title, slug, content, deleted in rows:
        await session.execute(
            text(
                "INSERT INTO docs (id,org_id,project_id,title,slug,content,content_format,deleted_at) "
                f"VALUES (:id,:org,:proj,:title,:slug,:content,'markdown',{deleted or 'NULL'})"
            ),
            {"id": uuid.uuid4(), "org": org, "proj": proj, "title": title, "slug": slug, "content": content},
        )
    await session.commit()


async def _cleanup(session) -> None:
    for sql in [
        f"DELETE FROM docs WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{OTHER_ORG}')",
    ]:
        await session.execute(text(sql))
    await session.commit()


@realdb
@pytest.mark.anyio
async def test_existing_slugs_only_live_docs_in_same_project_and_org(anyio_backend):
    from app.repositories.doc import DocRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _seed(session)
            repo = DocRepository(session, ORG)
            got = await repo.existing_slugs(PROJ, wiki_link_slug_candidates(BODY))
            # 실재 = onboarding · design-doc · in-code(코드 안이어도 BE는 실재만 판정). 없음 · 삭제 · 다른 프로젝트 · 다른 org는 빠짐.
            assert got == ["design-doc", "in-code", "onboarding"]
            assert await repo.existing_slugs(PROJ, []) == []
            # org 경계 — 다른 org 저장소로는 같은 후보라도 이 프로젝트 문서가 안 보인다.
            assert await DocRepository(session, OTHER_ORG).existing_slugs(PROJ, ["onboarding"]) == []
            await _cleanup(session)
    finally:
        await engine.dispose()


@realdb
@pytest.mark.anyio
async def test_slug_detail_response_carries_wiki_link_slugs_and_other_paths_do_not(anyio_backend):
    from app.repositories.doc import DocRepository
    from app.routers.docs import list_docs

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _seed(session)
            repo = DocRepository(session, ORG)
            detail = await list_docs(
                project_id=PROJ, parent_id=None, doc_type=None, tags=None, slug="main-doc", q=None, ids=None,
                limit=500, cursor=None, repo=repo,
            )
            assert [d.slug for d in detail["data"]] == ["main-doc"]
            assert detail["data"][0].wiki_link_slugs == ["design-doc", "in-code", "onboarding"]

            no_links = await list_docs(
                project_id=PROJ, parent_id=None, doc_type=None, tags=None, slug="onboarding", q=None, ids=None,
                limit=500, cursor=None, repo=repo,
            )
            assert no_links["data"][0].wiki_link_slugs == []

            # 다건 경로(목록)는 필드를 채우지 않는다(additive · None).
            listing = await list_docs(
                project_id=PROJ, parent_id=None, doc_type=None, tags=None, slug=None, q=None, ids=None,
                limit=500, cursor=None, repo=repo,
            )
            assert listing["data"] and all(d.wiki_link_slugs is None for d in listing["data"])
            await _cleanup(session)
    finally:
        await engine.dispose()

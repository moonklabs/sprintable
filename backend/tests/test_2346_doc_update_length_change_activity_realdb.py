"""story #2346 AC3/AC7 — docs.py::update_doc (stories.py에서 이미 검증된 패턴의 두 번째 적용).

docs.py는 stories.py와 달리 activity 로깅 자체가 없었다(신규 배선) — content가 실제로 바뀔 때
「이전 길이→이후 길이」를 doc_updated activity log에 얹는다. AC7(50% 이상 급감+절대손실 100자
이상이면 400 거부, allow_shrink=true로 승인)도 stories.py와 동일 임계값으로 이식했다(doc
content 실측 결과 — 그 스케일에서는 퍼센트 임계가 실질적으로 작동해 그대로 전이해도 무리 없음,
PO 판정 2026-08-02).
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab920000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab920000-0000-0000-0000-000000000002")
DOC = uuid.UUID("ab920000-0000-0000-0000-000000000003")
AGENT_IN = uuid.UUID("ab920000-0000-0000-0000-0000000000a1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _auth() -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT_IN), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed(s, initial_content: str) -> None:
    for sql in [
        f"DELETE FROM activity_logs WHERE org_id='{ORG}'",
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','2346DOC','s2346-doc-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_IN}','{ORG}','agent','AgentIn')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT_IN}','granted')",
    ]:
        await s.execute(text(sql))
    await s.execute(
        text(
            "INSERT INTO docs (id,org_id,project_id,title,slug,content,doc_type,content_format) "
            "VALUES (:id,:org,:proj,'test doc','test-doc-2346',:content,'page','markdown')"
        ),
        {"id": DOC, "org": ORG, "proj": PROJ, "content": initial_content},
    )
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _fetch_latest_doc_updated_context(Session):
    async with Session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT context FROM activity_logs WHERE org_id=:org AND action='doc_updated' "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"org": ORG},
            )
        ).scalar_one_or_none()
        return row


@pytest.mark.anyio
async def test_shrinking_content_records_before_after_length():
    """AC3 핵심 — content 급감이 doc_updated activity의 context.length_changes에 남는지."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        long_content = "x" * 4000
        async with Session() as s:
            await _seed(s, long_content)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            short_content = "y" * 300
            await update_doc(
                DOC, DocUpdate(content=short_content, allow_shrink=True), bg,
                repo=repo, session=s, auth=_auth(),
            )
            await bg()

        context = await _fetch_latest_doc_updated_context(Session)
        assert context is not None, "doc_updated activity가 안 남음"
        assert context["length_changes"]["content"] == {"before": 4000, "after": 300}
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_unchanged_length_does_not_pollute_the_log():
    """양성 대조 — content를 같은 길이의 다른 텍스트로 바꾸면 activity 자체가 안 남는다.
    docs.py는 stories.py와 달리 사전 존재하던 doc_updated 로그가 없어(신규 배선) 길이가
    실제로 안 바뀌면 로그 호출 자체를 안 한다 — "엔트리는 있는데 length_changes만 없다"가
    아니라 "엔트리 자체가 없다"가 맞는 동작(잡음을 만들 pre-existing 자리가 없으므로)."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        original = "a" * 200
        async with Session() as s:
            await _seed(s, original)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            same_length_different_text = "b" * 200
            await update_doc(
                DOC, DocUpdate(content=same_length_different_text), bg,
                repo=repo, session=s, auth=_auth(),
            )
            await bg()

        context = await _fetch_latest_doc_updated_context(Session)
        assert context is None, f"길이가 안 변했는데 activity가 남음(잡음): {context}"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_untouched_content_not_logged_when_only_title_changes():
    """양성 대조 — content는 안 건드리고 title만 바꾸면 activity 자체가 아예 안 남는다
    (docs.py의 length 기록은 "content in data" 블록 안에서만 도는 것이 정확한 스코프)."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, "unchanged content")

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            await update_doc(
                DOC, DocUpdate(title="new title"), bg, repo=repo, session=s, auth=_auth(),
            )
            await bg()

        context = await _fetch_latest_doc_updated_context(Session)
        assert context is None, f"content 안 건드렸는데 doc_updated activity가 남음: {context}"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_shrink_over_50_percent_blocked_without_flag():
    """AC7 핵심 — content가 50% 이상 줄면 allow_shrink 없이는 400."""
    from fastapi import HTTPException
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        long_content = "x" * 4000
        async with Session() as s:
            await _seed(s, long_content)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            short_content = "y" * 300  # -92.5%
            with pytest.raises(HTTPException) as ei:
                await update_doc(
                    DOC, DocUpdate(content=short_content), bg, repo=repo, session=s, auth=_auth(),
                )
            assert ei.value.status_code == 400
            assert "4000" in ei.value.detail and "300" in ei.value.detail
            assert "allow_shrink=true" in ei.value.detail
            assert "test doc" in ei.value.detail, f"doc 제목이 메시지에 없음: {ei.value.detail}"

        # 봉인 — 거부됐으니 원본이 그대로 살아 있어야 한다.
        async with Session() as s:
            row = (await s.execute(
                text("SELECT content FROM docs WHERE id=:i"), {"i": DOC}
            )).scalar_one()
            assert row == long_content, "거부됐는데 content가 바뀜(부분 적용 회귀)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_shrink_with_allow_shrink_flag_passes():
    """AC7 — allow_shrink=true로 명시 승인하면 같은 급감도 통과한다."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        long_content = "x" * 4000
        async with Session() as s:
            await _seed(s, long_content)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            short_content = "y" * 300
            resp = await update_doc(
                DOC, DocUpdate(content=short_content, allow_shrink=True), bg,
                repo=repo, session=s, auth=_auth(),
            )
            assert resp.content == short_content
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_small_shrink_under_threshold_not_blocked():
    """양성 대조 — 50% 미만 축소(정상적인 편집 범위)는 플래그 없이도 통과한다."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        original = "x" * 1000
        async with Session() as s:
            await _seed(s, original)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            slightly_shorter = "y" * 600  # -40%, 임계(50%) 밑
            resp = await update_doc(
                DOC, DocUpdate(content=slightly_shorter), bg, repo=repo, session=s, auth=_auth(),
            )
            assert resp.content == slightly_shorter
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_small_absolute_loss_not_blocked_even_at_high_percentage():
    """양성 대조 — 짧은 content는 퍼센트가 커도(절대량이 작으면) 안 막힌다."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import update_doc
    from app.schemas.doc import DocUpdate

    eng, Session = await _engine()
    try:
        token_like = "[Target](entity:doc:11111111-1111-1111-1111-111111111111)"  # 48자
        async with Session() as s:
            await _seed(s, token_like)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            bg = BackgroundTasks()
            resp = await update_doc(
                DOC, DocUpdate(content="no tokens here"), bg, repo=repo, session=s, auth=_auth(),
            )
            assert resp.content == "no tokens here"
    finally:
        await eng.dispose()

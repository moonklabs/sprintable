"""story #2044(P1, "성공이 실패로 위장" 변종) — PATCH /api/v2/stories/{id}에 attachments를
실어 보내면 저장(첨부·asset registry reconcile)은 성공하는데, 그 뒤 500이 나 호출자가 재시도해
GCS 고아 객체가 쌓이는 결함(댄 어윈 실측·2026-07-20, dev).

## AC1 그라운딩(실재현 로그로) — 원 트리거는 이미 닫혔고, 재발 방지 축은 별개로 남아 있었다
원 사고 시점(2026-07-20) Cloud Logging은 30일 보존 만료로 복구 불가 — 대신 git 이력으로 원인
계열을 확定했다: `update_story`는 「side-effect 에러가 attachments write를 rollback시키지
않도록」 `await db.commit()`을 의도적으로 side-effect 코드보다 **먼저** 부른다(주석 원문
그대로). 이 설계 자체가 "commit 後 model_validate 前 무엇이든 예외를 던지면 저장된 write가
500으로 위장돼 나간다"는 결함 클래스를 구조적으로 내포한다 — 정확히 이 클래스가 story
#2459(2026-08-05, commit 3ab2a5c26)에서 독립적으로 재발견·수정됐다: `model_validate` 直前
`await db.refresh(story)`를 stories.py 3곳(update_story 포함)에 추가하고, 코드베이스 전수
"commit-then-model_validate" 20곳을 CI lint(`commit-before-validate-lint`)로 막아 뒀다. 즉
#2044가 보고한 원 트리거(속성 unload→MissingGreenlet)는 #2459가 먼저 닫았다.

그러나 #2459의 수정 범위는 "model_validate 直前 refresh"에 한정됐다 — `emit_story_assignee_
changed`·4개 `_attach_*` enrichment 호출은 여전히 **commit 뒤·비try/except**였다(AC2가 요구하는
"성공한 쓰기는 항상 200"이라는 일반 원칙은 MissingGreenlet 하나만으론 안 닫힌다). 이 파일의
①이 그 잔여 취약점을 실측한다 — 실 attachments PATCH가 최종 응답 직전 임의 enrichment
단계에서 예외를 만나도 500이 아니라 200을 내는지, 그리고 그 write가 실제로 committed 상태로
남아 있는지(재조회 값과 응답 값이 일치) 값으로 잰다.

②는 AC4(상한 초과 상태코드 통일)를 실측한다: mcp-선언한도 초과(예전 400)·개수 상한(10, 422)·
개별 크기 상한(100MB, 422)이 이제 전부 422로 수렴하고, 메시지에 실측값(몇 개/몇 바이트)이
실리는지 값으로 확인한다.

#2853/#2845/#2857과 동일 정신 — 격리 로컬 throwaway realdb만 사용(라이브 배포 시스템 무접촉).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.background import BackgroundTasks

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("20440000-0000-0000-0000-000000000101")
USER = uuid.UUID("20440000-0000-0000-0000-0000000101a1")
OM = uuid.UUID("20440000-0000-0000-0000-0000000101b1")
PROJ = uuid.UUID("20440000-0000-0000-0000-0000000101c1")
STORY = uuid.UUID("20440000-0000-0000-0000-0000000101d1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2044','s2044-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','u@s2044.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s2044-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OM}','granted','owner')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog','medium')",
    ]:
        await s.execute(text(sql))
    await s.commit()


# ───── ① commit 뒤 enrichment가 죽어도 write는 살고 응답도 200이어야 한다(AC2 핵심) ─────

@pytest.mark.anyio
async def test_attachment_patch_returns_200_and_persists_even_if_enrichment_raises():
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        body = StoryUpdate(attachments=[{
            "url": "https://storage.googleapis.com/sprintable-memo-attachments/s2044/f.pdf",
            "name": "f.pdf", "content_type": "application/pdf", "size": 111,
        }])

        async def _boom(*_a, **_kw):
            raise RuntimeError("simulated enrichment failure(#2044 load-bearing probe)")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            # commit() 뒤 최초로 도는 enrichment 하나를 강제로 죽인다 — 하드닝 前엔 이 예외가
            # 그대로 update_story 밖으로 전파돼 FastAPI가 500을 냈다(write는 이미 committed).
            with patch("app.routers.stories._attach_has_evidence", _boom):
                resp = await update_story(STORY, body, bg, repo, s, _auth_human(USER))

        assert resp.attachments and resp.attachments[0]["name"] == "f.pdf", (
            "enrichment 실패가 응답 자체를 막으면 안 된다 — 핵심 필드(attachments)는 살아있어야 하는"
        )

        async with Session() as s:
            row = (await s.execute(text(
                f"SELECT attachments FROM stories WHERE id='{STORY}'"
            ))).first()
        assert row is not None and row[0] and row[0][0]["name"] == "f.pdf", (
            "write 자체가 이미 commit돼 있어야 한다 — 이게 비어 있으면 하드닝이 아니라 "
            "그냥 write까지 날아간 것(AC2가 금지하는 반대 방향의 실패)"
        )
    finally:
        await eng.dispose()



# ───── ② AC4 — 상한 초과가 전부 422로 수렴 + 실측값이 메시지에 실린다 ─────

def test_mcp_declared_limit_exceeded_is_422_with_measured_counts():
    from app.routers.stories import _enforce_mcp_attachment_declared_limit
    from app.services import mcp_attachment_upload

    over_limit = [
        {
            "url": f"org/{ORG}/project/{PROJ}/story/{STORY}/mcp/f{i}.bin",
            "size": mcp_attachment_upload.MCP_MAX_TOTAL_ATTACHMENT_BYTES,
        }
        for i in range(mcp_attachment_upload.MCP_MAX_ATTACHMENTS + 1)
    ]
    with pytest.raises(HTTPException) as exc_info:
        _enforce_mcp_attachment_declared_limit(over_limit)
    assert exc_info.value.status_code == 422, "mcp 선언한도 초과는 이제 422(개수/크기 상한과 동일 코드)"
    assert str(mcp_attachment_upload.MCP_MAX_ATTACHMENTS + 1) in exc_info.value.detail, (
        "메시지에 실제 개수가 실려야 한다(AC4: 무엇이 몇 개를 넘었는지)"
    )


def test_story_attachment_count_limit_exceeded_is_422_with_measured_count():
    from app.schemas.story import StoryAttachment, StoryUpdate

    too_many = [
        StoryAttachment(url=f"https://x.test/{i}.png", name=f"{i}.png", content_type="image/png", size=1)
        for i in range(11)
    ]
    with pytest.raises(Exception) as exc_info:  # pydantic ValidationError → FastAPI가 422로 변환
        StoryUpdate(attachments=too_many)
    assert "11" in str(exc_info.value), "메시지에 실제 첨부 개수(11)가 실려야 한다"


def test_story_attachment_size_limit_exceeded_is_422_with_measured_bytes():
    from app.schemas.story import StoryAttachment

    oversized = 100 * 1024 * 1024 + 1
    with pytest.raises(Exception) as exc_info:
        StoryAttachment(url="https://x.test/big.png", name="big.png", content_type="image/png", size=oversized)
    assert str(oversized) in str(exc_info.value), "메시지에 실제 바이트 수가 실려야 한다"

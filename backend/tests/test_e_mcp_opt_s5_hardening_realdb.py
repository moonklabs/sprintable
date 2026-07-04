"""E-MCP-OPT S5 (34e69685) #2 — 실 Postgres: mcp-origin 첨부 선언 한도(5개/6MiB) 우회 봉쇄.

`upload_conversation_attachment`가 파일당 2MiB만 체크하고 선언 총량(5개/6MiB)을 강제하지 않아,
participant가 다회 개별 업로드(각 ≤2MiB)로 메시지당 최대 10개(기존 message-level 캡)까지 모아
SSOT 정책을 우회할 수 있었다(까심 QA #2). `send_message`가 mcp-origin(첨부 url이
`.../chat/<conv>/mcp/<file>` shape) 부분집합에 한해 선언 한도를 재검증하는지 실 DB+실
upload_conversation_attachment 왕복으로 확인한다.
"""
from __future__ import annotations

import base64
import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab800000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab800000-0000-0000-0000-000000000002")
CONV = uuid.UUID("ab800000-0000-0000-0000-000000000003")
AGENT = uuid.UUID("ab800000-0000-0000-0000-0000000000a1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(member_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM conversation_participants WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S5HARD','s5hard-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT}','{ORG}','agent','Agent')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT}','granted')",
        f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{CONV}','{ORG}','{PROJ}','group')",
        f"INSERT INTO conversation_participants (conversation_id,member_id) VALUES ('{CONV}','{AGENT}')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_many_individual_uploads_then_send_message_rejects_over_declared_limit(monkeypatch, tmp_path):
    """6개(> 5개 cap)를 개별 업로드(각 1.5MiB, 합 9MiB > 6MiB)한 뒤 그 6개 전부를 참조하는
    send_message 는 400 — 우회 봉쇄. 이전(fix 前)엔 message-level 캡(10)만 걸려 통과했다."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import (
        MessageAttachment,
        SendMessageRequest,
        UploadConversationAttachmentRequest,
        send_message,
        upload_conversation_attachment,
    )

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        uploaded: list[MessageAttachment] = []
        async with Session() as s:
            for i in range(6):
                raw = b"a" * (1024 * 1024)  # 1MiB (per-file 2MiB 캡 안쪽)
                body = UploadConversationAttachmentRequest(
                    content_base64=base64.b64encode(raw).decode(),
                    name=f"f{i}.bin", content_type="application/octet-stream",
                )
                resp = await upload_conversation_attachment(
                    CONV, body, db=s, auth=_auth(AGENT), org_id=ORG,
                )
                uploaded.append(resp)

        assert all("/mcp/" in a.url for a in uploaded)
        total = sum(a.size for a in uploaded)
        assert len(uploaded) == 6 and total == 6 * 1024 * 1024  # 6개>5·6MiB 경계선 초과

        async with Session() as s:
            send_body = SendMessageRequest(content="here are my files", attachments=uploaded)
            with pytest.raises(HTTPException) as ei:
                await send_message(
                    CONV, send_body, BackgroundTasks(), db=s, auth=_auth(AGENT), org_id=ORG,
                )
            assert ei.value.status_code == 400

            # 부분 커밋 없음 확인 — 메시지가 실제로 생성 안 됐는지.
            cnt = (await s.execute(
                text("SELECT count(*) FROM conversation_messages WHERE conversation_id=:c"),
                {"c": CONV},
            )).scalar_one()
            assert cnt == 0
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_within_declared_limit_send_message_succeeds(monkeypatch, tmp_path):
    """5개 이하·6MiB 이하면 정상 전송(회귀0 — 정당한 사용은 막히지 않음)."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import (
        SendMessageRequest,
        UploadConversationAttachmentRequest,
        send_message,
        upload_conversation_attachment,
    )

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        uploaded = []
        async with Session() as s:
            for i in range(3):
                raw = b"a" * (1024 * 1024)
                body = UploadConversationAttachmentRequest(
                    content_base64=base64.b64encode(raw).decode(),
                    name=f"ok{i}.bin", content_type="application/octet-stream",
                )
                uploaded.append(await upload_conversation_attachment(
                    CONV, body, db=s, auth=_auth(AGENT), org_id=ORG,
                ))

        async with Session() as s:
            send_body = SendMessageRequest(content="within limit", attachments=uploaded)
            resp = await send_message(
                CONV, send_body, BackgroundTasks(), db=s, auth=_auth(AGENT), org_id=ORG,
            )
            assert resp["data"]["id"]
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_messages WHERE conversation_id=:c"), {"c": CONV})
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
async def test_fe_uploaded_non_mcp_attachments_unaffected_by_mcp_cap(monkeypatch, tmp_path):
    """FE(비-MCP) 첨부는 mcp/ 마커가 없어 이 새 한도의 영향을 받지 않는다(회귀0) — 6개(>5)를 FE-style
    bare path 로 시뮬레이션해도 send_message 는 (기존 message-level 캡 10 이내라면) 통과해야 한다."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import MessageAttachment, SendMessageRequest, send_message

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        # FE-style 업로드 시뮬레이션 — mcp/ 세그먼트 없는 bare path(실제 FE 라우트가 만드는 shape).
        fe_attachments = [
            MessageAttachment(
                url=f"org/{ORG}/project/{PROJ}/chat/{CONV}/{uuid.uuid4()}-f{i}.png",
                name=f"f{i}.png", content_type="image/png", size=1024 * 1024,
            )
            for i in range(6)
        ]
        async with Session() as s:
            send_body = SendMessageRequest(content="fe upload", attachments=fe_attachments)
            resp = await send_message(
                CONV, send_body, BackgroundTasks(), db=s, auth=_auth(AGENT), org_id=ORG,
            )
            assert resp["data"]["id"]
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_messages WHERE conversation_id=:c"), {"c": CONV})
            await s.commit()
        await eng.dispose()

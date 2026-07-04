"""E-MCP-OPT S2 (bbfd24ba): 신규 `POST /{conversation_id}/attachments` 실 Postgres + 실 storage 검증.

MCP(비-브라우저)가 chat 첨부를 올릴 수 있게 하는 새 엔드포인트. 인가는 `send_message`의 실제
발신 요건과 동일해야 한다(참가자 필수·admin-agent-only-conversation 우회 없음 — 그 우회는
GET(list/get_conversation) 전용). 이 테스트는 실 Postgres(seed) + 실 StorageProvider(local disk)로
①참가자 업로드 성공+정확한 S7 path+실제 바이트 write ②비참가자 403 ③base64 오류 400 ④크기초과 413
을 검증한다.
"""
from __future__ import annotations

import base64
import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab700000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab700000-0000-0000-0000-000000000002")
CONV = uuid.UUID("ab700000-0000-0000-0000-000000000003")
AGENT_IN = uuid.UUID("ab700000-0000-0000-0000-0000000000a1")   # conversation 참가자
AGENT_OUT = uuid.UUID("ab700000-0000-0000-0000-0000000000a2")  # project grant는 있으나 비참가자


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
    # team_members 는 뷰(members ⋈ project_access, 0110 3번째 agent-grant-only UNION 브랜치) —
    # 직접 INSERT/DELETE 불가. members + project_access 만 심으면 뷰가 자동 파생.
    for sql in [
        f"DELETE FROM conversation_participants WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2ATT','s2att-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_IN}','{ORG}','agent','AgentIn')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_OUT}','{ORG}','agent','AgentOut')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES "
        f"('{PROJ}','{AGENT_IN}','granted')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES "
        f"('{PROJ}','{AGENT_OUT}','granted')",
        f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{CONV}','{ORG}','{PROJ}','group')",
        f"INSERT INTO conversation_participants (conversation_id,member_id) VALUES ('{CONV}','{AGENT_IN}')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_participant_upload_writes_real_bytes_at_s7_path(monkeypatch, tmp_path):
    """참가자 업로드 성공 — 정확한 S7 shape·실제 로컬 스토리지에 실 바이트 write 확인."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import UploadConversationAttachmentRequest, upload_conversation_attachment
    from app.services.storage import get_storage_provider
    from app.services.asset_registry import DEFAULT_CONTAINER

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            raw = b"\x89PNG\r\n\x1a\nfake-png-bytes"
            body = UploadConversationAttachmentRequest(
                content_base64=base64.b64encode(raw).decode(),
                name="../../evil../screenshot.png",
                content_type="image/png",
            )
            resp = await upload_conversation_attachment(
                CONV, body, db=s, auth=_auth(AGENT_IN), org_id=ORG,
            )
            assert resp.size == len(raw)
            assert resp.content_type == "image/png"
            # S7 shape — FE 업로드 라우트와 정확히 동일: org/<org>/project/<project>/chat/<conv>/<file>
            prefix = f"org/{ORG}/project/{PROJ}/chat/{CONV}/"
            assert resp.url.startswith(prefix)
            # traversal/부적절 문자 제거됨(파일명 안전화) — path 안에 ".." 세그먼트 없음.
            assert ".." not in resp.url.split("/")

            # 실제 바이트가 그 경로에 그대로 물리적으로 존재하는지 storage provider로 직접 재확인.
            object_path = resp.url
            downloaded = await get_storage_provider().download_object(DEFAULT_CONTAINER, object_path)
            assert downloaded == raw
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_participants WHERE conversation_id=:c"), {"c": CONV})
        await eng.dispose()


@pytest.mark.anyio
async def test_non_participant_agent_rejected_403(monkeypatch, tmp_path):
    """project access는 있으나 conversation 비참가자인 에이전트 — send_message와 동일하게 403.

    admin-agent-only-conversation 우회는 여기 적용되지 않는다(그 우회는 GET 전용) — 비참가자는
    project_access grant가 있어도 업로드 불가여야 send_chat_message의 최종 403과 정합된다.
    """
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import UploadConversationAttachmentRequest, upload_conversation_attachment

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = UploadConversationAttachmentRequest(
                content_base64=base64.b64encode(b"x").decode(), name="f.txt", content_type="text/plain",
            )
            with pytest.raises(HTTPException) as ei:
                await upload_conversation_attachment(CONV, body, db=s, auth=_auth(AGENT_OUT), org_id=ORG)
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_invalid_base64_rejected_400(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import UploadConversationAttachmentRequest, upload_conversation_attachment

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = UploadConversationAttachmentRequest(
                content_base64="not-valid-base64!!!", name="f.txt", content_type="text/plain",
            )
            with pytest.raises(HTTPException) as ei:
                await upload_conversation_attachment(CONV, body, db=s, auth=_auth(AGENT_IN), org_id=ORG)
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_oversized_decoded_payload_rejected_413(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import (
        UploadConversationAttachmentRequest,
        _MAX_JSON_ATTACHMENT_UPLOAD_SIZE,
        upload_conversation_attachment,
    )

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            oversized = b"a" * (_MAX_JSON_ATTACHMENT_UPLOAD_SIZE + 1)
            body = UploadConversationAttachmentRequest(
                content_base64=base64.b64encode(oversized).decode(),
                name="big.bin", content_type="application/octet-stream",
            )
            with pytest.raises(HTTPException) as ei:
                await upload_conversation_attachment(CONV, body, db=s, auth=_auth(AGENT_IN), org_id=ORG)
            assert ei.value.status_code == 413
    finally:
        await eng.dispose()

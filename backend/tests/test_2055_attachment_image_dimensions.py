"""story #2055: 첨부 이미지의 가로·세로 크기를 서버가 업로드 시점에 측정해 저장한다.

AC1: 서버가 잰다(client 제공값은 위조 가능 — asset_id와 동일한 server-authority 취급).
AC2: 첨부 조회 응답에 크기가 포함된다.
AC3: 기존(크기 없음) 첨부는 폴백 — additive·nullable이라 자연히 만족(백필 안 함, 별도 판단
   불요 — 새 필드가 없으면 None일 뿐 깨지지 않는다).
AC4: 비이미지 첨부는 이 필드가 없는 것이 정상.

이 파일 구성:
- image_dimensions.py 단위 테스트(스토리지/DB 불필요 — 순수 함수 레벨).
- realdb: send_message가 client 제공 width/height(위조 시나리오)를 무시하고 서버 실측값으로
  덮어쓰는 것을 실제 로컬 스토리지+실 PG 왕복으로 실증(test_e_mcp_opt_s5 seed 패턴 재사용).
- realdb: create_story도 동일.
"""
from __future__ import annotations

import base64
import os
import struct
import uuid
import zlib

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_png(width: int, height: int) -> bytes:
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr_type = b"IHDR"
    crc = struct.pack(">I", zlib.crc32(ihdr_type + ihdr_data) & 0xFFFFFFFF)
    return sig + struct.pack(">I", len(ihdr_data)) + ihdr_type + ihdr_data + crc


# ══════════════════════════ image_dimensions.py 단위 테스트 ══════════════════════════


def test_measure_from_bytes_valid_png():
    from app.services.image_dimensions import measure_image_dimensions_from_bytes

    assert measure_image_dimensions_from_bytes("image/png", _make_png(200, 400)) == (200, 400)


def test_measure_from_bytes_non_image_content_type_returns_none_immediately():
    from app.services.image_dimensions import measure_image_dimensions_from_bytes

    # 비이미지는 바이트가 뭐든(파싱 시도조차 안 함) None — AC4.
    assert measure_image_dimensions_from_bytes("application/pdf", _make_png(200, 400)) is None


def test_measure_from_bytes_corrupt_image_best_effort_none():
    from app.services.image_dimensions import measure_image_dimensions_from_bytes

    assert measure_image_dimensions_from_bytes("image/png", b"not a real png") is None


def test_measure_from_bytes_truncated_png_garbage_header_rejected():
    """오르테가 PO 리뷰 발견: imagesize는 청크 구조를 검증 안 해 시그니처 뒤 쓰레기 바이트를
    그대로 큰 양수 width/height로 읽는다(예: 19억×16억) — 상한(_MAX_PLAUSIBLE_DIMENSION)으로
    걸러내는지 실증. 이게 없으면 손상 파일이 '측정 성공'으로 오판돼 FE에 터무니없는 자리
    예약값이 흘러간다."""
    from app.services.image_dimensions import measure_image_dimensions_from_bytes

    corrupt = b"\x89PNG\r\n\x1a\ntruncated-not-a-real-header"
    assert measure_image_dimensions_from_bytes("image/png", corrupt) is None


@pytest.mark.anyio
async def test_measure_image_dimensions_downloads_and_parses(monkeypatch):
    from unittest.mock import AsyncMock, patch

    from app.services.image_dimensions import measure_image_dimensions

    png = _make_png(50, 60)
    fake_provider = AsyncMock()
    fake_provider.download_object = AsyncMock(return_value=png)
    with patch(
        "app.services.image_dimensions.get_storage_provider", return_value=fake_provider,
    ):
        result = await measure_image_dimensions("image/png", "org/x/project/y/chat/z/img.png")
    assert result == (50, 60)
    fake_provider.download_object.assert_awaited_once()


@pytest.mark.anyio
async def test_measure_image_dimensions_external_url_returns_none_no_download():
    from unittest.mock import AsyncMock, patch

    from app.services.image_dimensions import measure_image_dimensions

    fake_provider = AsyncMock()
    with patch(
        "app.services.image_dimensions.get_storage_provider", return_value=fake_provider,
    ):
        result = await measure_image_dimensions("image/png", "https://evil.example.com/x.png")
    assert result is None
    fake_provider.download_object.assert_not_awaited()


@pytest.mark.anyio
async def test_measure_image_dimensions_download_failure_best_effort_none():
    from unittest.mock import AsyncMock, patch

    from app.services.image_dimensions import measure_image_dimensions

    fake_provider = AsyncMock()
    fake_provider.download_object = AsyncMock(side_effect=Exception("storage unreachable"))
    with patch(
        "app.services.image_dimensions.get_storage_provider", return_value=fake_provider,
    ):
        result = await measure_image_dimensions("image/png", "org/x/project/y/chat/z/img.png")
    assert result is None


# ══════════════════════════ realdb: server-authority 실증 ══════════════════════════

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("2055aaaa-0000-0000-0000-000000000001")
PROJ = uuid.UUID("2055aaaa-0000-0000-0000-000000000002")
CONV = uuid.UUID("2055aaaa-0000-0000-0000-000000000003")
AGENT = uuid.UUID("2055aaaa-0000-0000-0000-0000000000a1")


def _auth(member_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed_chat(s) -> None:
    for sql in [
        f"DELETE FROM conversation_participants WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2055','s2055-org','free')",
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
async def test_send_message_ignores_client_dimensions_uses_server_measured(monkeypatch, tmp_path):
    """client가 MessageAttachment.width/height에 위조값(99999)을 실어도, 실제 업로드된 이미지의
    진짜 크기(200x400)로 서버가 덮어쓴다 — AC1 server-authority 실증(#2055 headline)."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import MessageAttachment, SendMessageRequest, send_message
    from app.services.asset_registry import DEFAULT_CONTAINER
    from app.services.storage import get_storage_provider

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_chat(s)

        object_path = f"org/{ORG}/project/{PROJ}/chat/{CONV}/real-photo.png"
        real_png = _make_png(200, 400)
        await get_storage_provider().put_object(
            DEFAULT_CONTAINER, object_path, real_png, content_type="image/png",
        )

        async with Session() as s:
            forged = MessageAttachment(
                url=object_path, name="real-photo.png", content_type="image/png",
                size=len(real_png), width=99999, height=99999,  # client 위조 시도
            )
            send_body = SendMessageRequest(content="사진 첨부", attachments=[forged])
            resp = await send_message(
                CONV, send_body, BackgroundTasks(), db=s, auth=_auth(AGENT), org_id=ORG,
            )
            saved = resp["data"]["attachments"][0]
            assert saved["width"] == 200, saved
            assert saved["height"] == 400, saved

            # 재조회로도 확인(fire-and-forget/캐시 오독 방지 — feedback_verify_commit_race).
            row = (await s.execute(
                text("SELECT attachments FROM conversation_messages WHERE conversation_id=:c"),
                {"c": CONV},
            )).scalar_one()
            assert row[0]["width"] == 200
            assert row[0]["height"] == 400
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_messages WHERE conversation_id=:c"), {"c": CONV})
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
async def test_send_message_non_image_attachment_no_dimensions(monkeypatch, tmp_path):
    """AC4: 비이미지 첨부는 width/height가 없다(None)."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import MessageAttachment, SendMessageRequest, send_message
    from app.services.asset_registry import DEFAULT_CONTAINER
    from app.services.storage import get_storage_provider

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_chat(s)

        object_path = f"org/{ORG}/project/{PROJ}/chat/{CONV}/doc.pdf"
        pdf_bytes = b"%PDF-1.4 fake"
        await get_storage_provider().put_object(
            DEFAULT_CONTAINER, object_path, pdf_bytes, content_type="application/pdf",
        )

        async with Session() as s:
            att = MessageAttachment(
                url=object_path, name="doc.pdf", content_type="application/pdf", size=len(pdf_bytes),
            )
            send_body = SendMessageRequest(content="문서 첨부", attachments=[att])
            resp = await send_message(
                CONV, send_body, BackgroundTasks(), db=s, auth=_auth(AGENT), org_id=ORG,
            )
            saved = resp["data"]["attachments"][0]
            assert saved.get("width") is None
            assert saved.get("height") is None
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_messages WHERE conversation_id=:c"), {"c": CONV})
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
async def test_send_message_corrupt_image_measurement_failure_does_not_block_send(monkeypatch, tmp_path):
    """오르테가 PO 확認 요청: 측정 실패(손상/미지원 헤더)가 전송 자체를 막으면 안 된다 — 못 재면
    null로 두고 메시지는 정상 전송돼야 한다(#2050 고정 프레임 폴백이 그 null을 받는 전제)."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.conversations import MessageAttachment, SendMessageRequest, send_message
    from app.services.asset_registry import DEFAULT_CONTAINER
    from app.services.storage import get_storage_provider

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_chat(s)

        # content_type은 image/png라고 주장하지만 실제로는 파싱 불가능한 손상/잘린 바이트.
        object_path = f"org/{ORG}/project/{PROJ}/chat/{CONV}/broken.png"
        corrupt_bytes = b"\x89PNG\r\n\x1a\ntruncated-not-a-real-header"
        await get_storage_provider().put_object(
            DEFAULT_CONTAINER, object_path, corrupt_bytes, content_type="image/png",
        )

        async with Session() as s:
            att = MessageAttachment(
                url=object_path, name="broken.png", content_type="image/png", size=len(corrupt_bytes),
            )
            send_body = SendMessageRequest(content="깨진 이미지 첨부", attachments=[att])
            # 예외 없이 정상 전송돼야 한다 — raise 되면 이 assert 전에 테스트가 이미 실패한다.
            resp = await send_message(
                CONV, send_body, BackgroundTasks(), db=s, auth=_auth(AGENT), org_id=ORG,
            )
            saved = resp["data"]["attachments"][0]
            assert saved.get("width") is None
            assert saved.get("height") is None
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_messages WHERE conversation_id=:c"), {"c": CONV})
            await s.commit()
        await eng.dispose()


# ── stories.py: create_story 동일 실증 ─────────────────────────────────────────

PROJ2 = uuid.UUID("2055bbbb-0000-0000-0000-000000000002")
ORG2 = uuid.UUID("2055bbbb-0000-0000-0000-000000000001")
USER2 = uuid.UUID("2055bbbb-0000-0000-0000-0000000000e1")


async def _seed_story_project(s):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=ORG2, name="Org2055", slug="org-2055-story")
    s.add(org)
    await s.commit()
    project = Project(id=PROJ2, org_id=ORG2, name="P")
    s.add(project)
    await s.commit()
    user = User(id=USER2, email="u2055@test.com", hashed_password="x")
    s.add(user)
    await s.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=ORG2, user_id=USER2, role="member")
    s.add(om)
    s.add(ProjectAccess(id=uuid.uuid4(), project_id=PROJ2, org_member_id=om.id, permission="granted", role="member"))
    await s.commit()


@pytest.mark.anyio
async def test_create_story_ignores_client_dimensions_uses_server_measured(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from fastapi import BackgroundTasks

    from app.dependencies.auth import AuthContext
    from app.routers.stories import create_story
    from app.schemas.story import StoryAttachment, StoryCreate
    from app.services.asset_registry import DEFAULT_CONTAINER
    from app.services.storage import get_storage_provider

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(text(f"DELETE FROM stories WHERE project_id='{PROJ2}'"))
            await s.execute(text(f"DELETE FROM project_access WHERE project_id='{PROJ2}'"))
            await s.execute(text(f"DELETE FROM org_members WHERE org_id='{ORG2}'"))
            await s.execute(text(f"DELETE FROM users WHERE id='{USER2}'"))
            await s.execute(text(f"DELETE FROM projects WHERE org_id='{ORG2}'"))
            await s.execute(text(f"DELETE FROM organizations WHERE id='{ORG2}'"))
            await s.commit()
            await _seed_story_project(s)

        object_path = f"org/{ORG2}/project/{PROJ2}/story/mock/real-photo.png"
        real_png = _make_png(150, 250)
        await get_storage_provider().put_object(
            DEFAULT_CONTAINER, object_path, real_png, content_type="image/png",
        )

        async with Session() as s:
            forged = StoryAttachment(
                url=object_path, name="real-photo.png", content_type="image/png",
                size=len(real_png), width=1, height=1,  # client 위조 시도
            )
            body = StoryCreate(
                project_id=PROJ2, org_id=ORG2, title="첨부 테스트", attachments=[forged],
            )
            auth = AuthContext(user_id=str(USER2), email="u2055@test.com", claims={"app_metadata": {}})
            resp = await create_story(
                body=body, background_tasks=BackgroundTasks(), session=s, auth=auth, org_id=ORG2,
            )
            saved = resp.attachments[0]
            assert saved["width"] == 150, saved
            assert saved["height"] == 250, saved
    finally:
        async with Session() as s:
            await s.execute(text(f"DELETE FROM stories WHERE project_id='{PROJ2}'"))
            await s.commit()
        await engine.dispose()

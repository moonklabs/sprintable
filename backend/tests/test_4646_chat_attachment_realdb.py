"""story 4646 — 첨부 읽기 엔드포인트의 권한 경계를 실 PG로 고정한다(까디르 렌즈 5032 막음 사유 ①②).

- ① 교차 조직: 다른 조직 사용자는 이 대화의 첨부를 읽지 못한다(404) · 같은 사용자의 양성 대조는 읽힌다.
- ② 대상 조직 경로: 다른 조직 접두어의 저장 경로를 가진 첨부는 읽지 않는다(404).
- ③ 메시지-대화 바인딩: 참가자가 두 대화에 다 있어도, 대화 A 경로로 대화 B의 메시지 id를 주면 404다.
  (conversation_id 조건을 빼는 뮤턴트는 이 테스트에서 RED가 된다 — 가짜 DB 시험은 못 잡는 칸.)

저장소는 가짜로 둔다(실 GCS 호출 없음). 인가 · 쿼리는 실제 코드 그대로.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest

from tests.test_1994_backlink_api_realdb import (
    _add_message,
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
    _t,
)

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


class _FakeStorage:
    """head 크기 5 · 본문 b'hello' — 텍스트 첨부 하나를 읽을 수 있는 최소 저장소."""

    async def head_object(self, container, path):
        return 5

    async def download_object(self, container, path):
        return b"hello"


def _url_of(path: str) -> str:
    return f"https://storage.googleapis.com/sprintable-memo-attachments/{path}"


async def test_other_org_user_cannot_read_attachment_and_same_org_can():
    """① 교차 조직 — 대화는 A 조직 · 요청자는 B 조직이면 404. 같은 대화를 A 조직 사용자가 읽으면 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, name="A")
            proj_a = await _make_project(s, org_a.id)
            caller_a_id, caller_a_user = await _make_human_member(s, org_a.id, proj_a.id)
            org_b = await _make_org(s, name="B")
            proj_b = await _make_project(s, org_b.id)
            _, other_b_user = await _make_human_member(s, org_b.id, proj_b.id)
            conv_id = await _make_conversation(s, org_a.id, proj_a.id, [caller_a_id], created_by=caller_a_id, conv_type="dm")
            path = f"org/{org_a.id}/project/{proj_a.id}/chat/{conv_id}/note.txt"
            msg = await _add_message(s, conv_id, caller_a_id, "메모", _t(1))
            msg.attachments = [{"name": "note.txt", "content_type": "text/plain", "url": _url_of(path)}]
            await s.commit()
            msg_id = msg.id

        url = f"/api/v2/conversations/{conv_id}/messages/{msg_id}/attachments/0/content"
        client = _client_for(app)
        try:
            with patch("app.services.chat_attachment_service.get_storage_provider", return_value=_FakeStorage()):
                await _setup_app_human(app, Session, other_b_user, org_b.id)
                denied = await client.get(url)
                assert denied.status_code == 404, denied.text

                await _setup_app_human(app, Session, caller_a_user, org_a.id)
                allowed = await client.get(url)
                assert allowed.status_code == 200, allowed.text
                assert allowed.json()["kind"] == "text" and allowed.json()["text"] == "hello"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_attachment_key_from_another_org_prefix_is_not_read():
    """② 대상 조직 경로 — 대화는 A 조직인데 저장 경로가 B 조직 접두어면 읽지 않는다(404)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, name="A")
            proj_a = await _make_project(s, org_a.id)
            caller_a_id, caller_a_user = await _make_human_member(s, org_a.id, proj_a.id)
            org_b = await _make_org(s, name="B")
            proj_b = await _make_project(s, org_b.id)
            conv_id = await _make_conversation(s, org_a.id, proj_a.id, [caller_a_id], created_by=caller_a_id, conv_type="dm")
            foreign = f"org/{org_b.id}/project/{proj_b.id}/chat/{conv_id}/note.txt"
            msg = await _add_message(s, conv_id, caller_a_id, "메모", _t(1))
            msg.attachments = [{"name": "note.txt", "content_type": "text/plain", "url": _url_of(foreign)}]
            await s.commit()
            msg_id = msg.id

        client = _client_for(app)
        try:
            with patch("app.services.chat_attachment_service.get_storage_provider", return_value=_FakeStorage()):
                await _setup_app_human(app, Session, caller_a_user, org_a.id)
                r = await client.get(f"/api/v2/conversations/{conv_id}/messages/{msg_id}/attachments/0/content")
                assert r.status_code == 404, r.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_message_id_from_another_conversation_is_not_found():
    """③ 메시지-대화 바인딩 — 참가자가 두 대화 모두에 있다. 메시지는 대화 B에, 경로는 대화 A로 준다.
    저장 경로는 대화 A 것(범위 검사는 통과하는 값)이어야 뮤턴트(conversation_id 조건 제거)가 실제로 새어 나온다.
    올바른 구현은 404 "Message not found" — 뮤턴트는 200이 되어 이 테스트가 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            proj = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, proj.id)
            conv_a = await _make_conversation(s, org.id, proj.id, [caller_id], created_by=caller_id, conv_type="dm")
            conv_b = await _make_conversation(s, org.id, proj.id, [caller_id], created_by=caller_id, conv_type="dm")
            path_a = f"org/{org.id}/project/{proj.id}/chat/{conv_a}/note.txt"
            msg_b = await _add_message(s, conv_b, caller_id, "대화 B 메시지", _t(1))
            msg_b.attachments = [{"name": "note.txt", "content_type": "text/plain", "url": _url_of(path_a)}]
            await s.commit()
            msg_b_id = msg_b.id

        client = _client_for(app)
        try:
            with patch("app.services.chat_attachment_service.get_storage_provider", return_value=_FakeStorage()):
                await _setup_app_human(app, Session, caller_user, org.id)
                r = await client.get(f"/api/v2/conversations/{conv_a}/messages/{msg_b_id}/attachments/0/content")
                assert r.status_code == 404, r.text
                assert r.json()["error"]["message"] == "Message not found"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()

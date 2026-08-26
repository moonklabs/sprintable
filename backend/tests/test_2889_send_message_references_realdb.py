"""story #2889(S2h ②) — #2263 AC6이 명시적으로 남겨둔 갭을 닫는다: 그 스토리 당시
"SSE 디스패치·POST 전송 응답은 references 키가 없다(기존 동작 무변경)"였던 것을, 이제
send_message의 HTTP 응답과 SSE Event payload 양쪽 다 읽기 경로(list/get)와 동일한
`references[]`(list, 빈 배열도 명시)로 채운다 — 방금 보낸 메시지가 새로고침 없이도
즉시 리치 임베드로 뜨게 하는 것이 목적(유나 S2 스펙 §8②).

test_2263_chat_message_read_references_realdb.py의 하네스(ASGI 실전송·실PG)를 그대로
재사용 — 이 파일은 그 스위트의 자매(읽기 경로가 아니라 **쓰기 응답 자체**를 검증)."""
from __future__ import annotations

import os
import uuid

import pytest

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


async def _setup(session):
    """org + project + human(members ⋈ project_access) + conversation(참가자=그 human) +
    두 번째 참가자(human B, SSE Event 수신자가 실재해야 _dispatch_conversation_event가
    실제로 payload를 만든다 — 발신자 본인은 exclude_ids에서 빠지므로 참가자가 1명뿐이면
    Event가 0건 생성돼 이 테스트의 SSE축을 검증할 수 없다)."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.conversation import Conversation, ConversationParticipant

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.flush()

    user_a = User(id=uuid.uuid4(), email=f"a-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    user_b = User(id=uuid.uuid4(), email=f"b-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add_all([user_a, user_b])
    await session.flush()

    member_a = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_a.id, name="A")
    member_b = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_b.id, name="B")
    session.add_all([member_a, member_b])
    await session.flush()
    session.add_all([
        ProjectAccess(project_id=project.id, member_id=member_a.id, permission="granted", role="member"),
        ProjectAccess(project_id=project.id, member_id=member_b.id, permission="granted", role="member"),
    ])
    await session.flush()

    conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", created_by=member_a.id)
    session.add(conv)
    await session.flush()
    session.add_all([
        ConversationParticipant(conversation_id=conv.id, member_id=member_a.id),
        ConversationParticipant(conversation_id=conv.id, member_id=member_b.id),
    ])
    await session.commit()
    return org, project, member_a, user_a, conv


async def _make_target_doc(session, org_id, project_id, title="Target"):
    from app.models.doc import Doc
    doc = Doc(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, slug=f"doc-{uuid.uuid4().hex[:8]}")
    session.add(doc)
    await session.commit()
    return doc


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _token(title: str, target_type: str, target_id) -> str:
    return f"[{title}](entity:{target_type}:{target_id})"


async def _send(client, conv_id, content, thread_id=None):
    body = {"content": content}
    if thread_id is not None:
        body["thread_id"] = str(thread_id)
    resp = await client.post(f"/api/v2/conversations/{conv_id}/messages", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _strip_referenced_at(refs: list[dict]) -> list[dict]:
    out = []
    for r in refs:
        assert "referenced_at" in r and r["referenced_at"]
        out.append({k: v for k, v in r.items() if k != "referenced_at"})
    return out


async def test_send_message_http_response_includes_rich_references_immediately():
    """POST 응답의 data.references가 GET(읽기 경로)과 동일 shape로 즉시 실린다 —
    #2263 AC6이 "다른 호출부는 이 키가 없다"고 명시했던 그 갭."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)
            target = await _make_target_doc(s, org.id, project.id)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            sent = await _send(client, conv.id, _token("Target", "doc", target.id))
            assert "references" in sent["data"], "POST 응답에 references 키 자체가 없음 — #2889 미해결"
            assert _strip_referenced_at(sent["data"]["references"]) == [
                {"target_type": "doc", "target_id": str(target.id), "form": "mention", "proof_payload": None}
            ]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_send_message_http_response_empty_references_is_explicit_list_not_missing():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            sent = await _send(client, conv.id, "no tokens here")
            assert sent["data"]["references"] == []
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_send_message_sse_event_payload_includes_references():
    """conversation.message_created Event(SSE push의 실 payload 원천, commit 후 push되는
    그 payload)에도 references가 실리는지 — Event 테이블 직접 조회로 확인(HTTP 응답과
    별개 채널이라 별도 검증 축)."""
    from sqlalchemy import select
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)
            target = await _make_target_doc(s, org.id, project.id)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            sent = await _send(client, conv.id, _token("Target", "doc", target.id))
            msg_id = sent["data"]["id"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            events = (await s.execute(
                select(Event).where(
                    Event.event_type == "conversation.message_created",
                    Event.source_entity_id == uuid.UUID(msg_id),
                )
            )).scalars().all()
            assert events, "message_created Event가 0건 — 참가자 B가 수신 대상이어야 함"
            for ev in events:
                assert "references" in ev.payload, f"SSE Event payload에 references 키 없음: {ev.payload}"
                assert _strip_referenced_at(ev.payload["references"]) == [
                    {"target_type": "doc", "target_id": str(target.id), "form": "mention", "proof_payload": None}
                ]
    finally:
        await engine.dispose()

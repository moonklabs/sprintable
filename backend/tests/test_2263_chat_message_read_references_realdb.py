"""story #2263 AC6 / #2262(C-4) 첫 발(오르테가 판정 2026-07-29, 스레드 7256d5cc) — 채팅
메시지 읽기 경로(GET list/단건/replies)가 그 메시지가 실제로 건 **stored** 참조를 실는지
실PG 검증.

배경: send 응답(`references.dropped[]`, #2294)은 보낸 그 순간에만 어느 토큰이 안 걸렸는지
말한다. 새로고침해서 `GET .../messages`로 다시 읽으면 그 사이드밴드가 없어 — 파서가
`content`를 재작성하지 않는 insert-only라 화면이 본문 정규식 매치만으로 칩을 그리므로,
dropped된 참조도 저장된 것과 똑같은 칩으로 보인다(유령 칩). 이 스토리는 그 읽기 축을 연다.

⛔범위: stored 참조(target_type·target_id)만 되살린다. dropped는 그 순간의 이야기라
영속이 아니므로 여기서 복원하지 않는다(오르테가 판정). 「상태·다음 행동」도 #2262 몫이라
여기선 안 얹는다.
"""
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
    """org + project + human(members ⋈ project_access) + conversation(참가자=그 human).

    ⛔story #2263 CI 회귀(오르테가 실측, 2026-07-29): `team_members`는 0088부터 **뷰**다
    (members ⋈ project_access, `_e_members_projection_view` 계열 마이그레이션 참조) — `TeamMember`
    ORM으로 직접 `session.add()`하면 로컬 `create_all`(진짜 테이블 재현)에서는 통과하지만 실
    마이그레이션된 스키마(CI)에서는 `cannot insert into view`로 죽는다(로컬/CI 스키마 드리프트,
    reference_local_realdb_pg16_pgvector 계열 함정과 동형). 그래서 뷰가 아니라 **뷰의 원재료**
    (`Member` + `ProjectAccess`)에 쓴다 — 뷰가 `m.id`를 그대로 투영하므로 `member.id`가
    곧 `team_members.id`(0075 ID 보존과 같은 원리). `_resolve_member`(conversations.py)는
    JWT 휴먼을 `TeamMember.user_id == auth.user_id`(뷰 경유)로 해소하므로 auth 신원은
    `member.id`가 아니라 `user.id`를 쓴다.

    `conversations.created_by`/`conversation_participants.member_id`는 현재 스키마에 FK가
    없다(schema.sql 확認) — `team_members(_legacy)`를 가리키는 값을 몰라도 무방, `member.id`를
    그대로 쓴다.
    """
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
    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    member = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user.id, name="Human")
    session.add(member)
    await session.flush()
    session.add(ProjectAccess(project_id=project.id, member_id=member.id, permission="granted", role="member"))
    await session.flush()
    conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", created_by=member.id)
    session.add(conv)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv.id, member_id=member.id))
    await session.commit()
    return org, project, member, user, conv


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
    from app.dependencies.database import get_db

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

    app.dependency_overrides[get_db] = _db
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


# ─── AC6①: 단건(get_message)이 stored 참조를 되살린다 ────────────────────────


async def test_get_message_returns_stored_reference_after_reload():
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
            assert sent["references"]["stored"] == 1

            # ⭐진짜 "새로고침" — 별개의 GET 왕복으로 다시 읽는다(send 응답 재사용 아님).
            resp = await client.get(f"/api/v2/conversations/{conv.id}/messages/{msg_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["references"] == [{"target_type": "doc", "target_id": str(target.id)}]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC6②: 목록(list_messages)도 같다 + N+1 방지(쿼리 1회) ──────────────────


async def test_list_messages_returns_stored_references_per_message_without_n_plus_1():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)
            target_a = await _make_target_doc(s, org.id, project.id, title="A")
            target_b = await _make_target_doc(s, org.id, project.id, title="B")

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            await _send(client, conv.id, _token("A", "doc", target_a.id))
            await _send(client, conv.id, "no tokens here")
            await _send(client, conv.id, _token("B", "doc", target_b.id))

            import app.services.mention_parser as mp
            calls = {"n": 0}
            _orig = mp.fetch_stored_references

            async def _counting(*a, **kw):
                calls["n"] += 1
                return await _orig(*a, **kw)

            mp.fetch_stored_references = _counting
            try:
                resp = await client.get(f"/api/v2/conversations/{conv.id}/messages")
            finally:
                mp.fetch_stored_references = _orig
            assert resp.status_code == 200, resp.text
            body = resp.json()
            msgs = body["data"]
            assert len(msgs) == 3
            by_content = {m["content"]: m["references"] for m in msgs}
            assert by_content[_token("A", "doc", target_a.id)] == [
                {"target_type": "doc", "target_id": str(target_a.id)}
            ]
            assert by_content["no tokens here"] == []
            assert by_content[_token("B", "doc", target_b.id)] == [
                {"target_type": "doc", "target_id": str(target_b.id)}
            ]
            # ⭐N+1 방지 — 메시지 3건인데 참조 조회는 페이지당 1회만 나가야 한다.
            assert calls["n"] == 1, f"페이지 1개에 참조 조회가 {calls['n']}번 나갔다(N+1)"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── 빈 것의 표현: references가 항상 실린다(빈 배열 ≠ 필드 누락) ─────────────


async def test_message_with_no_tokens_has_empty_references_list_not_missing_field():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            sent = await _send(client, conv.id, "plain text, no tokens")
            msg_id = sent["data"]["id"]

            resp = await client.get(f"/api/v2/conversations/{conv.id}/messages/{msg_id}")
            body = resp.json()
            assert "references" in body, "필드 자체가 빠졌다 — FE가 옛 서버인지 참조가 없는지 못 가른다"
            assert body["references"] == []
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── dropped는 읽기 경로에 복원되지 않는다(영속 아님, 설계상 의도) ──────────


async def test_dropped_reference_is_not_restored_on_reload_only_absence_from_stored():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            # registry 밖 target_type → dropped(unregistered_target_type), stored 0.
            sent = await _send(client, conv.id, _token("X", "goal", uuid.uuid4()))
            msg_id = sent["data"]["id"]
            assert sent["references"]["stored"] == 0
            assert sent["references"]["dropped"][0]["reason"] == "unregistered_target_type"

            resp = await client.get(f"/api/v2/conversations/{conv.id}/messages/{msg_id}")
            body = resp.json()
            # ⭐dropped 사유는 읽기 응답 어디에도 없다 — stored가 빈 것으로만 "안 걸렸다"가 드러난다.
            assert body["references"] == []
            assert "dropped" not in body
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── replies 목록도 동형 ──────────────────────────────────────────────────


async def test_list_message_replies_returns_stored_references():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, member, user, conv = await _setup(s)
            target = await _make_target_doc(s, org.id, project.id)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        client = _client_for(app)
        try:
            root = await _send(client, conv.id, "root message")
            root_id = root["data"]["id"]
            reply = await _send(client, conv.id, _token("Target", "doc", target.id), thread_id=root_id)
            reply_id = reply["data"]["id"]

            resp = await client.get(f"/api/v2/conversations/{conv.id}/messages/{root_id}/replies")
            assert resp.status_code == 200, resp.text
            replies = resp.json()["data"]
            assert len(replies) == 1
            assert replies[0]["id"] == reply_id
            assert replies[0]["references"] == [{"target_type": "doc", "target_id": str(target.id)}]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()

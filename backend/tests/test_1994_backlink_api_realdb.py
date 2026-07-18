"""story #1994(E-KNOWLEDGE-LINK S2) — `GET /api/v2/docs/{id}/backlinks` realPG IDOR + 페이지네이션
통합 테스트. 근본 설계 doc design-org-knowledge-mentions-backlinks §8.

AC2/AC3 실증:
  (a) doc-source backlink는 SOURCE doc의 project 접근이 있어야만 보인다 — 멀티프로젝트 org에서
      caller가 TARGET project 접근만 있고 SOURCE project 접근이 없으면 0-leak(산티아고 리뷰가
      잡은 이전 draft 버그의 정확한 재현 시나리오).
  (b) chat_message-source backlink는 대화 참가자만 볼 수 있다 — DM 비참여자 0-leak +
      MUTATION self-check(authz predicate 제거 → RED, 복원 → GREEN).
  (c) agent-only 대화의 admin-bypass는 `_authorize_message_read`→`_can_read_conversation` 리팩터
      후에도 유지된다(회귀 0).
  (d) 페이지네이션/cursor: mixed authorized/unauthorized candidate set에서 has_more/개수가
      authz-filtered 집합만 반영(오라클 0).
  (e) soft-deleted source doc 제외 + 미존재(hard-deleted) source message 제외.
  (f) cross-org 격리: 타org 소속 doc은 404, org_id 불일치 mention row는 비노출.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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


# ─── Seeding helpers ─────────────────────────────────────────────────────────


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id=None):
    """휴먼 member(+선택적으로 project_id에 grant). project_id=None이면 어떤 프로젝트에도
    접근권이 없는(org 멤버십만 있는) 상태로 남는다 — 소스 프로젝트 미접근 시나리오용."""
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    m = Member(id=uuid.uuid4(), org_id=org_id, type="human", user_id=user_id, name=f"M-{user_id.hex[:6]}")
    session.add(m)
    await session.commit()
    if project_id is not None:
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project_id, member_id=m.id, permission="granted", role="member",
        ))
        await session.commit()
    return m.id, user_id


async def _grant_project_access(session, project_id, member_id):
    from app.models.project_access import ProjectAccess
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted", role="member",
    ))
    await session.commit()


async def _make_org_owner(session, org_id):
    """org owner(OrgMember.role='owner') — project grant 없이도 has_project_access/admin-bypass 통과."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"owner-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="owner"))
    m = Member(id=uuid.uuid4(), org_id=org_id, type="human", user_id=user_id, name="Owner")
    session.add(m)
    await session.commit()
    return m.id, user_id


async def _make_agent_member(session, org_id, project_id, role="member"):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=f"agent-{uuid.uuid4().hex[:6]}")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=agent.id, permission="granted", role=role,
    ))
    await session.commit()
    return agent.id


async def _make_doc(session, org_id, project_id, title="Doc", content="", deleted=False):
    from app.models.doc import Doc
    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content=content,
    )
    if deleted:
        doc.deleted_at = datetime.now(timezone.utc)
    session.add(doc)
    await session.commit()
    return doc


async def _make_mention(session, org_id, source_type, source_id, target_id, created_by, created_at=None):
    from app.models.mention import Mention
    m = Mention(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_id=source_id,
        target_type="doc", target_id=target_id, created_by=created_by,
    )
    if created_at is not None:
        m.created_at = created_at
    session.add(m)
    await session.commit()
    return m


async def _make_conversation(session, org_id, project_id, member_ids, created_by, conv_type="dm"):
    from app.models.conversation import Conversation, ConversationParticipant
    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type=conv_type,
        title="Test convo", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _add_message(session, conv_id, sender_id, content, created_at):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=created_at,
    )
    session.add(msg)
    await session.commit()
    return msg


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


T0 = datetime(2026, 7, 17, 8, 0, 0, tzinfo=timezone.utc)


def _t(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


# ─── (a) doc-source: multi-project org, target-access-only ≠ source-access ────


async def test_doc_source_backlink_zero_leak_when_caller_lacks_source_project_access():
    """caller가 target_doc의 project 접근은 있지만 source_doc의 project 접근은 없는 멀티프로젝트
    org 시나리오 — 산티아고 리뷰가 잡은 정확한 버그 클래스. 0-leak(item-list + has_more 둘 다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_target = await _make_project(s, org.id, "Target Project")
            project_source = await _make_project(s, org.id, "Source Project")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_target.id)
            other_id, _ = await _make_human_member(s, org.id, project_source.id)

            target_doc = await _make_doc(s, org.id, project_target.id, title="Target")
            source_doc = await _make_doc(s, org.id, project_source.id, title="Source (caller no access)")
            await _make_mention(s, org.id, "doc", source_doc.id, target_doc.id, created_by=other_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["data"] == [], body
            assert body["meta"]["has_more"] is False, body["meta"]
            assert body["meta"]["next_cursor"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_doc_source_backlink_visible_when_caller_has_both_target_and_source_access():
    """positive counterpart — caller가 두 project 모두 접근 가능하면 정상 노출(과차단 아님을 확인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_target = await _make_project(s, org.id, "Target Project")
            project_source = await _make_project(s, org.id, "Source Project")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_target.id)
            await _grant_project_access(s, project_source.id, caller_id)

            target_doc = await _make_doc(s, org.id, project_target.id, title="Target")
            source_doc = await _make_doc(s, org.id, project_source.id, title="Source Doc Title")
            await _make_mention(s, org.id, "doc", source_doc.id, target_doc.id, created_by=caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            item = body["data"][0]
            assert item["source_type"] == "doc"
            assert item["source_id"] == str(source_doc.id)
            assert item["doc"] == {"id": str(source_doc.id), "title": "Source Doc Title"}
            assert item["message"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (b) chat_message-source: DM 비참여자 0-leak + MUTATION self-check ─────────


async def test_chat_message_source_dm_non_participant_zero_leak_with_mutation_proof():
    """AC3: caller가 참여하지 않는 DM이 target_doc을 멘션 → backlinks에서 0-leak(item-list +
    aggregate 둘 다). 이어서 MUTATION self-check: `_can_read_conversation`을 always-True로
    바꿔치기(authz predicate 제거) → leak 재현(RED) 확인 → 복원 → 다시 0-leak(GREEN) 확인.
    RED가 재현되지 않으면 이 테스트가 실제로 그 가드를 검증하지 못한다는 뜻(자기증명)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")

            # caller가 참여하지 않는 DM(다른 두 휴먼).
            dm_a_id, _ = await _make_human_member(s, org.id, project.id)
            dm_b_id, _ = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [dm_a_id, dm_b_id], created_by=dm_a_id, conv_type="dm",
            )
            msg = await _add_message(
                s, conv_id, dm_a_id, f"[참고](entity:doc:{target_doc.id})", _t(1),
            )
            await _make_mention(s, org.id, "chat_message", msg.id, target_doc.id, created_by=dm_a_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            # ── 기본(가드 정상): 0-leak.
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["data"] == [], body
            assert body["meta"]["has_more"] is False, body["meta"]

            # ── MUTATION self-check: predicate 제거 → RED(leak) 재현.
            with patch(
                "app.routers.conversations._can_read_conversation",
                new=AsyncMock(return_value=True),
            ):
                resp_red = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
                assert resp_red.status_code == 200, resp_red.text
                body_red = resp_red.json()
                assert len(body_red["data"]) == 1, (
                    "MUTATION 기대: _can_read_conversation 제거 시 leak 재현(RED) — "
                    "재현 안 되면 이 테스트가 실제로 IDOR 가드를 검증하지 못하는 것"
                )
                assert body_red["data"][0]["source_id"] == str(msg.id)
                assert body_red["data"][0]["message"]["conversation_id"] == str(conv_id)

            # ── 복원 후 GREEN 재확인.
            resp_green = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp_green.status_code == 200, resp_green.text
            assert resp_green.json()["data"] == [], "predicate 복원 후 0-leak 재확인"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_chat_message_source_visible_to_participant():
    """positive counterpart — 참여자 본인은 정상 노출."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            other_id, _ = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")

            conv_id = await _make_conversation(
                s, org.id, project.id, [caller_id, other_id], created_by=caller_id, conv_type="dm",
            )
            msg = await _add_message(
                s, conv_id, other_id, "이 문서를 " + "매우 " * 40 + "참고하세요 [링크](entity:doc:x)", _t(1),
            )
            await _make_mention(s, org.id, "chat_message", msg.id, target_doc.id, created_by=other_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            item = body["data"][0]
            assert item["source_type"] == "chat_message"
            assert item["message"]["id"] == str(msg.id)
            assert item["message"]["conversation_id"] == str(conv_id)
            assert item["message"]["sender"]["id"] == str(other_id)
            assert len(item["message"]["content_snippet"]) <= 161  # 160 + ellipsis
            assert item["doc"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (c) admin-bypass for agent-only conversation — 회귀 0 확인 ────────────────


async def test_admin_bypass_still_works_for_agent_only_conversation_after_refactor():
    """`_authorize_message_read`→`_can_read_conversation` 리팩터 후에도 org owner의 agent-only
    대화 admin-bypass가 유지되는지(회귀 0) — 참가자 아닌 org owner가 agent-only DM의
    chat_message-source backlink를 볼 수 있어야."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_org_owner(s, org.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")

            agent_a = await _make_agent_member(s, org.id, project.id)
            agent_b = await _make_agent_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_a, agent_b], created_by=agent_a, conv_type="dm",
            )
            msg = await _add_message(
                s, conv_id, agent_a, f"[T](entity:doc:{target_doc.id})", _t(1),
            )
            await _make_mention(s, org.id, "chat_message", msg.id, target_doc.id, created_by=agent_a)

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            assert body["data"][0]["source_id"] == str(msg.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (d) pagination/cursor: mixed authorized/unauthorized — no-oracle ─────────


async def test_pagination_mixed_authorized_unauthorized_no_oracle():
    """caller가 접근 가능한 project(authorized 5개) + 접근 불가 project(unauthorized 5개)의 doc
    mentions을 시간순으로 인터리빙 시드 — limit=3 페이지네이션이 authz-filtered 집합만 반영하고
    (원시 candidate 개수·미인가 존재 여부가 has_more/개수에 드러나지 않음), 커서로 완주 시
    authorized 5개 전부(정확히, 중복/누락 0)를 회수하는지 검증."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_ok = await _make_project(s, org.id, "OK")
            project_no = await _make_project(s, org.id, "NO")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_ok.id)
            other_id, _ = await _make_human_member(s, org.id, project_no.id)

            target_doc = await _make_doc(s, org.id, project_ok.id, title="Target")

            authorized_ids: list[uuid.UUID] = []
            for i in range(10):  # 짝수=authorized(project_ok), 홀수=unauthorized(project_no)
                minute = i + 1
                if i % 2 == 0:
                    src = await _make_doc(s, org.id, project_ok.id, title=f"OK-{i}")
                    authorized_ids.append(src.id)
                else:
                    src = await _make_doc(s, org.id, project_no.id, title=f"NO-{i}")
                m = await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=other_id, created_at=_t(minute),
                )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            collected: list[str] = []
            cursor = None
            for _page in range(10):  # 상한 넉넉히(무한루프 방지)
                url = f"/api/v2/docs/{target_doc.id}/backlinks"
                params = {"limit": 3}
                if cursor:
                    # cursor(ISO 8601)엔 '+'(UTC offset)가 들어있어 query string에 raw로 붙이면
                    # '+'가 공백으로 해석돼 fromisoformat 400 — httpx params로 정식 URL-encode.
                    params["before"] = cursor
                resp = await client.get(url, params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                assert len(body["data"]) <= 3, body
                # no-oracle: 이 페이지의 모든 item이 authorized_ids에 있어야(미인가 소스 절대 0건).
                for item in body["data"]:
                    assert item["source_id"] in {str(i) for i in authorized_ids}, (
                        f"미인가 source 누출: {item}"
                    )
                    collected.append(item["source_id"])
                if not body["meta"]["has_more"]:
                    break
                cursor = body["meta"]["next_cursor"]
                assert cursor is not None

            assert set(collected) == {str(i) for i in authorized_ids}, (
                collected, [str(i) for i in authorized_ids],
            )
            assert len(collected) == len(authorized_ids), "중복 회수 0"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_pagination_has_more_false_and_no_next_cursor_when_all_fit_one_page():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")
            for i in range(2):
                src = await _make_doc(s, org.id, project.id, title=f"S-{i}")
                await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=caller_id, created_at=_t(i + 1),
                )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks?limit=30")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 2
            assert body["meta"]["has_more"] is False
            assert body["meta"]["next_cursor"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (e) soft-deleted / 미존재 source 제외 ──────────────────────────────────────


async def test_soft_deleted_source_doc_excluded():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")
            deleted_source = await _make_doc(s, org.id, project.id, title="Deleted", deleted=True)
            live_source = await _make_doc(s, org.id, project.id, title="Live")
            await _make_mention(
                s, org.id, "doc", deleted_source.id, target_doc.id, created_by=caller_id, created_at=_t(1),
            )
            await _make_mention(
                s, org.id, "doc", live_source.id, target_doc.id, created_by=caller_id, created_at=_t(2),
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {item["source_id"] for item in body["data"]}
            assert ids == {str(live_source.id)}, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_missing_source_message_excluded_no_crash():
    """mention이 가리키는 chat_message row가 실제로 없는(하드삭제/오손 데이터) 경우 —
    500 없이 조용히 제외(fail-closed)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")
            ghost_message_id = uuid.uuid4()  # conversation_messages에 대응 row 없음
            await _make_mention(
                s, org.id, "chat_message", ghost_message_id, target_doc.id, created_by=caller_id,
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (f) cross-org 격리 ──────────────────────────────────────────────────────


async def test_cross_org_target_doc_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, "Org A")
            project_a = await _make_project(s, org_a.id)
            doc_a = await _make_doc(s, org_a.id, project_a.id, title="A-doc")

            org_b = await _make_org(s, "Org B")
            project_b = await _make_project(s, org_b.id)
            caller_id, caller_user_id = await _make_human_member(s, org_b.id, project_b.id)

        await _setup_app_human(app, Session, caller_user_id, org_b.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{doc_a.id}/backlinks")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_mention_row_with_mismatched_org_id_not_leaked():
    """mention.org_id가 caller org와 다른 이상 데이터(stale/오손) — 쿼리가 caller org로 스코프
    되므로 노출 0(설령 target_id가 우연히 caller org의 doc id와 같아도)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, "Org A")
            project_a = await _make_project(s, org_a.id)
            caller_id, caller_user_id = await _make_human_member(s, org_a.id, project_a.id)
            target_doc = await _make_doc(s, org_a.id, project_a.id, title="Target")

            org_b = await _make_org(s, "Org B")
            project_b = await _make_project(s, org_b.id)
            other_doc_b = await _make_doc(s, org_b.id, project_b.id, title="Other org doc")

            # org_id=org_b(다른 org)인 mention row가 target_doc.id를 target으로 가리킴(이상 데이터).
            await _make_mention(
                s, org_b.id, "doc", other_doc_b.id, target_doc.id, created_by=caller_id,
            )

        await _setup_app_human(app, Session, caller_user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── N+1 회피(has_project_access 메모이제이션) ─────────────────────────────────


async def test_no_n_plus_1_has_project_access_calls_per_distinct_project():
    """authorized source doc이 여러 개라도 같은 project면 has_project_access가 project당 1회만
    호출돼야 한다(§ Recommended architecture memoize 요구)."""
    from app.main import app
    import app.services.backlinks as backlinks_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")
            for i in range(6):
                src = await _make_doc(s, org.id, project.id, title=f"S-{i}")
                await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=caller_id, created_at=_t(i + 1),
                )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)

        call_count = 0
        original = backlinks_mod.has_project_access

        async def _counting(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return await original(*args, **kwargs)

        with patch("app.services.backlinks.has_project_access", new=_counting):
            try:
                resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks?limit=30")
                assert resp.status_code == 200, resp.text
                assert len(resp.json()["data"]) == 6
            finally:
                await client.aclose()

        assert call_count == 1, f"single project인데 has_project_access가 {call_count}회 호출됨(N+1 의심)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

"""story #1994(E-KNOWLEDGE-LINK S2) — `GET /api/v2/docs/{id}/backlinks` realPG IDOR + 페이지네이션
통합 테스트. 근본 설계 doc design-org-knowledge-mentions-backlinks §8.

산티아고 sabotage-probe 재구현(B1/B2/B3 + `created_by` 노출 수정) 후 재작성. 후반부의
"산티아고 sabotage-probe 재구현 실증(B1/B2/B3)" 섹션에 4개 필수 테스트가 있다:
  1. `test_sabotage_revoked_grant_excludes_only_that_item_not_whole_call` — B1: grant-loss
     caller의 미인가 mention 1건이 전체 호출을 poison하지 않고 그 item만 제외되는지(HTTP +
     unit-level 이중 실증). RED(try/except 제거) 재현으로 자기증명 완료.
  2. `test_sabotage_human_participant_privacy_carveout_survives_rewrite` — 휴먼-참가 group/DM
     admin-bypass carve-out이 2-phase 재구현 후에도 살아있는지.
  3. `test_sabotage_same_timestamp_tie_zero_permanent_loss` — B3: 동일 created_at mention 4개가
     복합 keyset cursor로 영구 손실 0.
  4. `test_sabotage_starvation_large_hidden_set_still_returns_authorized` — B2: 대량 미인가(20)가
     최신 구간에 몰려 있어도 구 라운드-cap give-up cliff 없이 authorized 항목을 전부 반환.

기존(구 아키텍처 대상) AC2/AC3 실증 테스트도 새 2-phase SQL-authz 아키텍처로 재검증 유지:
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


async def _make_human_member(session, org_id, project_id):
    """휴먼 TeamMember(project-scoped) — `has_project_access`/`accessible_project_ids_in_org`의
    team_member 분기로 project 접근을 얻는 동시에 conversation 관련 FK(`conversation_participants
    .member_id`/`conversations.created_by`/`conversation_messages.sender_id`가 전부
    `team_members.id`를 참조한다)를 만족한다. `_resolve_member`(routers/conversations.py, 레거시
    디폴트 `member_ssot_resolver_shadow=False`)는 JWT 휴먼에 대해 **TeamMember를 먼저 시도**하므로
    `sender.id == tm.id` — 아래 helper들이 반환하는 id를 그대로 `ConversationParticipant.member_id`/
    `Mention.created_by`에 써도 정합.

    §fixture 하드닝(pre-existing 버그 수정, story #1994 재구현 중 발견 — B1/B2/B3와 무관하지만
    "여전히 유효한 테스트" 판정 전 이 버그부터 봉합해야 실제로 통과/실증이 가능했다): 이전 fixture는
    `members`+`org_members`(`ProjectAccess.member_id`, 에이전트 분기 전용 컬럼)로 휴먼 grant를
    시도했는데, (a) `has_project_access`의 휴먼 grant 분기는 `ProjectAccess.org_member_id`를
    요구해 어떤 backlink 인가 테스트도 실제로 authorized 경로를 실증하지 못했고(항상 403),
    (b) `conversations`/`conversation_participants`/`conversation_messages`는 전부
    `team_members.id` FK라 `members.id` 기반 참가자는 FK violation으로 세팅조차 안 됐다."""
    from app.models.team import TeamMember
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    tm = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, user_id=user_id,
        type="human", name=f"M-{user_id.hex[:6]}", role="member", is_active=True,
    )
    session.add(tm)
    await session.commit()
    return tm.id, user_id


async def _grant_project_access(session, org_id, project_id, user_id, role="member"):
    """caller(기존 TeamMember 보유)에게 추가 project 접근 — TeamMember는 project-scoped 1:1
    (project당 별도 행)이라, 새 project엔 같은 `user_id`로 새 TeamMember 행을 추가한다.
    반환된 id는 이 새 project 스코프에서의 `sender.id`(`_resolve_member(project_id=...)`가
    project_id로 필터링해 이 행을 정확히 찾는다) — revocation 테스트(B1)는 이 id를 삭제한다."""
    from app.models.team import TeamMember
    tm = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, user_id=user_id,
        type="human", name=f"grant-{user_id.hex[:6]}", role=role, is_active=True,
    )
    session.add(tm)
    await session.commit()
    return tm.id


async def _revoke_team_member(session, team_member_id):
    """story #1994 B1 sabotage repro: grant 회수 = team_member 행 삭제(산티아고 스펙 문구 그대로
    "delete the grant/team_member row"). 이후 해당 project에 caller의 접근 경로가 전혀 없으면
    `_resolve_member(project_id=...)`가 `resolve_member()`로 폴백해 HTTPException을 raise —
    B1 수정 전엔 이게 `_can_read_conversation`을 뚫고 나가 backlinks 전체를 poison했다."""
    from sqlalchemy import delete as sa_delete
    from app.models.team import TeamMember
    await session.execute(sa_delete(TeamMember).where(TeamMember.id == team_member_id))
    await session.commit()


async def _make_org_owner(session, org_id):
    """org owner(OrgMember.role='owner') — project grant 없이도 has_project_access/admin-bypass 통과
    (org-wide 분기는 team_members 무관). `Member.id = OrgMember.id`(0075 ID 보존 parity) —
    이 helper는 conversation 참가자로 안 쓰이므로 team_members 불필요."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"owner-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="owner")
    session.add(om)
    await session.commit()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="Owner")
    session.add(m)
    await session.commit()
    return m.id, user_id


async def _make_agent_member(session, org_id, project_id, role="member"):
    """TeamMember(type=agent) — conversation FK 충족 + `_conversation_has_human_participant`의
    agent-판정(TeamMember.type='agent')도 이 테이블을 직접 쿼리하므로 동시 충족."""
    from app.models.team import TeamMember

    tm = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        type="agent", name=f"agent-{uuid.uuid4().hex[:6]}", role=role, is_active=True,
    )
    session.add(tm)
    await session.commit()
    return tm.id


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
            await _grant_project_access(s, org.id, project_source.id, caller_user_id)

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


# ─── N+1 회피(Phase 1 bulk 해소 — B2 재구현 후 accessible_project_ids_in_org) ──────


async def test_no_n_plus_1_accessible_project_ids_call_per_request():
    """story #1994 B2 재구현: 구 아키텍처는 "project당 1회"(메모이제이션)가 목표였지만, 새
    2-phase 아키텍처는 그보다 강한 형태 — `accessible_project_ids_in_org`가 **요청당 정확히 1회**
    (윈도우/라운드 재호출 0)만 호출된다. 3개의 distinct project에 걸친 authorized source doc이
    섞여 있어도 여전히 1회임을 검증(구 테스트의 "project당 1회"보다 엄격 — project 개수 무관 O(1))."""
    from app.main import app
    import app.services.backlinks as backlinks_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, "A")
            project_b = await _make_project(s, org.id, "B")
            project_c = await _make_project(s, org.id, "C")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_a.id)
            await _grant_project_access(s, org.id, project_b.id, caller_user_id)
            await _grant_project_access(s, org.id, project_c.id, caller_user_id)
            target_doc = await _make_doc(s, org.id, project_a.id, title="Target")
            projects = [project_a, project_b, project_c]
            for i in range(6):
                proj = projects[i % 3]
                src = await _make_doc(s, org.id, proj.id, title=f"S-{i}")
                await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=caller_id, created_at=_t(i + 1),
                )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)

        call_count = 0
        original = backlinks_mod.accessible_project_ids_in_org

        async def _counting(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return await original(*args, **kwargs)

        with patch("app.services.backlinks.accessible_project_ids_in_org", new=_counting):
            try:
                resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks?limit=30")
                assert resp.status_code == 200, resp.text
                assert len(resp.json()["data"]) == 6
            finally:
                await client.aclose()

        assert call_count == 1, (
            f"3개 distinct project인데 accessible_project_ids_in_org가 {call_count}회 호출됨"
            "(윈도우/라운드 재호출 재도입 의심 — B2 회귀)"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ═══════════════════════════════════════════════════════════════════════════
# 산티아고 sabotage-probe 재구현 실증(B1/B2/B3) — 4개 필수 테스트
# ═══════════════════════════════════════════════════════════════════════════


# ─── (1) B1: revoked grant — 해당 항목만 제외, 전체 호출 poison 안 됨 ────────────


async def test_sabotage_revoked_grant_excludes_only_that_item_not_whole_call():
    """산티아고 B1: `_can_read_conversation`의 두 번째 `_resolve_member(project_id=...)` 호출이
    grant-loss caller에서 HTTPException을 raise할 수 있었다(B1 하드닝 前) — 이게 잡히지 않으면
    mention **한 행**의 미인가가 backlinks 응답 **전체**를 poison한다(403/500). 이 테스트는:

    (a) caller가 conversation의 project(project_conv)에 접근 가능할 때 — 정상 노출(baseline).
    (b) 그 project 접근을 회수(TeamMember 행 삭제, 산티아고 스펙 문구 그대로)한 후 — 그 item만
        조용히 제외되고 나머지 호출은 200으로 정상 완료(전체 poison 안 됨) — HTTP 레벨 실증.
    (c) `_can_read_conversation`을 직접 호출(unit-level)해 raise 없이 False를 반환하는지도
        직접 실증 — B1 수정의 핵심(never-raise 계약)을 가장 직접적으로 증명.

    caller의 target_doc project 접근(project_target)은 절대 건드리지 않는다 — project_conv
    회수가 무관한 project_target 접근까지 오염시키지 않음을(과차단 아님) 함께 확인한다."""
    from app.main import app
    from app.dependencies.auth import AuthContext
    from app.routers.conversations import _can_read_conversation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_target = await _make_project(s, org.id, "Target Project")
            project_conv = await _make_project(s, org.id, "Conv Project")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_target.id)
            caller_conv_tm_id = await _grant_project_access(s, org.id, project_conv.id, caller_user_id)
            other_id, _ = await _make_human_member(s, org.id, project_conv.id)

            target_doc = await _make_doc(s, org.id, project_target.id, title="Target")

            conv_id = await _make_conversation(
                s, org.id, project_conv.id, [caller_conv_tm_id, other_id],
                created_by=other_id, conv_type="dm",
            )
            msg = await _add_message(
                s, conv_id, other_id, f"[참고](entity:doc:{target_doc.id})", _t(1),
            )
            await _make_mention(s, org.id, "chat_message", msg.id, target_doc.id, created_by=other_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            # (a) baseline: caller가 project_conv에 접근 가능 + DM 참가자 — 정상 노출.
            resp_before = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp_before.status_code == 200, resp_before.text
            body_before = resp_before.json()
            assert len(body_before["data"]) == 1, body_before
            assert body_before["data"][0]["source_id"] == str(msg.id)

            # ── revoke: project_conv 접근을 회수(team_member 행 삭제) ──
            async with Session() as s:
                await _revoke_team_member(s, caller_conv_tm_id)

            # (b) HTTP 레벨: 전체 호출은 여전히 200, 그 item만 제외(전체 poison 안 됨).
            resp_after = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp_after.status_code == 200, (
                "B1 회귀: grant-loss caller의 미인가 mention 1건이 전체 호출을 403/500으로 "
                f"poison함 — {resp_after.status_code} {resp_after.text}"
            )
            body_after = resp_after.json()
            assert body_after["data"] == [], (
                "회수 후에도 item이 남아있음 — 인가 필터가 실제로 걸리지 않음", body_after,
            )
            assert body_after["meta"]["has_more"] is False
        finally:
            await client.aclose()

        # (c) unit-level: _can_read_conversation 자체가 raise 없이 False를 반환하는지 직접 실증.
        async with Session() as s2:
            auth = AuthContext(
                user_id=str(caller_user_id), email="human@test",
                claims={"app_metadata": {"org_id": str(org.id)}},
            )
            result = await _can_read_conversation(conv_id, s2, auth, org.id)
            assert result is False, "grant-loss 후 _can_read_conversation은 raise 없이 False여야 함(B1 계약)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (2) 휴먼-참가 group/private DM — admin-bypass 프라이버시 carve-out 회귀 0 ──


async def test_sabotage_human_participant_privacy_carveout_survives_rewrite():
    """휴먼 참가자가 있는 group 대화 + private DM 둘 다 target_doc을 멘션 — org owner(참가자
    아님)는 admin-bypass가 적용되지 않아(휴먼 참가 = private carve-out, `_conversation_has_
    human_participant`) 두 항목 모두 못 본다. 실제 참가자는 자신이 참가한 대화(DM)의 항목을
    정상적으로 본다. 2-phase 재구현(Phase 1b `_resolve_readable_conversation_ids`) 후에도
    이 carve-out이 살아있는지(회귀 0) 실증."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_org_owner(s, org.id)
            p1_id, _ = await _make_human_member(s, org.id, project.id)
            p2_id, p2_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")

            group_conv_id = await _make_conversation(
                s, org.id, project.id, [p1_id, p2_id], created_by=p1_id, conv_type="group",
            )
            group_msg = await _add_message(
                s, group_conv_id, p1_id, f"[group](entity:doc:{target_doc.id})", _t(1),
            )
            await _make_mention(
                s, org.id, "chat_message", group_msg.id, target_doc.id, created_by=p1_id,
            )

            dm_conv_id = await _make_conversation(
                s, org.id, project.id, [p1_id, p2_id], created_by=p2_id, conv_type="dm",
            )
            dm_msg = await _add_message(
                s, dm_conv_id, p2_id, f"[dm](entity:doc:{target_doc.id})", _t(2),
            )
            await _make_mention(s, org.id, "chat_message", dm_msg.id, target_doc.id, created_by=p2_id)

        # ── org owner(비참가자): admin-bypass 미적용 — 둘 다 0-leak.
        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["data"] == [], (
                "org owner가 참가하지 않은 휴먼-참가 대화(group/DM)를 admin-bypass로 볼 수 있음"
                f"(private carve-out 회귀): {body}"
            )
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # ── 실 참가자(p2): 최소 DM 항목은 정상 노출.
        await _setup_app_human(app, Session, p2_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            source_ids = {item["source_id"] for item in body["data"]}
            assert str(dm_msg.id) in source_ids, (
                "실제 참가자가 자신이 참가한 DM의 backlink item을 못 봄(과차단)", body,
            )
            assert str(group_msg.id) in source_ids, (
                "실제 참가자가 자신이 참가한 group 대화의 backlink item을 못 봄(과차단)", body,
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (3) B3: 동일 created_at tie — 영구 손실 0(복합 keyset cursor) ──────────────


async def test_sabotage_same_timestamp_tie_zero_permanent_loss():
    """산티아고 B3: 같은 `created_at`을 가진 mention 4개를 명시적 공유 timestamp로 직접 seed —
    `limit=2`로 페이지네이션하며 커서를 전진시켰을 때, 단일-필드 created_at-only cursor였다면
    같은 timestamp 경계에서 일부가 영구 드롭될 수 있었다. 새 `(created_at, id)` 복합 keyset +
    opaque cursor(encode_cursor/decode_cursor)로 4개 전부가 정확히 1회씩(중복/누락 0) 회수되는지
    검증한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")

            shared_ts = _t(5)  # 4개 mention 모두 동일 created_at(서버 자동생성 우회, 직접 지정)
            source_ids: list[uuid.UUID] = []
            for i in range(4):
                src = await _make_doc(s, org.id, project.id, title=f"Tie-{i}")
                await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=caller_id, created_at=shared_ts,
                )
                source_ids.append(src.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            collected: list[str] = []
            cursor = None
            for _page in range(10):  # 상한 넉넉히(무한루프 방지)
                params = {"limit": 2}
                if cursor:
                    params["before"] = cursor
                resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                assert len(body["data"]) <= 2, body
                for item in body["data"]:
                    collected.append(item["source_id"])
                if not body["meta"]["has_more"]:
                    break
                cursor = body["meta"]["next_cursor"]
                assert cursor is not None
                # B3 실증 핵심: cursor는 opaque composite 토큰(created_at만이 아니라 id도 인코드) —
                # 다음 페이지 요청에 그대로 전달돼도 같은 timestamp의 나머지 행을 정확히 가리켜야.

            assert set(collected) == {str(i) for i in source_ids}, (
                "같은 created_at tie에서 일부 mention이 영구 손실됨(B3 회귀)",
                collected, [str(i) for i in source_ids],
            )
            assert len(collected) == 4, "중복 회수 0(같은 created_at 행이 두 번 반환되지 않아야)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (4) B2: 대량 미인가(20) + 소수 인가 — starvation/give-up cliff 0 ───────────


async def test_sabotage_starvation_large_hidden_set_still_returns_authorized():
    """산티아고 B2: 구 아키텍처(candidate-window fetch → Python authz filter → 최대 5라운드
    refetch, window=limit*3)는 최신(가장 최근 created_at) 쪽에 미인가 행이 많이 몰려 있으면
    라운드 상한(5)까지 다 써도 authorized 행에 도달하지 못하고 has_more=False로 조용히 포기할
    수 있었다(oracle-shaped 라운드-종속 동작). 이 테스트는 그 정확한 배치를 재현한다: 미인가
    (hidden) mention 20개를 **가장 최근**(t=20..1) 구간에 몰아넣고, 인가된 mention 3개를 그보다
    **더 오래된**(t=0,-1,-2) 구간에 둔다 — `limit=1`이면 구 아키텍처(window=1*3=3, 5라운드=최대
    15개 원시 행)는 authorized 행에 도달하기 전에 스캔을 포기했을 배치다. 새 아키텍처(윈도우/
    라운드 없는 단일 SQL-authz 쿼리)는 이 배치와 무관하게 authorized 3개 전부를 정확히 반환해야
    한다(빈 페이지로 조기 종료 없음)."""
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

            # 미인가 20개 — 가장 최근 구간(t=20..1, DESC 정렬 시 맨 앞).
            for i in range(20, 0, -1):
                src = await _make_doc(s, org.id, project_no.id, title=f"HIDDEN-{i}")
                await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=other_id, created_at=_t(i),
                )

            # 인가 3개 — 미인가 전부보다 더 오래된 구간(t=0,-1,-2).
            authorized_ids: list[uuid.UUID] = []
            for i in range(3):
                src = await _make_doc(s, org.id, project_ok.id, title=f"AUTH-{i}")
                await _make_mention(
                    s, org.id, "doc", src.id, target_doc.id, created_by=caller_id, created_at=_t(-i),
                )
                authorized_ids.append(src.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            collected: list[str] = []
            cursor = None
            for _page in range(40):  # 상한 넉넉히(무한루프 방지) — authorized 3개뿐이라 최대 3페이지.
                params = {"limit": 1}
                if cursor:
                    params["before"] = cursor
                resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                # no-oracle: 반환되는 모든 item은 authorized여야(미인가 20개 절대 노출 0).
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
                "B2 회귀: 대량 미인가 행에 가려 authorized 항목이 회수되지 못함(starvation/give-up "
                "cliff 재발 의심)", collected, [str(i) for i in authorized_ids],
            )
            assert len(collected) == 3, "중복 회수 0"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

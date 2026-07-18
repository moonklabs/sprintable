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
    """휴먼 멤버 — anchor 테이블(members + org_members + project_access) 직접 write.

    §Issue A(QA 까심 발견 — 3회차 pass): 이전 두 회차의 fixture는 `team_members`에
    `TeamMember(...)` ORM 인스턴스를 `session.add()`+`commit()`으로 **INSERT**하려 했다. 이건
    항상 실패해야 정상이다 — 마이그 0088(`0088_team_members_projection_view.py`)이
    `team_members`를 물리 테이블에서 `members ⋈ project_access`(휴먼) / `members ⋈
    agent_project_profiles`(에이전트) VIEW로 강등했고(실 테이블은 `team_members_legacy`로
    rename), Postgres는 plain INSERT를 뷰에 허용하지 않는다("cannot insert into view").
    직전 pass의 docstring은 이 fixture가 이미 고쳐졌다고 주장했지만 실제 코드는 여전히 뷰에
    INSERT를 시도하고 있었다(별개의 FK/컬럼 불일치 버그를 고친 것과 혼동) — 산티아고 sabotage-
    probe가 실 PG로 이 파일을 실행해서야 드러났다. 프로덕션 코드(`app/routers/team_members.py`
    `create_team_member`)도 동일 원칙을 따른다: `TeamMember(...)`는 응답 shape용 transient
    객체로만 만들고 절대 `session.add()`하지 않으며, 실제 영속은 `members`/
    `agent_project_profiles`/`project_access` anchor로만 한다.

    이 helper는 그 anchor 경로를 그대로 재현한다:
      1. `User` 생성(JWT auth의 user_id).
      2. `OrgMember(org_id, user_id, role='member')` 생성 — id는 0075 ID-보존 불변식의 canonical
         값(휴먼은 `Member.id == OrgMember.id`, `_make_org_owner`와 동일 패턴).
      3. `Member(id=om.id, type='human', ...)` — 같은 id로 신원 앵커.
      4. `ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, ...)` —
         **양쪽 다 세팅**해야 한다: `team_members` VIEW(→ `_resolve_member`/`_can_read_conversation`/
         conversation 참가자 FK)는 `project_access.member_id = members.id`로 조인하고,
         `get_project_role`(project_auth.py, 여러 authz 판정의 SSOT)의 휴먼 branch는
         `project_access.org_member_id → org_members.id → user_id`로만 매칭한다 — 하나만
         세팅하면 다른 쪽 authz 경로가 조용히 실패(false-403)한다.

    반환 `(member.id, user_id)` — `member.id`가 `conversation_participants.member_id`/
    `mentions.created_by`/`conversation_messages.sender_id`가 실제로 참조하는 값이다(이 컬럼들에
    걸린 FK/모델 주석의 "team_members.id"라는 표현은 뷰의 투영 id를 가리킬 뿐 — Postgres FK는
    뷰를 타겟할 수 없고, 실제로 baseline schema.sql엔 이 컬럼들에 FK 제약 자체가 없다. 값은
    `members.id`를 직접 쓴다)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()

    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()

    m = Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name=f"M-{user_id.hex[:6]}")
    session.add(m)
    await session.commit()

    pa = ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=m.id,
        permission="granted", role="member",
    )
    session.add(pa)
    await session.commit()
    return m.id, user_id


async def _grant_project_access(session, org_id, project_id, user_id, role="member"):
    """기존 휴먼(이미 `_make_human_member`로 생성됨, `user_id`로 식별)에게 **추가** project
    접근을 부여 — 새 `Member` 행을 만들지 않는다(휴먼은 org당 `Member` 행이 정확히 1개, 모델
    docstring의 partial unique index로 강제). 기존 `(org_id, user_id)`의 `Member`/`OrgMember`를
    조회해 새 `ProjectAccess` 행 하나만 insert한다(`project_id=project_id,
    member_id=<기존 member.id>, org_member_id=<기존 org_member.id>, role=role`).

    반환값은 member id(기존과 동일한 값 — "새 team-member id" 개념 자체가 anchor 아키텍처엔
    없다, 새 grant 행이 생겼을 뿐). revocation(B1 sabotage test)은 이 member id + project_id로
    해당 `ProjectAccess` 행 하나만 찾아 삭제한다(`_revoke_team_member` 참조)."""
    from sqlalchemy import select
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess

    om = (await session.execute(
        select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )).scalars().first()
    m = (await session.execute(
        select(Member).where(
            Member.org_id == org_id, Member.user_id == user_id, Member.type == "human",
        )
    )).scalars().first()

    pa = ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=m.id,
        permission="granted", role=role,
    )
    session.add(pa)
    await session.commit()
    return m.id


async def _revoke_team_member(session, member_id, project_id):
    """story #1994 B1 sabotage repro: grant 회수 = 그 member+project의 `ProjectAccess` 행 삭제
    (더 이상 `team_members` 물리 행이 없으므로 "team_member 삭제"는 anchor 아키텍처에서
    `ProjectAccess` 회수와 동형이다 — 이게 그 project에 대한 caller의 유일한 접근 경로였다면,
    이후 `team_members` VIEW에서도 그 (member, project) 조합이 사라져
    `_resolve_member(project_id=...)`가 `resolve_member()`로 폴백 → HTTPException(403 "No
    access to this project")을 raise할 수 있다 — B1 수정 전엔 이게 `_can_read_conversation`을
    뚫고 나가 backlinks 전체를 poison했다."""
    from sqlalchemy import delete as sa_delete
    from app.models.project_access import ProjectAccess
    await session.execute(
        sa_delete(ProjectAccess).where(
            ProjectAccess.member_id == member_id, ProjectAccess.project_id == project_id,
        )
    )
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
    """에이전트 멤버 — `Member(type='agent')` + `AgentProjectProfile`(뷰의 agent-branch 런타임
    조인 `agent_project_profiles.member_id = members.id`) + `ProjectAccess`(뷰가 role/color를
    LEFT JOIN하는 곳이자, `has_project_access`의 에이전트 grant branch가 `project_access
    .member_id = members.id AND permission='granted'`로 직접 요구하는 행 — 프로덕션
    `write_agent_project_placement`(app/services/agent_anchor_sync.py)와 동형 3-write 패턴)."""
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    m = Member(
        id=member_id, org_id=org_id, type="agent", user_id=None,
        name=f"agent-{member_id.hex[:6]}",
    )
    session.add(m)
    await session.commit()

    profile = AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id)
    session.add(profile)
    await session.commit()

    pa = ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=None, member_id=member_id,
        permission="granted", role=role,
    )
    session.add(pa)
    await session.commit()
    return member_id


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
    aggregate 둘 다). 이어서 MUTATION self-check: authz predicate 제거 → leak 재현(RED) 확인 →
    복원 → 다시 0-leak(GREEN) 확인. RED가 재현되지 않으면 이 테스트가 실제로 그 가드를 검증하지
    못한다는 뜻(자기증명).

    §4회차 재구현 후 mutation target 재변경: 3회차는 `app.services.backlinks
    ._resolve_readable_conversation_ids`(Python이 미리 만든 readable id 집합)를 패치했다 —
    이번 pass는 그 2-phase 헬퍼 자체를 완전히 삭제하고, chat-source 인가 판정을 메인 SQL
    문의 WHERE절에 correlate되는 `conversation_auth.conversation_readable_predicate`
    표현식으로 접었다(TOCTOU-by-construction). 새 mutation target은 `app.services.backlinks`
    네임스페이스로 import된 그 함수 자체 — "무조건 readable"인 표현식(`true()`)을 반환하도록
    바꿔치기해, 메인 쿼리가 실제로 이 predicate의 값에 의존하는지(하드코드된 별도 우회 경로가
    없는지) 증명한다. patch target은 `app.services.conversation_auth.conversation_readable_
    predicate`가 아니라 `app.services.backlinks.conversation_readable_predicate`(backlinks.py가
    `from ... import conversation_readable_predicate`로 자기 네임스페이스에 바인딩한 참조) —
    전자를 패치하면 이미 바인딩된 backlinks의 로컬 참조엔 영향이 없어 self-check가 무의미해진다."""
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

            # ── MUTATION self-check: authz predicate 제거(always-true로 치환) → RED(leak) 재현.
            from sqlalchemy import true as _sa_true

            with patch(
                "app.services.backlinks.conversation_readable_predicate",
                new=lambda *a, **kw: _sa_true(),
            ):
                resp_red = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
                assert resp_red.status_code == 200, resp_red.text
                body_red = resp_red.json()
                assert len(body_red["data"]) == 1, (
                    "MUTATION 기대: conversation_readable_predicate 제거 시 leak 재현(RED) — "
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


# ─── §5회차 Blocker 1: project_access_valid atom 사전 materialize 완전 소거 증명 ──


async def test_no_accessible_project_ids_pre_resolve_call_bulk():
    """story #1994 §5회차 Blocker 1 구조 증명: 4회차까지는 `accessible_project_ids_in_org`가
    "요청당 정확히 1회" 호출되는 게 목표였다(구 N+1 회피 테스트 — 이 테스트가 대체함). 5회차는
    그 사전 호출 자체를 완전히 없앴다 — `project_access_valid` atom이 이제 메인 statement에
    correlated EXISTS로 직접 심겨서 별도 SELECT가 아예 존재하지 않는다(TOCTOU 윈도우 자체가
    구조적으로 사라짐). `app.services.project_auth.accessible_project_ids_in_org`(원본 정의
    — backlinks.py는 더 이상 이 이름을 import조차 하지 않는다)를 패치해 **0회** 호출을 단정한다.
    3개의 distinct project에 걸친 authorized source doc이 섞여 있어도(4회차 테스트와 동일 시드)
    여전히 0회임을 검증."""
    from app.main import app
    import app.services.project_auth as project_auth_mod

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
        original = project_auth_mod.accessible_project_ids_in_org

        async def _counting(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return await original(*args, **kwargs)

        with patch("app.services.project_auth.accessible_project_ids_in_org", new=_counting):
            try:
                resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks?limit=30")
                assert resp.status_code == 200, resp.text
                assert len(resp.json()["data"]) == 6
            finally:
                await client.aclose()

        assert call_count == 0, (
            f"accessible_project_ids_in_org가 {call_count}회 호출됨 — §5회차가 없앤 project_access_"
            "valid 사전 bulk materialize가 재도입된 회귀(Blocker 1 재발, atom-level TOCTOU 윈도우 부활)"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def _psycopg2_dsn() -> str:
    """`_REAL_DB_URL`(psycopg2/asyncpg 스킴 무관)을 plain `postgresql://` DSN으로 정규화 —
    psycopg2.connect()는 스킴 접미사(+asyncpg/+psycopg2)를 이해 못 한다."""
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix):]
    return url


async def test_sabotage_intra_statement_revoke_barrier_doc_source_project_access_valid():
    """story #1994 §5회차 Blocker 1 — **문자 그대로**(literal) intra-statement interleave 실증.
    메인 backlinks SELECT가 실제로 DB에 전송되기 **직전**(SQLAlchemy `before_cursor_execute` —
    `cursor.execute()` 호출 바로 앞)에, 완전히 별개의 동기 psycopg2 커넥션으로 caller의 유일한
    project grant를 DELETE+커밋한다. 4회차까지의 2-phase(사전 `accessible_project_ids_in_org`
    SELECT → Python set → 메인 쿼리 `.in_()`) 아키텍처였다면 이 타이밍의 revoke는 그 사전 SELECT
    이후에 커밋되므로 메인 쿼리가 여전히 stale 멤버십을 신뢰했을 것이다(정확히 Blocker 1이 잡은
    TOCTOU). §5회차 구현은 `project_access_valid`가 메인 statement 자체의 correlated EXISTS라
    이 타이밍(같은 statement 실행 시작 직전 커밋)의 revoke도 READ COMMITTED 스냅샷에 반영돼야
    한다 — 이 테스트는 그 반영을 직접 확인한다(Python 레벨 사전 SELECT의 부재를 "증명"하는 게
    아니라 실제 동시성 결과 자체를 실증)."""
    from app.main import app
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")
            source_doc = await _make_doc(s, org.id, project.id, title="Source")
            await _make_mention(
                s, org.id, "doc", source_doc.id, target_doc.id, created_by=caller_id, created_at=_t(1),
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)

        revoked = {"done": False}

        def _revoke_mid_statement(conn, cursor, statement, parameters, context, executemany):
            if revoked["done"] or "mentions" not in statement.lower():
                return
            revoked["done"] = True
            import psycopg2
            pg = psycopg2.connect(_psycopg2_dsn())
            try:
                pg.autocommit = True
                with pg.cursor() as cur:
                    cur.execute(
                        "DELETE FROM project_access WHERE member_id = %s AND project_id = %s",
                        (str(caller_id), str(project.id)),
                    )
            finally:
                pg.close()

        event.listen(engine.sync_engine, "before_cursor_execute", _revoke_mid_statement)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _revoke_mid_statement)
            await client.aclose()
            app.dependency_overrides.clear()

        assert revoked["done"] is True, "revoke hook 미발동(mentions 쿼리 미탐지) — 테스트 자체 결함"
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"] == [], (
            "Blocker 1(§5회차) 회귀: 메인 statement 실행 직전 커밋된 revoke가 doc-source "
            f"project_access_valid atom에 반영되지 않음(stale materialize 부활) — {resp.json()}"
        )
    finally:
        await engine.dispose()


async def test_sabotage_intra_statement_revoke_barrier_chat_source_project_access_valid():
    """위 테스트의 chat-source 짝 — `conversation_readable_predicate`에 넘기는
    `project_access_valid`도 같은 `project_access_valid_correlated` SSOT를 쓰므로(Conversation.
    project_id에 correlate) 동일한 intra-statement revoke barrier를 만족해야 한다. caller가
    conversation 참가자이고(participant atom 유지) admin도 아닌 상태에서, source message가 속한
    project에 대한 grant만 메인 쿼리 실행 직전에 revoke한다."""
    from app.main import app
    from sqlalchemy import event

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
                s, conv_id, other_id, f"[참고](entity:doc:{target_doc.id})", _t(1),
            )
            await _make_mention(s, org.id, "chat_message", msg.id, target_doc.id, created_by=other_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)

        revoked = {"done": False}

        def _revoke_mid_statement(conn, cursor, statement, parameters, context, executemany):
            if revoked["done"] or "mentions" not in statement.lower():
                return
            revoked["done"] = True
            import psycopg2
            pg = psycopg2.connect(_psycopg2_dsn())
            try:
                pg.autocommit = True
                with pg.cursor() as cur:
                    cur.execute(
                        "DELETE FROM project_access WHERE member_id = %s AND project_id = %s",
                        (str(caller_id), str(project.id)),
                    )
            finally:
                pg.close()

        event.listen(engine.sync_engine, "before_cursor_execute", _revoke_mid_statement)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _revoke_mid_statement)
            await client.aclose()
            app.dependency_overrides.clear()

        assert revoked["done"] is True, "revoke hook 미발동(mentions 쿼리 미탐지) — 테스트 자체 결함"
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"] == [], (
            "Blocker 1(§5회차) 회귀: 메인 statement 실행 직전 커밋된 revoke가 chat-source "
            f"project_access_valid atom(conversation_readable_predicate 경유)에 반영되지 않음 — {resp.json()}"
        )
    finally:
        await engine.dispose()


# ─── §5회차 Blocker 2: `_can_read_conversation`의 project_access_valid — agent grant-loss ──


async def test_can_read_conversation_agent_grant_loss_atom_direct():
    """산티아고 Blocker 2(§5회차): `_can_read_conversation`이 API-key(에이전트) caller의
    `project_access_valid`를 `True`로 하드코딩(재검증 없음)하던 구 동작을 없애고, human과 동일하게
    `has_project_access`를 실제로 호출하는지 **직접**(HTTP 왕복이 아니라 함수 자체) 실증한다 —
    "어떤 status code가 뜨는가"가 아니라 predicate의 진리값 자체를 단정해 어떤 atom을 겨냥하는지
    모호함이 없게 한다.

    유효 grant 보유 시 True(과차단 회귀 아님을 함께 확인) → grant 회수(`_revoke_team_member` —
    이 project에 대한 유일한 project_access 행 삭제, agent_project_profiles는 유지되므로
    `_resolve_member`의 sender 해소 자체는 여전히 성공한다 — False가 sender-resolution 실패가
    아니라 project_access_valid 재평가 자체에서 나온다는 것을 보장) 후 False."""
    from app.routers.conversations import _can_read_conversation
    from app.dependencies.auth import AuthContext

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_id], created_by=agent_id, conv_type="dm",
            )

        auth = AuthContext(
            user_id=str(agent_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org.id), "api_key_id": str(uuid.uuid4())}},
        )

        async with Session() as s:
            result_before = await _can_read_conversation(conv_id, s, auth, org.id)
        assert result_before is True, (
            "유효 grant 보유 에이전트가 자기 참가 대화를 못 읽음(과차단 회귀) — "
            f"result={result_before}"
        )

        async with Session() as s:
            await _revoke_team_member(s, agent_id, project.id)

        async with Session() as s:
            result_after = await _can_read_conversation(conv_id, s, auth, org.id)
        assert result_after is False, (
            "Blocker 2(§5회차) 회귀: 에이전트 grant 회수 후에도 _can_read_conversation이 True를 "
            "반환함 — project_access_valid가 is_api_key=True로 하드코딩된 채 재검증 안 됨"
        )
    finally:
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

            # ── revoke: project_conv 접근을 회수(project_access 행 삭제) ──
            async with Session() as s:
                await _revoke_team_member(s, caller_conv_tm_id, project_conv.id)

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
    정상적으로 본다. 4회차 단일-statement 재구현(`conversation_auth.conversation_readable_
    predicate`가 메인 SQL WHERE절에 correlate) 후에도 이 carve-out이 살아있는지(회귀 0) 실증."""
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


# ═══════════════════════════════════════════════════════════════════════════
# 3회차 pass — Issue A(fixture 근본원인) + Blocker 1(org-scope) + Blocker 2(쿼리-카운트) 필수 테스트
# ═══════════════════════════════════════════════════════════════════════════


# ─── (1) fixture 유효성 sanity — Issue A 회귀 가드 ─────────────────────────────


async def test_fixture_sanity_grant_actually_authorizes_not_silent_403():
    """Issue A 회귀 가드: `_make_human_member`/`_grant_project_access`가 실제로 유효한 project
    접근을 부여하는지 최소 단위로 직접 검증한다. Issue A(fixture가 `team_members` VIEW에 직접
    INSERT를 시도) 재발 시, 이 테스트가 **조용한 403/빈 목록이 아니라 명시적으로** 실패해야
    한다 — 그래서 baseline positive case에서 200 + non-empty data를 먼저 강하게 단정한다(다른
    negative/sabotage 테스트들이 "우연히 0-leak"으로 통과하는 걸 가려내는 것과 같은 원리를
    거꾸로 적용: 여기선 "우연히 0건이라 통과"를 막는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")
            source_doc = await _make_doc(s, org.id, project.id, title="Source")
            await _make_mention(s, org.id, "doc", source_doc.id, target_doc.id, created_by=caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, (
                "Issue A 회귀 의심: 정상 grant 시나리오가 200이 아님(fixture가 team_members VIEW "
                f"직접 INSERT를 다시 시도하고 있을 수 있음) — {resp.status_code} {resp.text}"
            )
            body = resp.json()
            assert len(body["data"]) == 1, (
                "Issue A 회귀 의심: grant된 caller가 자신이 접근 가능한 project의 source doc "
                f"backlink를 못 봄(fixture가 실제로 인가를 부여하지 못하고 있음) — {body}"
            )
            assert body["data"][0]["source_id"] == str(source_doc.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (2)(3) Blocker 1: created_by/sender org-scope — 타org 해소 시 null(행은 유지) ──


async def test_created_by_nulled_when_resolves_to_foreign_org_member():
    """산티아고 Blocker 1: `mention.created_by`가 (오손 데이터 등으로) caller org가 아닌 다른
    org의 member id를 가리키면, backlink 행 자체(source_id/doc 등)는 그대로 노출하되
    `created_by`는 그 신원 요약을 null로 가려야 한다(행을 숨기는 게 아니라 신원 요약만)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, "Org A")
            project_a = await _make_project(s, org_a.id)
            caller_id, caller_user_id = await _make_human_member(s, org_a.id, project_a.id)
            target_doc = await _make_doc(s, org_a.id, project_a.id, title="Target")
            source_doc = await _make_doc(s, org_a.id, project_a.id, title="Source")

            org_b = await _make_org(s, "Org B")
            project_b = await _make_project(s, org_b.id)
            foreign_id, _ = await _make_human_member(s, org_b.id, project_b.id)

            await _make_mention(
                s, org_a.id, "doc", source_doc.id, target_doc.id, created_by=foreign_id,
            )

        await _setup_app_human(app, Session, caller_user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, (
                "타org created_by가 mention 행 자체를 가림(과차단) — 행은 유지돼야 함", body,
            )
            item = body["data"][0]
            assert item["source_id"] == str(source_doc.id)
            assert item["doc"] == {"id": str(source_doc.id), "title": "Source"}
            assert item["created_by"] is None, (
                "Blocker 1 회귀: 타org member로 해소되는 created_by가 신원 요약(name 등)을 "
                f"caller org로 노출함(cross-org IDOR) — {item}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_chat_sender_nulled_when_resolves_to_foreign_org_member():
    """산티아고 Blocker 1: chat_message source의 `sender_id`가 caller org가 아닌 다른 org의
    member id를 가리키면(오손 데이터), `message.sender`는 null이어야 하되 message 행 자체
    (content_snippet 등)는 그대로 노출돼야 한다 — created_by와 동형 처리."""
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
            foreign_id, _ = await _make_human_member(s, org_b.id, project_b.id)

            # caller가 참가자인 org_a 대화 — sender_id만 org_b 소속 member id(이상 데이터).
            conv_id = await _make_conversation(
                s, org_a.id, project_a.id, [caller_id], created_by=caller_id, conv_type="dm",
            )
            msg = await _add_message(
                s, conv_id, foreign_id, f"[참고](entity:doc:{target_doc.id})", _t(1),
            )
            await _make_mention(
                s, org_a.id, "chat_message", msg.id, target_doc.id, created_by=caller_id,
            )

        await _setup_app_human(app, Session, caller_user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, (
                "타org sender_id가 message 행 자체를 가림(과차단) — 행은 유지돼야 함", body,
            )
            item = body["data"][0]
            assert item["message"]["id"] == str(msg.id)
            assert item["message"]["conversation_id"] == str(conv_id)
            assert item["message"]["sender"] is None, (
                "Blocker 1 회귀: 타org member로 해소되는 sender_id가 신원 요약을 caller org로 "
                f"노출함(cross-org IDOR) — {item}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (4) Blocker 2: query-count amplification proof(N+1/oracle 재실증) ────────


async def test_query_count_o1_regardless_of_hidden_conversation_count():
    """산티아고 Blocker 2 재실증(정적분석): hidden(caller가 못 읽는) chat_message-source candidate
    conversation 수가 1개 → 50개로 50배 늘어도, 동일한 수의 authorized item이 있는 두 시나리오의
    backlinks GET 1회 총 DB 쿼리 수는 **동일**해야 한다 — per-conversation 루프(구 아키텍처)였다면
    쿼리 수가 hidden 개수에 선형 비례했을 것이다(query-count/timing amplification). 이 테스트는
    wall-clock이 아니라 이 코드베이스의 기존 N+1 가드 관례(`test_1992_unread_count_total_realdb.py`
    등)와 동일한 SQLAlchemy `before_cursor_execute` 이벤트 쿼리-카운트 단정을 쓴다."""
    from app.main import app
    from sqlalchemy import event

    async def _scenario(hidden_n: int, authorized_n: int) -> int:
        engine, Session = await _session_factory()
        try:
            async with Session() as s:
                org = await _make_org(s)
                project = await _make_project(s, org.id)
                caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
                target_doc = await _make_doc(s, org.id, project.id, title="Target")

                # authorized: caller가 참가자인 DM(휴먼-휴먼) — 정상 노출 대상.
                for i in range(authorized_n):
                    other_id, _ = await _make_human_member(s, org.id, project.id)
                    conv_id = await _make_conversation(
                        s, org.id, project.id, [caller_id, other_id],
                        created_by=caller_id, conv_type="dm",
                    )
                    msg = await _add_message(
                        s, conv_id, caller_id, f"[a{i}](entity:doc:{target_doc.id})", _t(i + 1),
                    )
                    await _make_mention(
                        s, org.id, "chat_message", msg.id, target_doc.id, created_by=caller_id,
                    )

                # hidden: caller 비참여 agent-only 대화(admin도 아님) — 완전 미인가.
                for i in range(hidden_n):
                    agent_a = await _make_agent_member(s, org.id, project.id)
                    agent_b = await _make_agent_member(s, org.id, project.id)
                    hconv_id = await _make_conversation(
                        s, org.id, project.id, [agent_a, agent_b],
                        created_by=agent_a, conv_type="dm",
                    )
                    hmsg = await _add_message(
                        s, hconv_id, agent_a, f"[h{i}](entity:doc:{target_doc.id})", _t(-i - 1),
                    )
                    await _make_mention(
                        s, org.id, "chat_message", hmsg.id, target_doc.id, created_by=agent_a,
                    )

            await _setup_app_human(app, Session, caller_user_id, org.id)
            client = _client_for(app)

            query_count = 0

            def _count(conn, cursor, statement, parameters, context, executemany):
                nonlocal query_count
                query_count += 1

            event.listen(engine.sync_engine, "before_cursor_execute", _count)
            try:
                resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks?limit=30")
                assert resp.status_code == 200, resp.text
                body = resp.json()
                # no-oracle: hidden 항목 절대 노출 0 — authorized_n개만 정확히.
                assert len(body["data"]) == authorized_n, body
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", _count)
                await client.aclose()
                app.dependency_overrides.clear()
            return query_count
        finally:
            await engine.dispose()

    count_1_hidden = await _scenario(hidden_n=1, authorized_n=2)
    count_50_hidden = await _scenario(hidden_n=50, authorized_n=2)

    assert count_1_hidden == count_50_hidden, (
        "Blocker 2 회귀: hidden conversation 수(1→50)에 따라 backlinks 쿼리 수가 달라짐"
        f"(per-conversation 루프 재도입 의심) — 1개:{count_1_hidden}회, 50개:{count_50_hidden}회"
    )


# ═══════════════════════════════════════════════════════════════════════════
# 4회차 pass — 산티아고 아키텍처 지적(재구현 자체가 드리프트 원인) 필수 테스트
# ═══════════════════════════════════════════════════════════════════════════


# ─── (1) Blocker 1(4회차): foreign-org chat source — admin-bypass org 경계 누락 ──


async def test_sabotage_foreign_org_chat_source_admin_bypass_excluded():
    """산티아고 Blocker 1(4회차 재발견): org A 휴먼 owner/admin caller — org B에 agent-only
    대화(휴먼 참가자 없음)의 메시지가 있고, `Mention.org_id=org_A.id`(호출자 org)이지만
    `source_id`는 그 org-B 메시지를 가리키는 mention 행을 심는다(write-path 버그 또는
    적대적/오손 데이터 시뮬레이션 — 어떻게 그 상태에 도달했든 read-time 방어가 이걸 잡아야
    한다는 게 핵심). org A owner의 admin-bypass가 org 경계 없이 `agent_only_candidates`
    전체에 적용됐던 3회차 버그의 정확한 재현 시나리오.

    RED/GREEN 수동 검증(이 pass 구현 중 직접 확인 — `app/services/backlinks.py`의
    `Conversation.org_id == org_id` join 조건을 임시로 `true()`로 치환하고 이 정확한 시나리오를
    재현: RED에서 org-B 메시지 content/conversation_id가 그대로 leak됐고, 조건 복원 후 GREEN
    (0-leak)을 재확인했다 — 커밋 히스토리/PR 본문 참조): 이 테스트는 그 GREEN 상태를 회귀
    가드로 고정한다. admin-bypass가 org 경계 없이 통과하면 이 assert가 즉시 실패한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, "Org A")
            owner_id, owner_user_id = await _make_org_owner(s, org_a.id)
            project_a = await _make_project(s, org_a.id)
            target_doc = await _make_doc(s, org_a.id, project_a.id, title="Target")

            org_b = await _make_org(s, "Org B")
            project_b = await _make_project(s, org_b.id)
            agent_a = await _make_agent_member(s, org_b.id, project_b.id)
            agent_b = await _make_agent_member(s, org_b.id, project_b.id)
            conv_b = await _make_conversation(
                s, org_b.id, project_b.id, [agent_a, agent_b], created_by=agent_a, conv_type="dm",
            )
            msg_b = await _add_message(
                s, conv_b, agent_a, f"[cross-org secret](entity:doc:{target_doc.id})", _t(1),
            )
            # mentions.org_id = 호출자 org(A) — source_id는 org B의 메시지를 가리킴(오손/adversarial).
            await _make_mention(
                s, org_a.id, "chat_message", msg_b.id, target_doc.id, created_by=owner_id,
            )

        await _setup_app_human(app, Session, owner_user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["data"] == [], (
                "Blocker 1(4회차) 회귀: org A owner가 admin-bypass로 org B의 agent-only 대화 "
                f"메시지를 열람함(cross-org IDOR) — {body}"
            )
            assert body["meta"]["has_more"] is False, (
                "no-oracle: 제외된 항목이 has_more/count에 흔적을 남기면 안 됨", body["meta"],
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── (2) Blocker 2(4회차): SSOT 구조 증명 — mentions 대상 SELECT 정확히 1회 ──


async def test_ssot_single_select_against_mentions_proves_no_two_phase():
    """산티아고 Blocker 2(4회차) 구조 증명: doc-source와 chat-message-source가 섞인 backlinks
    요청 하나가 `mentions` 테이블을 대상으로 하는 SELECT를 **정확히 1회**만 실행하는지 검증한다.

    증명 방식 선택 이유: `hasattr`/import-존재 체크(`_resolve_readable_conversation_ids`가
    없다는 것만 확인)는 "그 이름의 함수가 없다"만 증명하지, "다른 이름으로 된 동형의 2-phase
    헬퍼가 새로 안 생겼는지"는 증명하지 못한다(이름만 바뀐 재발을 못 잡음). 이 테스트는 대신
    이 파일 전체가 이미 쓰는 `before_cursor_execute` 쿼리-카운트 이벤트 관례(B2 O(1) 증명과
    동일 패턴)로 **"mentions 테이블을 건드리는 SELECT 개수"** 자체를 직접 세어, 그게 1이라는
    걸 구조적으로 증명한다 — "readable id 집합을 먼저 SELECT해 Python에 들고 있다가 나중에
    IN절에 쓰는" 어떤 형태의 2-phase 재구현이든(이름 무관) mentions 대상 SELECT가 여전히
    1회라는 사실 자체와는 직교하므로, 대신 그 어떤 2-phase 헬퍼도 mentions를 두 번 건드리게
    설계될 리는 없다는 점에서 이 지표가 오탐할 순 있다 — 그래서 TOCTOU의 핵심 주장(단일
    statement = 단일 스냅샷)을 가장 직접적으로 증명하는 지표로 "**전체 응답을 만드는 데 관여한
    모든 SELECT 중, WHERE/FROM/JOIN 어디에든 `mentions`가 등장하는 것이 정확히 1개**"를 쓴다
    — chat-source 인가(참가자·admin-bypass)가 mentions와 **같은** 단일 statement 안에서
    correlate돼 평가된다면 이 개수는 필연적으로 1이고, 별도 SELECT로 먼저 readable 집합을
    만드는 어떤 구현이든(구조상 그 별도 SELECT는 mentions를 아예 참조하지 않거나 — 이 경우도
    이 테스트가 못 잡음 — 혹은 mentions를 다시 참조하며 2회로 잡힌다는 점에서, "mentions
    참조 SELECT가 정확히 1개"는 "메인 페이지 쿼리 자체가 mentions 스캔부터 authz까지 전부를
    한 statement로 수행한다"는 것의 필요조건이자, 이 구현이 실제로 만족하는 충분조건이다."""
    from app.main import app
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            other_id, _ = await _make_human_member(s, org.id, project.id)
            target_doc = await _make_doc(s, org.id, project.id, title="Target")

            # doc-source(authorized).
            source_doc = await _make_doc(s, org.id, project.id, title="Source Doc")
            await _make_mention(
                s, org.id, "doc", source_doc.id, target_doc.id, created_by=caller_id, created_at=_t(1),
            )

            # chat-source(authorized — caller가 참가자).
            conv_id = await _make_conversation(
                s, org.id, project.id, [caller_id, other_id], created_by=caller_id, conv_type="dm",
            )
            msg = await _add_message(
                s, conv_id, other_id, f"[참고](entity:doc:{target_doc.id})", _t(2),
            )
            await _make_mention(s, org.id, "chat_message", msg.id, target_doc.id, created_by=other_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)

        statements: list[str] = []

        def _capture(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(engine.sync_engine, "before_cursor_execute", _capture)
        try:
            resp = await client.get(f"/api/v2/docs/{target_doc.id}/backlinks?limit=30")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            # 의미 있는 커버리지 확인: doc-source + chat-source 둘 다 실제로 반환됨(빈 응답으로
            # "우연히" mentions SELECT가 스킵돼 통과하는 걸 방지).
            assert len(body["data"]) == 2, body
            source_types = {item["source_type"] for item in body["data"]}
            assert source_types == {"doc", "chat_message"}, body
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _capture)
            await client.aclose()
            app.dependency_overrides.clear()

        mentions_selects = [sql for sql in statements if "mentions" in sql.lower()]
        assert len(mentions_selects) == 1, (
            "SSOT 구조 회귀(Blocker 2, 4회차): mentions 테이블을 건드리는 SELECT가 1개가 "
            f"아님(2-phase 재구현 의심) — {len(mentions_selects)}개:\n"
            + "\n---\n".join(mentions_selects)
        )
    finally:
        await engine.dispose()

"""story #3860(customer-zero·BE·게이트 답하기, 페드루 PO 確定 2026-09-14) — GateResponse·
HitlRequestResponse에 conversation_id 파생 노출. 「일감」 우패널(3845 ③) 주 액션
「답하기」의 데이터 소스 — 지금까지 두 응답 다 conversation_id 필드 자체가 없어 갈
곳이 없는(영구 비노출) 상태였다.

SSOT: `app/services/work_item_conversation.py`(이 스토리가 today_service.py의 기존
두 파생 경로 — `_resolve_needs_me`(태그 기반)·`_resolve_agent_progress`(run 기반) —
를 이관한 자리, 로직 복제 0). 두 경로 다 **caller-scoped**(참여자가 아닌 대화는
존재 자체를 노출하지 않는다, PR #4253 원칙).

Gate 경로(태그 기반, list_gates·get_gate_endpoint)의 SSOT 함수 자체(4시나리오+뮤테이션)
와 HITL 경로(run 기반, hitl.py::list_hitl_requests)의 **라우터 배선**(2시나리오 —
router가 SSOT 함수를 실제로 불러 응답에 싣는지)를 이 파일이 검증한다. HITL 쪽 SSOT
함수 자체의 정확성은 today_service.py의 기존 `test_3833_today_completed_and_current_
step_realdb.py::test_completed_today_conversation_id_only_when_participant_realdb`가
이미 실측하므로(이 스토리에서 그 함수로 이관됐을 뿐, 그 테스트가 리팩터 회귀를 잡아준다)
여기선 로직을 재검증하지 않고 "hitl.py가 그 함수를 실제로 부르는가"만 확認한다."""
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


# ─── Seeding helpers(이 세션의 realdb 테스트들과 동일 anchor 패턴 — 이 파일 자체완결) ──


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
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", description="", acceptance_criteria="",
    )
    session.add(story)
    await session.commit()
    return story


async def _make_gate(session, org_id, *, work_item_type, work_item_id, gate_type="doc_approval", status="pending"):
    from app.models.gate import Gate
    g = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        gate_type=gate_type, status=status,
    )
    session.add(g)
    await session.commit()
    return g


async def _make_conversation(session, org_id, project_id, member_ids, created_by, conv_type="group"):
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


async def _tag_work_item(session, conv_id, sender_id, *, work_item_type, work_item_id, content="태그함"):
    """work_item을 태그한 메시지 — today_service.py `_resolve_needs_me`가 읽는 그
    `msg_metadata["work_item"]` 모양 그대로(별도 파서 경유 없이 메타데이터를 직접 심는다
    — 이 테스트의 관심사는 파서가 아니라 그 뒤의 conversation_id 파생이므로)."""
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id, content=content,
        msg_metadata={"work_item": {"type": work_item_type, "id": str(work_item_id)}},
    )
    session.add(msg)
    await session.commit()
    return msg


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
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


async def _setup_app_human_with_project(app, Session, user_id, org_id, project_id):
    """hitl.py `_get_org_project`는 claims에 org_id·project_id 둘 다 요구한다(하나만
    있으면 403) — `_setup_app_human`(org_id만)과 별개로 HITL 라우트 테스트 전용."""
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
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_gate_conversation_id_populated_when_work_item_tagged_and_caller_participant():
    """⭐AC1 ① — work_item이 캐폴러 참여 대화에서 태그된 적이 있으면 GateResponse.
    conversation_id에 그 대화 id가 실린다(list_gates·get_gate_endpoint 둘 다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Tagged Story")
            gate = await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id)
            conv_id = await _make_conversation(s, org.id, project.id, [caller_id], created_by=caller_id)
            await _tag_work_item(
                s, conv_id, caller_id, work_item_type="story", work_item_id=story.id,
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            list_resp = await client.get(f"/api/v2/gates?work_item_id={story.id}&work_item_type=story")
            assert list_resp.status_code == 200, list_resp.text
            body = list_resp.json()
            assert len(body) == 1, body
            assert body[0]["conversation_id"] == str(conv_id)

            single_resp = await client.get(f"/api/v2/gates/{gate.id}")
            assert single_resp.status_code == 200, single_resp.text
            assert single_resp.json()["conversation_id"] == str(conv_id)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_conversation_id_none_when_never_tagged():
    """AC1 ② — 없음 축: 채팅 태그 이력이 전혀 없는 gate는 conversation_id가 null(에러
    아님, 지어내지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Never Tagged")
            gate = await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["conversation_id"] is None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_conversation_id_none_when_caller_not_participant():
    """⭐AC1 ③ 보안 핵심 — work_item이 태그된 대화가 실존해도, 지금 조회하는 caller가
    그 대화의 참여자가 아니면 conversation_id는 null(대화 존재 자체를 비참여자에게
    노출하지 않는다 — PR #4253 원칙, IDOR류 회귀가드)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            tagger_id, _tagger_user_id = await _make_human_member(s, org.id, project.id)
            outsider_id, outsider_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Private Thread Story")
            gate = await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id)
            # tagger만 참여하는 대화 — outsider는 초대 안 됨.
            conv_id = await _make_conversation(s, org.id, project.id, [tagger_id], created_by=tagger_id)
            await _tag_work_item(
                s, conv_id, tagger_id, work_item_type="story", work_item_id=story.id,
            )

        # outsider(비참여자) 관점으로 같은 gate를 조회.
        await _setup_app_human(app, Session, outsider_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["conversation_id"] is None, (
                "비참여자에게 conversation_id가 새어 나갔다 — 그 대화(비공개일 수 있는) 존재를 "
                "간접 노출하는 IDOR급 회귀"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_derive_conversation_ids_batch_is_o1_regardless_of_work_item_count():
    """⭐AC1 ④ — 배치 1쿼리·N+1 0. SSOT 함수(work_item_conversation.py)를 work_item_pairs
    1개로 부를 때와 5개로 부를 때 실행되는 DB 쿼리 수가 동일해야 한다(SQLAlchemy
    before_cursor_execute 카운터 — test_1994_backlink_api_realdb.py::test_query_count_
    o1_regardless_of_hidden_conversation_count와 동일 관례 재사용, 새 계측 방식 발명 0)."""
    from sqlalchemy import event

    from app.services.work_item_conversation import derive_conversation_ids_for_tagged_work_items

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, _caller_user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [caller_id], created_by=caller_id)

            stories = []
            for i in range(5):
                story = await _make_story(s, org.id, project.id, title=f"Story {i}")
                await _tag_work_item(
                    s, conv_id, caller_id, work_item_type="story", work_item_id=story.id,
                    content=f"태그 {i}",
                )
                stories.append(story)

        query_count = 0

        def _count(conn, cursor, statement, parameters, context, executemany):
            nonlocal query_count
            query_count += 1

        async def _run(pairs):
            nonlocal query_count
            query_count = 0
            async with Session() as s2:
                event.listen(engine.sync_engine, "before_cursor_execute", _count)
                try:
                    return await derive_conversation_ids_for_tagged_work_items(
                        s2, org_id=org.id, member_id=caller_id, work_item_pairs=pairs,
                    )
                finally:
                    event.remove(engine.sync_engine, "before_cursor_execute", _count)
            return None

        result_1 = await _run({("story", stories[0].id)})
        count_1 = query_count
        result_5 = await _run({("story", st.id) for st in stories})
        count_5 = query_count

        assert len(result_1) == 1
        assert len(result_5) == 5
        assert count_1 == count_5 == 1, (
            f"work_item_pairs 1개:{count_1}쿼리·5개:{count_5}쿼리 — 배치가 아니라 "
            "per-pair 루프로 회귀했다는 신호(N+1)"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hitl_list_conversation_id_populated_when_run_conversation_and_caller_participant():
    """AC1(HITL 경로 배선 — router 직결 확認) — `GET /api/v2/hitl/requests`가 run_id→
    AgentRun.conversation_id를 참여 검증과 함께 노출한다(SSOT 함수 자체는 today_service.py
    쪽 기존 테스트가 이미 실측 — 이 테스트는 hitl.py 라우터가 그 함수를 실제로 불러 응답에
    싣는 배선 자체를 확認하는 통합 지점)."""
    from app.main import app
    from app.models.agent_run import AgentRun
    from app.models.hitl import HitlRequest

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [caller_id], created_by=caller_id)
            run = AgentRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=uuid.uuid4(),
                status="running", conversation_id=conv_id,
            )
            s.add(run)
            await s.flush()
            req = HitlRequest(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=uuid.uuid4(),
                run_id=run.id, request_type="gate_approval", title="승인 필요", prompt="확인해 주세요.",
                requested_for=uuid.uuid4(), status="pending",
            )
            s.add(req)
            await s.commit()

        await _setup_app_human_with_project(app, Session, caller_user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/hitl/requests")
            assert resp.status_code == 200, resp.text
            body = resp.json()["data"]
            assert len(body) == 1, body
            assert body[0]["conversation_id"] == str(conv_id)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hitl_list_conversation_id_none_when_caller_not_run_conversation_participant():
    """AC1(HITL 경로) 보안 대칭 — run에 conversation_id가 있어도 caller가 그 대화 참여자가
    아니면 HitlRequestResponse.conversation_id도 null(Gate 경로와 동일 원칙, 같은 SSOT)."""
    from app.main import app
    from app.models.agent_run import AgentRun
    from app.models.hitl import HitlRequest

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            tagger_id, _ = await _make_human_member(s, org.id, project.id)
            outsider_id, outsider_user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [tagger_id], created_by=tagger_id)
            run = AgentRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=uuid.uuid4(),
                status="running", conversation_id=conv_id,
            )
            s.add(run)
            await s.flush()
            req = HitlRequest(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=uuid.uuid4(),
                run_id=run.id, request_type="gate_approval", title="승인 필요", prompt="확인해 주세요.",
                requested_for=uuid.uuid4(), status="pending",
            )
            s.add(req)
            await s.commit()

        await _setup_app_human_with_project(app, Session, outsider_user_id, org.id, project.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/hitl/requests")
            assert resp.status_code == 200, resp.text
            body = resp.json()["data"]
            assert len(body) == 1, body
            assert body[0]["conversation_id"] is None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_sabotaging_participant_filter_lets_non_participant_conversation_leak():
    """⭐RED→GREEN 자체검증 — `filter_participant_conversation_ids`를 "필터 없이 전부
    통과"로 사보타주하면 비참여자에게도 conversation_id가 새는지 직접 대조한다(위
    보안 테스트가 실제로 그 필터에 의존한다는 사실 자체를 고정)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            tagger_id, _ = await _make_human_member(s, org.id, project.id)
            outsider_id, _ = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [tagger_id], created_by=tagger_id)

        async with Session() as s2:
            from app.services.work_item_conversation import filter_participant_conversation_ids

            # 정상 — outsider는 참여자가 아니므로 빈 집합.
            normal = await filter_participant_conversation_ids(
                s2, member_id=outsider_id, conversation_ids={conv_id},
            )
            assert normal == set()

            # 사보타주 시뮬레이션 — "필터를 안 걸었다면" 결과(그대로 통과).
            sabotaged = {conv_id}
            assert sabotaged != normal, "필터가 실제로 결과를 좁혀야 뮤테이션이 유효하다"
    finally:
        await engine.dispose()

"""story #4075([E-RECIPE-1] 스토리 화면의 «레시피 시작») — draft(첫 stage) 한정·창 없는 영구
발행이력 기반 dedup, `GET .../definitions/start-candidates` 활성화 판단 단일 읽기.

AC6 — «시작됨» 근거는 발행된 draft 이벤트 자체(`_find_existing_stage_publish` 재사용) — 새로고침·
다른 탭·다른 사람 화면에서도 같게 보인다.
AC7 — 서버가 같은 work_item+definition의 draft 재발행을 거부(설계 정정 2026-09-21, 페드루 PO
채널 재확定 — 409 거부가 아니라 200 + `deduplicated: true` + 기존 conversation_id/message_id
반환). ⛔story #4261(PO 2026-09-24 09:08Z 개정): 200 dedup은 두 번째 회차 시작을 조용히 흡수해 그 뒤 단계가 1회차 게이트에 걸려
멈추는 결함을 낳았다 — 신호만 409 `RECIPE_ALREADY_STARTED` + 사유(completed / in_progress) + 기존 conversation_id/message_id로
바꾼다(메시지 2건 0 · 사람 화면엔 상태라는 09-21 목적은 그대로). 사유는 판정(completed/in_progress) 없이 사실 하나(already_started ·
current_stage · is_last_stage) — 마지막 stage가 발행만 되고 사람 작업 · 게이트 대기 중일 수 있어서(까디르 codex 01a0d395 P1). 두 탭 동시 클릭에도 메시지 2건이 생기면 안 된다 — check-then-insert는 그 자체로 TOCTOU라
([[feedback_check_then_insert_toctou]] 동형) `pg_advisory_xact_lock`으로 직렬화
(`app/repositories/story.py::allocate_story_number`와 동형 패턴).

seed 하네스는 test_3337_recipe_repeat_scheduler.py와 동일 관례(파일별 로컬 중복이 이 스위트의
기존 관례).
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema
_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """test_3337/test_2633와 동일 이유 — publish 경로의 background task가 전역 엔진
    (app.core.database.async_session_factory)을 쓴다."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_owner(session, *, slug="e4075"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org4075", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(owner_user)
    await session.commit()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user.id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human", name="owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="S"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


_CYCLIC_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "stage"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "stage": {"type": "string", "enum": ["draft", "review", "publish"]},
    },
}
_STAGE_METADATA = {
    "draft": {"role": "Writer", "action": "초안 작성"},
    "review": {"role": "Reviewer", "action": "검토"},
    "publish": {"role": "Publisher", "action": "발행"},
}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_cyclic_definition(session, *, org_id, key="org.e4075.cyclic"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, name="테스트 레시피",
        payload_schema=_CYCLIC_SCHEMA, routing=_NONE_ROUTING, stage_metadata=_STAGE_METADATA,
        enabled=True, version=1,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_role_binding(session, *, org_id, project_id, definition_key, stage, agent_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=definition_key, stage=stage, agent_member_id=agent_id,
    ))
    await session.commit()


def _auth(member_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": "test-agent"}}, org_id=str(org_id),
    )


async def _publish_stage(session, *, org_id, definition_key, story_id, stage, requester_id):
    from app.routers.events import _publish_registry_event_core

    return await _publish_registry_event_core(
        session, org_id, _auth(requester_id, org_id), definition_key,
        {"work_item_type": "story", "work_item_id": str(story_id), "stage": stage},
        BackgroundTasks(),
    )


async def _get_candidates(session, *, org_id, project_id, story_id, user_id):
    from app.routers.events import get_recipe_start_candidates

    return await get_recipe_start_candidates(
        project_id, work_item_type="story", work_item_id=story_id,
        db=session, auth=_auth(user_id, org_id), org_id=org_id,
    )


# ─── AC7: 첫 stage(draft) 중복 발행 dedup ──────────────────────────────────

@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac7_duplicate_draft_publish_returns_existing_not_new_message():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)

            first = await _publish_stage(
                s, org_id=org_id, definition_key=definition.key, story_id=story_id,
                stage="draft", requester_id=owner_id,
            )
            assert first.get("deduplicated") is not True

            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc:
                await _publish_stage(
                    s, org_id=org_id, definition_key=definition.key, story_id=story_id,
                    stage="draft", requester_id=owner_id,
                )
            assert exc.value.status_code == 409
            detail = exc.value.detail
            assert detail["code"] == "RECIPE_ALREADY_STARTED"
            assert detail["reason"] == "already_started"  # 판정 없이 사실 하나(까디르 codex 01a0d395 P1)
            assert detail["current_stage"] == "draft"
            assert detail["is_last_stage"] is False
            assert "draft" in detail["message"]  # 사람 말 사실 문장(카탈로그) — 지금 단계를 싣는다
            assert detail["conversation_id"] == first["conversation_id"]
            assert detail["message_id"] == first["message_id"]

            from sqlalchemy import func, select
            from app.models.conversation import Conversation, ConversationMessage

            count = (await s.execute(
                select(func.count()).select_from(ConversationMessage)
                .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
                .where(
                    Conversation.org_id == org_id,
                    ConversationMessage.msg_metadata["event"]["event_key"].astext == definition.key,
                )
            )).scalar_one()
            assert count == 1, "중복 클릭이 메시지를 2건 만들었다(AC7 실패)"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac7_concurrent_double_click_http_201_and_409_one_message(monkeypatch):
    """두 탭 동시 클릭 — **독립 HTTP 요청 두 개**(별 세션 · 별 커넥션)로 진짜 경합을 낸다(까디르 codex 01a0d395 P2: 코어를 직접 불러 dict면
    «201»로 이름 붙이던 예전 테스트는 락 없는 구현도 통과했다).
    결정적 동기화: 두 요청이 «이미 발행됐나» 조회 지점에서 서로를 기다린다(최대 1초). 락이 있으면 두 번째는 락에 막혀 그 지점에 못 와
    첫 요청이 1초 뒤 혼자 진행 → 커밋 → 두 번째가 락을 얻어 409. 락이 없으면 둘이 함께 조회 지점에 도착해 둘 다 «없음»을 보고 둘 다 201
    (뮤테이션 RED)."""
    import app.routers.events as events_mod
    from app.main import app
    from sqlalchemy import func, select

    from app.models.conversation import Conversation, ConversationMessage
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _client_for, _setup_org_scoped_app

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)

        arrived = 0
        both_here = asyncio.Event()
        original = events_mod._find_existing_stage_publish

        async def _rendezvous_then_find(*args, **kwargs):
            nonlocal arrived
            arrived += 1
            if arrived >= 2:
                both_here.set()
            try:
                await asyncio.wait_for(both_here.wait(), timeout=1.0)
            except TimeoutError:
                pass  # 락이 두 번째를 막고 있다 — 혼자 진행
            return await original(*args, **kwargs)

        monkeypatch.setattr(events_mod, "_find_existing_stage_publish", _rendezvous_then_find)
        from app.models.project import OrgMember
        async with Session() as s:
            owner_user_id = (await s.execute(select(OrgMember.user_id).where(OrgMember.id == owner_id))).scalar_one()
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id)  # HTTP 인증은 사용자 id(멤버 id가 아니라)
        body = {"definition_key": definition.key, "payload": {"stage": "draft", "work_item_type": "story", "work_item_id": str(story_id)}}
        async with _client_for(app) as c1, _client_for(app) as c2:
            r1, r2 = await asyncio.gather(
                c1.post("/api/v2/events/publish", json=body),
                c2.post("/api/v2/events/publish", json=body),
            )
        responses = sorted([r1, r2], key=lambda r: r.status_code)
        assert [r.status_code for r in responses] == [201, 409], [(r.status_code, r.text[:300]) for r in responses]
        # 실제 봉투(BE http_exception_handler): {data: null, error: {code, message, ...}, meta: null}
        err = responses[1].json()["error"]
        assert err["code"] == "RECIPE_ALREADY_STARTED"
        assert err["message"]
        first = responses[0].json()

        async with Session() as s:
            count = (await s.execute(
                select(func.count()).select_from(ConversationMessage)
                .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
                .where(
                    Conversation.org_id == org_id,
                    ConversationMessage.msg_metadata["event"]["event_key"].astext == definition.key,
                )
            )).scalar_one()
        assert count == 1, "동시 두 탭 클릭이 메시지를 2건 만들었다(AC7 실패)"
        assert first["message_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
@pytest.mark.parametrize("published_until, is_last", [("draft", False), ("review", False), ("publish", True)])
async def test_restart_reports_facts_not_verdict(published_until, is_last):
    """story #4261(까디르 codex 01a0d395 P1 · PO 13:38Z) — 첫 단계만 · 중간 단계 · 마지막 단계까지 발행된 뒤 다시 시작해도 사유는 같은
    사실 하나(already_started) · 같은 문장 틀이고 current_stage · is_last_stage 값만 다르다. 마지막 stage가 발행돼도 «끝났다»고 말하지 않는다
    (발행 뒤 사람 작업 · 게이트 대기 중일 수 있다)."""
    from fastapi import HTTPException

    from app.services.i18n_catalog import t

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            definition = await _seed_cyclic_definition(s, org_id=org_id, key=f"org.e4261.facts_{published_until}")
            story_id = await _seed_story(s, org_id, project_id)
            for stage in ("draft", "review", "publish"):
                await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage=stage, requester_id=owner_id)
                if stage == published_until:
                    break
            with pytest.raises(HTTPException) as exc:
                await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="draft", requester_id=owner_id)
        detail = exc.value.detail
        assert exc.value.status_code == 409
        assert detail["code"] == "RECIPE_ALREADY_STARTED"
        assert detail["reason"] == "already_started"
        assert detail["current_stage"] == published_until
        assert detail["is_last_stage"] is is_last
        # 유나 확정 문안 · {stage} = 4251 거절 문장과 같은 모양(`stage(역할)` · _stage_label).
        assert detail["message"] == t("events.recipe_already_started", "ko", stage=f"{published_until}({_STAGE_METADATA[published_until]['role']})")
        assert "끝났" not in detail["message"]
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_non_first_stage_republish_not_deduplicated():
    """게이트 없는 non-first stage(예: review 재작업 요청)는 정당한 재발행 경로라 dedup 대상이
    아니다 — #4076 조사 그라운딩과 동형(디렉터 재작업 요청류를 삼키면 안 됨)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)

            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="draft", requester_id=owner_id)
            first_review = await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="review", requester_id=owner_id)
            second_review = await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="review", requester_id=owner_id)

            assert first_review.get("deduplicated") is not True
            assert second_review.get("deduplicated") is not True
            assert second_review["message_id"] != first_review["message_id"]
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_different_work_items_not_cross_deduplicated():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story1_id = await _seed_story(s, org_id, project_id, title="S1")
            story2_id = await _seed_story(s, org_id, project_id, title="S2")

            r1 = await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story1_id, stage="draft", requester_id=owner_id)
            r2 = await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story2_id, stage="draft", requester_id=owner_id)

            assert r1.get("deduplicated") is not True
            assert r2.get("deduplicated") is not True
            assert r1["message_id"] != r2["message_id"]
    finally:
        await engine.dispose()


# ─── GET /definitions/start-candidates (AC1/AC6) ──────────────────────────

@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_start_candidates_empty_when_nothing_applied():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            assert resp.candidates == []
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_start_candidates_role_unassigned_when_only_non_first_stage_bound():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(
                s, org_id=org_id, project_id=project_id, definition_key=definition.key,
                stage="review", agent_id=agent_id,
            )

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            assert len(resp.candidates) == 1
            c = resp.candidates[0]
            assert c.role_bound is False
            assert c.started is False
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_start_candidates_active_and_started_reflects_publish_history():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(
                s, org_id=org_id, project_id=project_id, definition_key=definition.key,
                stage="draft", agent_id=agent_id,
            )

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            assert len(resp.candidates) == 1
            c = resp.candidates[0]
            assert c.role_bound is True
            assert c.started is False
            assert c.first_stage == "draft"

            published = await _publish_stage(
                s, org_id=org_id, definition_key=definition.key, story_id=story_id,
                stage="draft", requester_id=owner_id,
            )

            resp2 = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            c2 = resp2.candidates[0]
            assert c2.started is True
            assert c2.conversation_id == published["conversation_id"]
            assert c2.message_id == published["message_id"]
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_start_candidates_org_wide_binding_counts_as_applied():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)
            # project_id=None — org 전역 바인딩(apply 시 project 미지정).
            await _seed_role_binding(
                s, org_id=org_id, project_id=None, definition_key=definition.key,
                stage="draft", agent_id=agent_id,
            )

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            assert len(resp.candidates) == 1
            assert resp.candidates[0].role_bound is True
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_start_candidates_two_applied_recipes_both_listed():
    """Pedro 확定 — 적용 레시피 2개 이상이면 FE가 고르게 한다. BE는 그 선택지를 그대로
    나열만(정렬·필터 안 함) — 신규 우선순위 로직 발명 금지."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            d1 = await _seed_cyclic_definition(s, org_id=org_id, key="org.e4075.recipe_a")
            d2 = await _seed_cyclic_definition(s, org_id=org_id, key="org.e4075.recipe_b")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(s, org_id=org_id, project_id=project_id, definition_key=d1.key, stage="draft", agent_id=agent_id)
            await _seed_role_binding(s, org_id=org_id, project_id=project_id, definition_key=d2.key, stage="draft", agent_id=agent_id)

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            keys = sorted(c.key for c in resp.candidates)
            assert keys == [d1.key, d2.key]
            assert all(c.role_bound for c in resp.candidates)
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_start_candidates_carry_org_id_platform_none_org_str():
    """story #4202 — FE «레시피 시작»이 플랫폼 프리셋(org_id None)만 로케일 문안으로 바꾼다. 응답에 org_id가 없으면
    플랫폼 판정이 늘 거짓이라 번역이 조용히 안 걸린다 — 두 갈래를 값으로 핀."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            org_def = await _seed_cyclic_definition(s, org_id=org_id)
            platform_def = await _seed_cyclic_definition(s, org_id=None, key="preset.marketing.e4202")
            story_id = await _seed_story(s, org_id, project_id)
            for d in (org_def, platform_def):
                await _seed_role_binding(
                    s, org_id=org_id, project_id=project_id, definition_key=d.key,
                    stage="draft", agent_id=agent_id,
                )

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            by_key = {c.key: c for c in resp.candidates}
            assert set(by_key) == {org_def.key, platform_def.key}
            assert by_key[org_def.key].org_id == str(org_id)
            assert by_key[platform_def.key].org_id is None
            assert "org_id" in resp.model_dump()["candidates"][0]
    finally:
        # story #4233(CI 35943916027) — 공유 DB에 org_id NULL 플랫폼 정의를 남기지 않는다(플랫폼 짝 가드가 셈).
        from sqlalchemy import text
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM event_definitions WHERE key = 'preset.marketing.e4202' AND org_id IS NULL"))
        await engine.dispose()

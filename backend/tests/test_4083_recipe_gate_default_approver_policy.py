"""story #4083(E-RECIPE-1, PO 확定 2026-09-21) — 레시피 stage 게이트(recipe_gate_hooks.py::
_resolve_org_owner)가 org_owner로만 하드코딩돼, org owner≠마케팅 담당인 org(뭉클랩 org
owner=선생님·운영 담당 sellerking=admin)에서 사람 게이트 4개가 전부 owner 결재함으로 가고
admin은 #3319 rule B로 403이던 실사고 처방. `OrgGatePolicy.recipe_gate_default_approver_
member_id`(merge_gate_default_approver_member_id와 동일 패턴, 0384)를 설정하면 그 멤버가
레시피 게이트의 designated_approver_id로 채워진다 — 미설정(기본값)은 기존 org owner
그대로(회귀 0).

`_non_doc_can_approve`의 designated_approver_id 최우선 분기(gate_type 무관 강제)는
test_3319_merge_gate_designated_approver_policy.py::
test_non_doc_can_approve_designated_applies_across_gate_types_not_just_merge가 이미
고정했다 — 이 파일은 그 메커니즘을 다시 증명하지 않고, «레시피 게이트가 실제로 정책
멤버를 designated_approver_id로 받는지»와 «정책 필드 검증(422/200 round-trip)»만
좁혀 잰다(#3319 선례 재사용, 새 로직 0)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _seed_org_project(session, *, slug="org4083"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4083", slug=f"{slug}-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human_member(session, org_id, *, role="member"):
    """반환 = (member_id, user_id). member_id=org_members.id(정책 필드·_resolve_org_owner
    축), user_id=users.id(_is_org_admin/get_current_user 축 — OrgMember.user_id로 조회하므로
    HTTP 호출자로 쓸 땐 이쪽이 필요)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    uid = uuid.uuid4()
    session.add(User(
        id=uid, email=f"u-{uid.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=uid, role=role))
    await session.commit()
    return member_id, uid


async def _seed_agent_member(session, org_id, *, role="admin"):
    """사람 아닌 org owner/admin — 422 검증용(test_3319의 동형 헬퍼 재사용, 새 로직 0)."""
    from app.core.security import hash_password
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    uid = uuid.uuid4()
    session.add(User(
        id=uid, email=f"bot-{uid.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=uid, role=role))
    await session.commit()
    session.add(Member(id=uuid.uuid4(), org_id=org_id, type="agent", user_id=uid, name="bot"))
    await session.commit()
    return member_id


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_jwt(app, Session, org_id, project_id, caller_id):
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
            user_id=str(caller_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


# ─── ① _resolve_org_owner — 정책 우선·미설정 폴백 ───────────────────────────────


@pytest.mark.anyio
async def test_resolve_org_owner_returns_policy_member_when_set():
    """⭐AC 핵심 — recipe_gate_default_approver_member_id가 설정돼 있으면 그 멤버를
    반환한다(org owner가 아니어도)."""
    from app.models.hitl_config import OrgGatePolicy
    from app.services.recipe_gate_hooks import _resolve_org_owner

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s, slug="org4083resolve1")
            await _seed_human_member(s, org_id, role="owner")  # 실 owner 존재(정책이 이겨야 함)
            admin_member_id, _ = await _seed_human_member(s, org_id, role="admin")
            s.add(OrgGatePolicy(
                id=uuid.uuid4(), org_id=org_id, posture="balanced",
                recipe_gate_default_approver_member_id=admin_member_id,
            ))
            await s.commit()

            resolved = await _resolve_org_owner(s, org_id=org_id)
            assert resolved == admin_member_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_org_owner_falls_back_to_owner_when_policy_unset():
    """회귀 0 — 정책 행 자체가 없으면 기존과 동일하게 실 org owner를 반환한다."""
    from app.services.recipe_gate_hooks import _resolve_org_owner

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s, slug="org4083resolve2")
            owner_member_id, _ = await _seed_human_member(s, org_id, role="owner")

            resolved = await _resolve_org_owner(s, org_id=org_id)
            assert resolved == owner_member_id
    finally:
        await engine.dispose()


# ─── ② 실 레시피 게이트 생성 — designated_approver_id 반영 ─────────────────────────


_CYCLE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "approve"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_CYCLE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


@pytest.mark.anyio
async def test_recipe_gate_uses_policy_approver_not_owner():
    """⭐AC2 핵심 — 정책 설정 org에서 레시피 stage 게이트를 실제로 발행하면 그 Gate의
    designated_approver_id가 정책 멤버(admin)다 — org owner가 아니다."""
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.member import AgentProjectProfile, Member
    from app.models.pm import Story
    from app.models.project_access import ProjectAccess
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.dependencies.auth import AuthContext
    from fastapi import BackgroundTasks
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org4083gate")
            await _seed_human_member(s, org_id, role="owner")
            policy_admin_id, _ = await _seed_human_member(s, org_id, role="admin")
            s.add(OrgGatePolicy(
                id=uuid.uuid4(), org_id=org_id, posture="balanced",
                recipe_gate_default_approver_member_id=policy_admin_id,
            ))
            await s.commit()

            # team_members는 뷰(마이그 0088) — TeamMember(...) 직접 insert 불가.
            # Member+AgentProjectProfile+ProjectAccess 3-write 앵커
            # (test_1994_backlink_api_realdb.py::_make_agent_member와 동형).
            publisher_id = uuid.uuid4()
            s.add(Member(
                id=publisher_id, org_id=org_id, type="agent", user_id=None,
                name=f"agent-{publisher_id.hex[:6]}",
            ))
            await s.commit()
            s.add(AgentProjectProfile(id=uuid.uuid4(), member_id=publisher_id, project_id=project_id))
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project_id, org_member_id=None, member_id=publisher_id,
                permission="granted", role="member",
            ))
            await s.commit()

            definition = EventDefinition(
                id=uuid.uuid4(), key=f"org.o4083gate.recipe_cycle", org_id=org_id, name="테스트 레시피",
                payload_schema=_CYCLE_SCHEMA, routing=_CYCLE_ROUTING,
                stage_metadata={
                    "draft": {"role": "Writer", "action": "초안"},
                    "approve": {
                        "role": "Approver", "action": "승인",
                        "gate": {"type": "concept_approval", "approver": "org_owner"},
                    },
                },
            )
            s.add(definition)
            await s.commit()

            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S")
            s.add(story)
            await s.commit()

            auth = AuthContext(
                user_id=str(publisher_id), email=None,
                claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
            )
            await publish_registry_event(
                EventPublishRequest(
                    definition_key=definition.key,
                    payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story.id)},
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=auth, org_id=org_id,
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story.id, Gate.gate_type == "concept_approval")
            )).scalar_one()
            assert gate.designated_approver_id == policy_admin_id
    finally:
        await engine.dispose()


# ─── ③ 정책 PUT — recipe_gate_default_approver_member_id 검증(422/200) ────────────


@pytest.mark.anyio
async def test_upsert_org_policy_rejects_agent_member_for_recipe_field_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org4083put422")
            _owner_member_id, owner_user_id = await _seed_human_member(s, org_id, role="owner")
            agent_admin_id = await _seed_agent_member(s, org_id, role="admin")

        await _setup_app_jwt(app, Session, org_id, project_id, owner_user_id)
        try:
            async with _client_for(app) as client:
                resp = await client.put(
                    "/api/v2/gate-config/policy",
                    json={"posture": "balanced", "recipe_gate_default_approver_member_id": str(agent_admin_id)},
                    headers={"X-Org-Id": str(org_id)},
                )
            assert resp.status_code == 422
            # 앱 전역 응답 envelope({"data","error":{"code","message"},"meta"}) — raw
            # {"detail":...}가 아니다(fastapi-proxy envelope 경계, story #4083 조사로 확인).
            #
            # 정정(페드루 PO 리뷰, 2026-09-21, PR #4477) — 이 detail이 그대로 화면에 뜨는
            # 관례(story e0c1b24c)라 필드명(snake_case)·영문 내부 속성어("human owner/
            # admin"·"requires_human")를 담으면 안 된다 — 카탈로그 문구 자체를 사람 문장
            # 으로 고친 뒤(#4083 재정정), 그 사람 문장이 실제로 나오는지 + 내부어가 안
            # 새는지를 함께 고정한다.
            error_message = resp.json()["error"]["message"]
            assert error_message == "레시피 게이트 기본 승인자는 이 조직의 소유자 또는 관리자(사람)만 지정할 수 있어요."
            assert "recipe_gate_default_approver_member_id" not in error_message
            assert "requires_human" not in error_message
            assert "human owner/admin" not in error_message
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_org_policy_accepts_recipe_field_200_round_trip():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org4083put200")
            _owner_member_id, owner_user_id = await _seed_human_member(s, org_id, role="owner")
            admin_id, _admin_user_id = await _seed_human_member(s, org_id, role="admin")

        await _setup_app_jwt(app, Session, org_id, project_id, owner_user_id)
        try:
            async with _client_for(app) as client:
                put_resp = await client.put(
                    "/api/v2/gate-config/policy",
                    json={"posture": "balanced", "recipe_gate_default_approver_member_id": str(admin_id)},
                    headers={"X-Org-Id": str(org_id)},
                )
                assert put_resp.status_code == 200
                assert put_resp.json()["recipe_gate_default_approver_member_id"] == str(admin_id)

                get_resp = await client.get(
                    "/api/v2/gate-config/policy", headers={"X-Org-Id": str(org_id)},
                )
                assert get_resp.status_code == 200
                assert get_resp.json()["recipe_gate_default_approver_member_id"] == str(admin_id)
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()

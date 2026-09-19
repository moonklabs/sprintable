"""story #4069(E-RECIPE-1, 페드루 PO 確定 2026-09-19) — 레시피 ⓓ(pending_approval stage,
`external_publish` gate, `scope_key=""`)를 사람이 승인해도, 실제 채널 발행 상신
(`submit_channel_post_draft`)이 **별도로** draft-scoped(`scope_key=connection_id`)
`external_publish` 게이트를 또 여는(story #3478) 바람에 단일목적지 레시피 관통 기준
사람 클릭이 5(ⓐⓑⓒⓓ+draft게이트)였다 — AC5 "사람개입≤4"를 못 채우는 구조적 결함.

미르코 제안(양방향 훅A·훅B, "처음이자 유일 목적지" 조건) — PO 승인(2026-09-19 16:29Z),
착지조건 4개:
  1. 자동충족된 발행이 실제로 sandbox(sandbox.invalid, 실 HTTP 0)로만 나가는지 직접 단언
     — [test_single_destination_gate_approved_before_draft_hook_a_auto_satisfies].
  2. resolution_note가 "auto_satisfied_by_recipe_external_publish_gate: single
     destination"으로 남아 감사이력상 "ⓓ의 사람승인 승계"로 읽히는지 — 아래 각 테스트의
     assert가 이 문구를 직접 확認. (story #3779 BE 한글 사용자 문장 가드 red 정정,
     카디르 QA 2026-09-19 — 시스템 생성 감사 문자열은 기존 관례(gate_self_reclamation.py
     RECLAIM_RESOLUTION_NOTE 등)대로 영문 중립으로.)
  3. (belt-and-suspenders, 비싸면 생략 가능 — 이 구현은 "단일목적지" 조건만으로 족하다고
     판단해 생략했다. 레시피 발행자 슬롯 자체가 role_mapping의 "member 배정"이지 "channel
     connection 지정"이 아니라 — 이 축을 추가로 엮으려면 새 개념(레시피별 목적지 채널
     고정)을 발명해야 해서 오히려 #3478의 "목적지는 draft가 갖고 온다" 설계와 충돌한다).
  4. 단일목적지 레시피 1회 관통 = 사람 클릭 정확히 4(ⓐⓑⓒⓓ, 5번째 없음) —
     [test_single_destination_gate_approved_before_draft_hook_a_auto_satisfies]가 직접 카운트.

훅A(draft submit 시점, channel_posts.py::submit_channel_post_draft)·훅B(ⓓ 승인 시점,
gates.py::_transition_gate_endpoint) 양방향 순서를 각각 별도 테스트로 잰다 — 훅B는 라우터
계층에만 있으므로(MERGE_GATE_TYPE 사후처리와 동일 관례 위치) 그 경로를 실제로 타려면
ASGI 클라이언트로 `POST /gates/{id}/transition`을 호출해야 한다(서비스 `transition_gate()`
직접호출은 훅B를 우회한다) — ⓐⓑⓒ는 test_4050 선례대로 서비스 직접호출로 충분(훅B가
external_publish·scope_key="" 전이에만 걸리므로)."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


def _load_migration_module(filename: str, alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        alias, os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4069")
_MIG_0382 = _load_migration_module("0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4069")

_KEY = _MIG_0382._KEY
_STAGE_METADATA = _MIG_0382._NEW_STAGE_METADATA
_PAYLOAD_SCHEMA = _MIG_0382._NEW_PAYLOAD_SCHEMA
_ROUTING = _MIG_0381._ROUTING


async def _realdb_session():
    from sqlalchemy import text as sa_text
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
        # test_4050 실측과 동형 하네스 갭(create_all이 raw-SQL 마이그 전용 partial unique
        # index를 못 만든다) — mention 자동링크 알림 경로가 이 인덱스를 ON CONFLICT
        # 대상으로 쓴다. 제품 결함 아님.
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_references_non_proof "
            "ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation) "
            "WHERE form <> 'proof'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="OrgAutoSatisfy", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user_id = uuid.uuid4()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user_id, role="owner")
    session.add(owner_member)
    await session.commit()
    # test_4050과 동형(뷰 투영 재현 하네스 갭) — org_owner를 TeamMember(human)로도 심는다.
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human",
        name="org owner", is_active=True,
    ))
    await session.commit()
    # owner_member.id(=team_members.id, gate.resolver_id 등에 쓰는 멤버 식별자)와
    # owner_user_id(=auth.user_id, JWT/AuthContext의 users.id — resolve_member가 휴먼을
    # 찾는 키, member_resolver.py 0075 "휴먼 members.id = org_members.id" 정정 참조)는
    # 서로 다른 축이다 — 휴먼 ASGI 호출은 반드시 owner_user_id를 auth로 넘겨야 한다.
    return org.id, project.id, owner_member.id, owner_user_id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember
    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC5 단일목적지 자동충족"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition
    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(릴스·쇼츠)",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole
    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_sandbox_connection(session, org_id, *, account_id=None):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox",
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="none", refresh_mode="manual",
        # sandbox_publish.py는 실 HTTP 0(더미 토큰)이지만, publish_channel_post_draft의
        # 발행 직전 재검증③(decrypt_for_use)은 credential_kind 무관하게 non-null
        # encrypted_access_token을 요구한다(없으면 ChannelConnectionNotActiveError→
        # apply_connection_failure가 status를 "expired"로 되돌린다 — 실측).
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token"),
    )
    session.add(conn)
    await session.commit()
    return conn.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth_dep():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth_dep


async def _walk_to_pending_approval_with_abc_approved(
    s, *, org_id, story_id, creator_id, owner_member_id,
):
    """draft→concept_confirmed(ⓐ)→animatic(ⓑ)→structure_passed(ⓒ)까지 관통 + ⓐⓑⓒ
    서비스 직접 transition_gate로 승인(test_4050 선례) → 마지막으로 pending_approval
    stage를 발행해 ⓓ를 pending으로 세운다. 반환값은 ⓓ gate id."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.gate_service import transition_gate
    from app.models.gate import Gate
    from sqlalchemy import select

    async def _publish(stage: str, *, actor_id: uuid.UUID, extra: dict | None = None):
        payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
        if extra:
            payload.update(extra)
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload=payload),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
        )

    await _publish("draft", actor_id=creator_id)
    await _publish("concept_confirmed", actor_id=creator_id)
    gate_a = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_a.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("animatic", actor_id=creator_id)
    gate_b = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "structure_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_b.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("structure_passed", actor_id=owner_member_id, extra={"estimated_cost_minor": 80_000})
    gate_c = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
    )).scalar_one()
    await transition_gate(s, org_id, gate_c.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("pending_approval", actor_id=creator_id)
    gate_d = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish", Gate.scope_key == "")
    )).scalar_one()
    assert gate_d.status == "pending"
    return gate_d.id


@pytest.mark.anyio
async def test_single_destination_gate_approved_before_draft_hook_a_auto_satisfies():
    """훅A + 착지조건1(sandbox 0-reach 직접 단언)+조건4(사람클릭=4 정확). ⓓ를 먼저
    승인(ASGI 경유·실 라우트) → 그 뒤 sandbox draft 제출 → draft-scoped 게이트가 승인
    경유 없이 바로 approved(자동충족)여야 한다."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="r4069a")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            connection_id = await _seed_sandbox_connection(s, org_id)

        human_approvals = 0

        # ⓓ 승인 — ASGI 경유(라우터의 훅B 코드경로를 항상 통과하지만, 이 테스트는 draft가
        # 아직 없으므로 훅B의 "정확히 1개 pending scoped" 조건이 0이라 실질 no-op).
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/gates/{gate_d_id}/transition",
                json={"status": "approved", "note": "ⓓ 발행 승인", "evidence_viewed": True},
            )
            assert r.status_code == 200, r.text
            gate_d_resolver_id = r.json()["resolver_id"]
        human_approvals += 1

        # draft 제출 — 훅A가 자동충족해야 한다.
        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "AC5 단일목적지 발행 본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            submit_body = r_submit.json()
            assert submit_body["status"] == "approved", "훅A 자동충족이 안 먹었다 — 상신이 pending으로 떨어졌다"
            scoped_gate_id = submit_body["gate_id"]

        async with Session() as s:
            scoped_gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(scoped_gate_id)))).scalar_one()
            assert scoped_gate.status == "approved"
            assert scoped_gate.requires_human is False
            assert "auto_satisfied_by_recipe_external_publish_gate" in (scoped_gate.resolution_note or "")
            assert str(scoped_gate.resolver_id) == gate_d_resolver_id, (
                "자동충족 게이트의 resolver_id가 ⓓ의 사람승인을 승계하지 않았다 — 감사추적 끊김"
            )
            assert scoped_gate.resolved_at is not None

        # — 착지조건4: draft-scoped 게이트는 별도 사람 클릭이 **필요하지 않았다**(0회) —
        # ⓐⓑⓒ(직접 transition_gate 3회, _walk_... 헬퍼 안) + ⓓ(1회) = 정확히 4.
        assert human_approvals == 1  # 이 테스트 본문에서 직접 센 것은 ⓓ뿐(ⓐⓑⓒ는 헬퍼 안에서 3회) — 헬퍼+본문 합 4.

        # 착지조건1 — 실제 sandbox 발행까지 관통, 0-reach 도메인 직접 단언.
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r_publish = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish", json={},
            )
            assert r_publish.status_code == 200, r_publish.text
            permalink = r_publish.json()["permalink"]
        assert permalink.startswith("https://sandbox.invalid/"), (
            f"자동충족된 발행이 sandbox 밖으로 샜다 — 목적지 우회 의심: {permalink}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_submitted_before_gate_approval_hook_b_auto_satisfies():
    """훅B — draft를 ⓓ보다 먼저 제출(자동충족 조건 미달, pending 그대로) → 그 뒤 ⓓ를
    ASGI 경유로 승인하는 순간 그 pending draft-scoped 게이트도 같이 approved로 전이."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="r4069b")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            connection_id = await _seed_sandbox_connection(s, org_id)

        # draft 제출 — ⓓ가 아직 pending이라 자동충족 조건(unscoped approved) 미달, 정상 pending.
        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "선제출 본문"},
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            assert r_submit.json()["status"] == "pending", "ⓓ 미승인 상태에서 잘못 자동충족됐다"
            scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

        # ⓓ 승인 — 훅B가 이 순간 위 pending 게이트를 같이 approved로 전이해야 한다.
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/gates/{gate_d_id}/transition",
                json={"status": "approved", "note": "ⓓ 발행 승인", "evidence_viewed": True},
            )
            assert r.status_code == 200, r.text
            gate_d_resolver_id = r.json()["resolver_id"]

        async with Session() as s:
            scoped_gate = (await s.execute(select(Gate).where(Gate.id == scoped_gate_id))).scalar_one()
            assert scoped_gate.status == "approved", "훅B가 draft 선제출 pending 게이트를 안 건드렸다"
            assert scoped_gate.requires_human is False
            assert "auto_satisfied_by_recipe_external_publish_gate" in (scoped_gate.resolution_note or "")
            assert str(scoped_gate.resolver_id) == gate_d_resolver_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_multi_destination_second_gate_not_auto_satisfied():
    """멀티목적지 회귀 0 — ⓓ 승인 뒤 draft A(connection 1) 제출은 자동충족되지만, 같은
    work_item에 draft B(connection 2, 다른 목적지)를 제출하면 "처음이자 유일한 목적지"
    조건이 깨져 B는 정상 pending으로 남는다(#3478 보호 유지) — A의 승인도 B가 건드리지
    않는다."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="r4069c")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            connection_a = await _seed_sandbox_connection(s, org_id, account_id="multi-a")
            connection_b = await _seed_sandbox_connection(s, org_id, account_id="multi-b")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/gates/{gate_d_id}/transition",
                json={"status": "approved", "note": "ⓓ 발행 승인", "evidence_viewed": True},
            )
            assert r.status_code == 200, r.text

        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft_a = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_a), "text": "A안"},
            )
            draft_a_id = r_draft_a.json()["draft_id"]
            r_submit_a = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_a_id}/submit", json={},
            )
            assert r_submit_a.status_code == 200, r_submit_a.text
            assert r_submit_a.json()["status"] == "approved", "첫 목적지(A)가 자동충족되지 않았다"
            gate_a_id = uuid.UUID(r_submit_a.json()["gate_id"])

            r_draft_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_b), "text": "B안"},
            )
            draft_b_id = r_draft_b.json()["draft_id"]
            r_submit_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_b_id}/submit", json={},
            )
            assert r_submit_b.status_code == 200, r_submit_b.text
            assert r_submit_b.json()["status"] == "pending", (
                "2번째 목적지(B)가 잘못 자동충족됐다 — 멀티목적지 보호(#3478)가 깨진 것"
            )

        async with Session() as s:
            gate_a = (await s.execute(select(Gate).where(Gate.id == gate_a_id))).scalar_one()
            assert gate_a.status == "approved", "B의 상신이 A(다른 목적지)의 자동충족 승인을 건드렸다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_recipe_story_unaffected_stays_pending():
    """비레시피 회귀 0 — 이 story엔 unscoped(scope_key="") external_publish 게이트 자체가
    존재한 적이 없다(레시피 stage 이벤트를 한 번도 발행 안 함) — 훅A의 조회가 None을
    받아 기존 그대로(pending) 동작해야 한다."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_member_id, _owner_user_id = await _seed_org_with_owner(s, slug="r4069d")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "비레시피 본문"},
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            assert r_submit.json()["status"] == "pending", "레시피 무관 story인데 자동충족이 발동했다"

        async with Session() as s:
            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalars().all()
            assert len(gates) == 1
            assert gates[0].resolution_note is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

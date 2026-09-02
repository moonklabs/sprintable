"""story #3332(68b43066) — block_template↔payload_schema 계약 정합 검증 + {{ref.X}} 참조
토큰 신설.

근본원인(소스 확認): `validate_block_template`(구조 게이트, story #2637)은 어휘 4종·필수
필드만 검사하고, `{{payload.X}}`가 참조하는 X가 `payload_schema.properties`에 실재하는지는
전혀 검사하지 않았다 — preset.gate.verdict의 대상 필드가 `{{payload.work_item_title}}`을
참조했지만(0251) 그 필드를 채우는 발행처가 없어 항상 `⟨missing: payload.work_item_title⟩`
로 렌더됐다(PR#3711 리뷰, 페드루 실측).

## 처방
1. `validate_block_template_refs(payload_schema, template)` 신설 — `{{payload.X}}`는
   payload_schema.properties ⊆, `{{ref.X}}`는 BLOCK_TEMPLATE_REF_VOCAB(닫힌 어휘, 지금은
   work_item 1종) 안이어야 한다. 위반 시 InvalidBlockTemplateError(등록 엔드포인트에서
   기존 규약대로 400 — 이 파일의 sibling test_2637_block_template_registration.py가
   이미 이 400 규약을 pin해 둠, 스토리 AC 문구의 "422"는 실제 코드 규약과 다름 —
   PR 본문에 명시 보고).
2. `events.py::_publish_registry_event_core`가 발행 시점에 work_item_type/work_item_id
   페어가 있으면 `_render_event_notification_work_item_ref`(기존 함수 재사용)로 참조 토큰을
   계산해 `event_context.refs.work_item`에 싣는다.
3. POST/PATCH /api/v2/events/definitions에 새 검증기 배선(등록 시점에 오타를 막는다).
4. migration 0301 — preset.gate.verdict의 "대상" 필드를 {{payload.work_item_title}}에서
   {{ref.work_item}}로 교체(생 텍스트가 아니라 클릭 토큰).

AC(스토리 acceptance_criteria 원문 기준):
- 반려 통지 카드의 "대상"이 클릭 토큰으로 실린다(라이브 검증은 이 PR 스코프 밖 — 배포 후
  가능. 이 테스트 파일은 발행 시점 refs 계산 + FE 치환 로직까지 각 레이어에서 검증).
- 존재하지 않는 payload 키를 참조하는 block_template PATCH → 400(양성대조, 이 레포 규약)·
  정상 템플릿은 통과(음성대조).
- 회귀 0(기존 프리셋 전부 검증 통과 — 이 파일의 풀 마이그레이션 감사 테스트가 pin).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ============================================================================
# 1부 — validate_block_template_refs 순수 단위 테스트(DB 불요, test_2637_block_template_
# validation.py와 동형 패턴).
# ============================================================================

_GATE_VERDICT_PAYLOAD_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
    },
}


def test_valid_payload_and_ref_references_pass():
    from app.services.event_definition_registry import validate_block_template_refs

    template = {
        "blocks": [
            {"type": "header", "text": "게이트 판정"},
            {"type": "text", "text": "**{{payload.gate_type}}** — **{{payload.verdict}}**"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{ref.work_item}}"},
                {"label": "사유", "value": "{{payload.resolution_note}}"},
            ]},
        ],
    }
    validate_block_template_refs(_GATE_VERDICT_PAYLOAD_SCHEMA, template)  # no raise


def test_unknown_payload_key_rejected():
    """⭐근본원인 직접 재현 — 0251이 실제로 저질렀던 실수(payload_schema에 없는
    work_item_title 참조)가 이제 등록 시점에 막힌다."""
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template_refs

    template = {
        "blocks": [
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_title}}"},
            ]},
        ],
    }
    with pytest.raises(InvalidBlockTemplateError) as ei:
        validate_block_template_refs(_GATE_VERDICT_PAYLOAD_SCHEMA, template)
    assert "work_item_title" in str(ei.value)


def test_unknown_ref_vocab_rejected():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template_refs

    template = {
        "blocks": [
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{ref.totally_unsupported_kind}}"},
            ]},
        ],
    }
    with pytest.raises(InvalidBlockTemplateError) as ei:
        validate_block_template_refs(_GATE_VERDICT_PAYLOAD_SCHEMA, template)
    assert "totally_unsupported_kind" in str(ei.value)


def test_actions_block_not_scanned():
    """actions[].label/definition_key는 정적 텍스트라 검증 대상이 아니다(FE
    block-template.ts의 치환 범위와 정확히 동형 — 안 그러면 FE가 안 보는 자리까지
    검증해 거짓양성을 낸다)."""
    from app.services.event_definition_registry import validate_block_template_refs

    template = {
        "blocks": [
            {"type": "actions", "actions": [
                {"label": "{{payload.nonexistent}}", "action": "publish", "definition_key": "x"},
            ]},
        ],
    }
    validate_block_template_refs(_GATE_VERDICT_PAYLOAD_SCHEMA, template)  # no raise


def test_no_mustache_at_all_passes():
    from app.services.event_definition_registry import validate_block_template_refs

    template = {"blocks": [{"type": "header", "text": "정적 문구"}]}
    validate_block_template_refs(_GATE_VERDICT_PAYLOAD_SCHEMA, template)  # no raise


# ============================================================================
# 2부 — POST/PATCH 엔드포인트 배선 확인(test_2637_block_template_registration.py와
# 동형 realdb 패턴 — 400 규약도 그대로 재사용).
# ============================================================================

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


async def _seed_org(session, *, slug="acme3332"):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name=f"Org-{slug}", slug=slug)
    session.add(org)
    await session.commit()
    return org.id


async def _seed_org_member(session, org_id, *, role="admin"):
    from app.models.project import OrgMember

    user_id = uuid.uuid4()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role))
    await session.commit()
    return user_id


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="admin@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


_SCHEMA_WITH_TITLE = {
    "type": "object", "additionalProperties": False,
    "properties": {"title": {"type": "string"}},
}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_register_rejects_block_template_referencing_unknown_payload_key():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            with pytest.raises(HTTPException) as ei:
                await create_event_definition(
                    CreateEventDefinitionRequest(
                        key="org.acme3332.widget.made", payload_schema=_SCHEMA_WITH_TITLE,
                        routing=_NONE_ROUTING,
                        block_template={"blocks": [{"type": "fields", "fields": [
                            {"label": "오타", "value": "{{payload.titel}}"},
                        ]}]},
                    ),
                    db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_register_accepts_valid_payload_reference():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            resp = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme3332.widget.made", payload_schema=_SCHEMA_WITH_TITLE,
                    routing=_NONE_ROUTING,
                    block_template={"blocks": [{"type": "fields", "fields": [
                        {"label": "제목", "value": "{{payload.title}}"},
                    ]}]},
                ),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert resp.block_template is not None
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_patch_rejects_when_new_payload_schema_orphans_existing_block_template():
    """PO 리뷰와 동형 규율(stage_metadata 케이스) — block_template은 안 건드리고
    payload_schema만 줄여도, 그 조합이 유효한지(effective 값 기준) 재검증한다."""
    from app.routers.events import (
        CreateEventDefinitionRequest, UpdateEventDefinitionRequest,
        create_event_definition, update_event_definition,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")
            auth = _human_auth(user_id, org_id)

            created = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme3332.widget.made", payload_schema=_SCHEMA_WITH_TITLE,
                    routing=_NONE_ROUTING,
                    block_template={"blocks": [{"type": "fields", "fields": [
                        {"label": "제목", "value": "{{payload.title}}"},
                    ]}]},
                ),
                db=s, auth=auth, org_id=org_id,
            )

            with pytest.raises(HTTPException) as ei:
                await update_event_definition(
                    created.id,
                    UpdateEventDefinitionRequest(
                        payload_schema={"type": "object", "additionalProperties": False, "properties": {}},
                    ),
                    db=s, auth=auth, org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


# ============================================================================
# 3부 — 발행 시점 refs 계산(realdb, work_item_stakeholders 라우팅 재사용 검증과 동형
# 패턴 — test_3330의 _publish 헬퍼 재사용).
# ============================================================================

async def _seed_org_with_owner(session, *, slug="e3332"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3332", slug=slug)
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


async def _seed_agent(session, org_id, project_id, *, name="executor"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, assignee_id, title="Threads 포스트 초안"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_system_publisher(session, org_id, project_id):
    """test_3330_gate_verdict_notification.py와 동형 우회 — Base.metadata.create_all
    스키마엔 team_members가(프로덕션의 members/project_access 위 VIEW와 달리) 독립
    테이블이라 미리 심어야 _get_or_create_system_publisher가 있는 걸 찾는다."""
    from app.models.member import Member
    from app.models.team import TeamMember

    publisher_id = uuid.uuid4()
    session.add(Member(
        id=publisher_id, org_id=org_id, type="agent", name="시스템 발행",
        runtime_type="system-publisher", is_active=True,
    ))
    session.add(TeamMember(
        id=publisher_id, org_id=org_id, project_id=project_id, type="agent",
        name="시스템 발행", runtime_type="system-publisher", is_active=True,
    ))
    await session.commit()
    return publisher_id


async def _seed_preset_gate_verdict_definition(session):
    from app.models.event_definition import EventDefinition
    from sqlalchemy import select

    existing = (await session.execute(
        select(EventDefinition).where(
            EventDefinition.key == "preset.gate.verdict", EventDefinition.org_id.is_(None),
        )
    )).scalar_one_or_none()
    if existing is not None:
        return
    session.add(EventDefinition(
        id=uuid.uuid4(), key="preset.gate.verdict", org_id=None,
        payload_schema=_GATE_VERDICT_PAYLOAD_SCHEMA,
        routing={
            "escalation": {"kind": "server_derived", "target": "none"},
            "broadcast": {
                "kind": "server_derived", "target": "work_item_stakeholders",
                "inherit_conversation_scope": True,
            },
        },
        enabled=True, version=1,
    ))
    await session.commit()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_publish_computes_work_item_ref_when_payload_has_work_item_pair():
    """refs 계산은 `publish_registry_event`(→`_publish_registry_event_core`)에 있다 —
    `transition_gate`를 거치지 않고 직접 발행해 이 계산 로직 자체만 검증한다(story #3330의
    "언제 발행하는가" 게이팅과는 독립된 축 — 이 worktree는 #3330 착지 前 origin/develop
    기준이라 transition_gate로 external_publish 타입을 거치면 그 미착지 게이팅에 걸려
    발행 자체가 스킵된다, 실측 확인)."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from fastapi import BackgroundTasks
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3332a")
            await _seed_preset_gate_verdict_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id)

            def _auth(agent_id, org_id):
                from app.dependencies.auth import AuthContext
                return AuthContext(
                    user_id=str(agent_id), email=None,
                    claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
                )

            resp = await publish_registry_event(
                EventPublishRequest(
                    definition_key="preset.gate.verdict",
                    payload={
                        "work_item_type": "story", "work_item_id": str(story_id),
                        "gate_type": "external_publish", "verdict": "approved",
                        "resolver_member_id": str(owner_id),
                    },
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=_auth(executor_id, org_id), org_id=org_id,
            )
            await s.commit()

            from app.models.conversation import ConversationMessage
            from sqlalchemy import select

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            refs = (msg.msg_metadata or {}).get("event", {}).get("refs") or {}
            assert refs.get("work_item") == f"[Threads 포스트 초안](entity:story:{story_id})"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_publish_refs_empty_when_payload_lacks_work_item_pair():
    """preset.goal.measured처럼 work_item_type/id가 없는 payload는 refs가 빈 dict —
    지어내지 않는다."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from fastapi import BackgroundTasks
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3332b")
            await _seed_system_publisher(s, org_id, project_id)

            from app.models.event_definition import EventDefinition

            s.add(EventDefinition(
                id=uuid.uuid4(), key="preset.goal.measured", org_id=None,
                payload_schema={
                    "type": "object", "additionalProperties": False,
                    "required": ["goal_id", "metric_value"],
                    "properties": {
                        "goal_id": {"type": "string", "format": "uuid"},
                        "metric_value": {"type": "number"},
                    },
                },
                routing={
                    "escalation": {"kind": "server_derived", "target": "none"},
                    "broadcast": {"kind": "server_derived", "target": "goal_owner", "inherit_conversation_scope": False},
                },
                enabled=True, version=1,
            ))
            await s.commit()

            from app.models.pm import Goal

            goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="측정 목표")
            s.add(goal)
            await s.commit()

            def _auth(agent_id, org_id):
                from app.dependencies.auth import AuthContext
                return AuthContext(
                    user_id=str(agent_id), email=None,
                    claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
                )

            resp = await publish_registry_event(
                EventPublishRequest(
                    definition_key="preset.goal.measured",
                    payload={"goal_id": str(goal.id), "metric_value": 3},
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=_auth(owner_id, org_id), org_id=org_id,
            )
            from app.models.conversation import ConversationMessage
            from sqlalchemy import select

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            assert (msg.msg_metadata or {}).get("event", {}).get("refs") == {}
    finally:
        await engine.dispose()


# ============================================================================
# 4부 — 풀 마이그레이션 감사(회귀 가드) — PO 리뷰 조건 "기존 프리셋 전부가 새 검증기를
# 통과하는지" 를 이후 마이그레이션에도 계속 지키게 한다. alembic upgrade head를 실제로
# 돌려 org_id IS NULL block_template 보유 정의 전부를 새 검증기에 통과시킨다.
# ============================================================================

def _to_asyncpg_url(url: str) -> str:
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


def _to_plain_postgres_url(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg2://", "postgresql://")


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_all_seeded_preset_block_templates_pass_new_validator():
    """실측(2026-09-02, 이 스토리 작업 중 직접 실행): 이 감사를 alembic upgrade head로
    실행하면 preset 4종 + preset.workflow.* 8종 + preset.steer.instruct 1종, 합계 13건
    전부 PASS(0301 포함). 향후 새 프리셋이 이 검증을 놓치면 여기서 잡힌다."""
    import asyncio
    import subprocess
    import sys

    db_name = f"backend_e3332_audit_{uuid.uuid4().hex[:8]}"
    base_url = _to_plain_postgres_url(_REAL_DB_URL).rsplit("/", 1)[0]
    admin_url = _to_asyncpg_url(base_url + "/postgres")

    import asyncpg

    admin_dsn = admin_url.replace("postgresql+asyncpg://", "postgresql://")
    admin_conn = await asyncpg.connect(admin_dsn)
    try:
        await admin_conn.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await admin_conn.close()

    audit_db_url = _to_plain_postgres_url(f"{base_url}/{db_name}")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=str(__import__("pathlib").Path(__file__).parent.parent),
            env={**__import__("os").environ, "ALEMBIC_DATABASE_URL": audit_db_url},
            capture_output=True, text=True,
        )
        assert result.returncode == 0, f"alembic upgrade head 실패:\n{result.stdout}\n{result.stderr}"

        from sqlalchemy.ext.asyncio import create_async_engine
        from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template_refs

        engine = create_async_engine(_to_asyncpg_url(audit_db_url))
        try:
            async with engine.connect() as conn:
                result_rows = await conn.exec_driver_sql(
                    "SELECT key, payload_schema, block_template FROM event_definitions "
                    "WHERE block_template IS NOT NULL AND org_id IS NULL ORDER BY key"
                )
                rows = result_rows.fetchall()
        finally:
            await engine.dispose()

        failures = []
        for key, payload_schema, block_template in rows:
            try:
                validate_block_template_refs(payload_schema, block_template)
            except InvalidBlockTemplateError as e:
                failures.append((key, str(e)))

        assert len(rows) >= 13, f"프리셋 정의 수가 예상(13건 이상)보다 적음 — 마이그레이션 실행 누락 의심: {len(rows)}"
        assert failures == [], f"기존 프리셋이 새 검증기를 통과 못 함(회귀): {failures}"
    finally:
        admin_conn = await asyncpg.connect(admin_dsn)
        try:
            await admin_conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
        finally:
            await admin_conn.close()

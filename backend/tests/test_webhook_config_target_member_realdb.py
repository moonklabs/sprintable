"""story 933248fa — webhook config PUT의 admin-scoped target override + IDOR sabotage 방어 realdb.

근본: 산티아고의 원 IDOR 방어(caller-only, body.member_id 완전 무시)가 admin의 정당한 타 멤버
설정 요구까지 침묵으로 caller 자신에 덮어썼다("200인데 미반영" + 실제 부작용=caller 자기 config
오염). fix = admin+same-org(서버 재해소)만 예외 허용, 비-admin은 기존 IDOR 방어 바이트 단위 유지+
거짓 200 제거(명시 403).

**IDOR sabotage 필수(PO 2026-07-15 지시)**: 비-admin이 body.member_id로 타 멤버를 노려도 ①차단되고
②caller 자신에게로도 침묵 저장되지 않는지(이번 버그의 실제 부작용 재발 방지) 둘 다 실DB로 증명한다.
realdb 필수 — team_members는 0088부터 members/agent_project_profiles 기반 projection VIEW라 mock으론
join 시맨틱을 재현 못 한다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("cf000000-0000-0000-0000-000000000001")
OTHER_ORG = uuid.UUID("cf000000-0000-0000-0000-0000000000f0")
PROJ = uuid.UUID("cf000000-0000-0000-0000-000000000002")
ADMIN_USER = uuid.UUID("cf000000-0000-0000-0000-0000000000a1")
ADMIN_OM = uuid.UUID("cf000000-0000-0000-0000-0000000000a2")
MEMBER_USER = uuid.UUID("cf000000-0000-0000-0000-0000000000b1")
MEMBER_OM = uuid.UUID("cf000000-0000-0000-0000-0000000000b2")
AGENT_TARGET = uuid.UUID("cf000000-0000-0000-0000-0000000000c1")
OTHER_ORG_AGENT = uuid.UUID("cf000000-0000-0000-0000-0000000000d1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _admin_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(ADMIN_USER), email=None,
        claims={"app_metadata": {"role": "admin", "org_id": str(ORG)}}, org_id=str(ORG),
    )


def _member_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(MEMBER_USER), email=None,
        claims={"app_metadata": {"role": "member", "org_id": str(ORG)}}, org_id=str(ORG),
    )


def _agent_auth(agent_id: uuid.UUID, org: uuid.UUID = ORG):
    # 에이전트 API 키: auth.user_id = members.id(=team_member.id), app_metadata.api_key_id 존재.
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"role": "member", "org_id": str(org), "api_key_id": "fake-key"}},
        org_id=str(org),
    )


async def _seed(s):
    for sql in [
        f"DELETE FROM webhook_configs WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{AGENT_TARGET}','{OTHER_ORG_AGENT}')",
        f"DELETE FROM members WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM users WHERE id IN ('{ADMIN_USER}','{MEMBER_USER}')",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{OTHER_ORG}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','CF','cforg','free')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{OTHER_ORG}','CF2','cforg2','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{ADMIN_USER}','admin@cf.test','x','Admin',true,true,0,false,0)",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{MEMBER_USER}','member@cf.test','x','Member',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{ADMIN_OM}','{ORG}','{ADMIN_USER}','admin')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{MEMBER_OM}','{ORG}','{MEMBER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT_TARGET}','{ORG}','agent','Agent',true)",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{AGENT_TARGET}','{PROJ}')",
        # cross-org 축: 같은 UUID 형식이지만 다른 org 소속 agent — target 검증이 body-claimed 아닌
        # caller org로 실제 재해소하는지 증명(SEC 규율①).
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{OTHER_ORG_AGENT}','{OTHER_ORG}','agent','Other',true)",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _webhook_row(s, org, member_id):
    return (await s.execute(text(
        f"SELECT url FROM webhook_configs WHERE org_id='{org}' AND member_id='{member_id}'"
    ))).scalar_one_or_none()


@pytest.mark.anyio
async def test_admin_can_configure_another_members_webhook():
    """admin이 body.member_id=AGENT_TARGET으로 PUT → AGENT_TARGET 행에 실제 반영(admin 자신 행 아님)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository
    from app.routers.webhooks import _get_caller_member_id, upsert_webhook_config
    from app.schemas.webhook_config import UpsertWebhookConfig

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            auth = _admin_auth()
            caller_member_id = await _get_caller_member_id(auth=auth, org_id=ORG, session=s)
            assert caller_member_id == ADMIN_OM  # 그라운딩: admin 캐스팅이 예상 축과 일치

            body = UpsertWebhookConfig(member_id=AGENT_TARGET, url="https://hooks.example.com/agent-target")
            result = await upsert_webhook_config(
                body=body, repo=WebhookConfigRepository(s, ORG),
                caller_member_id=caller_member_id, auth=auth, org_id=ORG, session=s,
            )
            await s.commit()
            assert result.member_id == AGENT_TARGET  # admin 자신(ADMIN_OM) 아닌 target에 반영

        async with Session() as s:
            assert await _webhook_row(s, ORG, AGENT_TARGET) == "https://hooks.example.com/agent-target"
            assert await _webhook_row(s, ORG, ADMIN_OM) is None  # admin 자신 행은 생성 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_admin_cross_member_blocked_no_silent_self_write():
    """비-admin이 body.member_id=AGENT_TARGET(타 멤버)로 PUT → 403, **AND** caller 자기 config도 미생성
    (이번 버그의 실제 부작용 — 침묵 caller-저장 — 이 재발 안 함을 직접 증명·IDOR sabotage)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository
    from app.routers.webhooks import _get_caller_member_id, upsert_webhook_config
    from app.schemas.webhook_config import UpsertWebhookConfig

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            auth = _member_auth()
            caller_member_id = await _get_caller_member_id(auth=auth, org_id=ORG, session=s)
            assert caller_member_id == MEMBER_OM

            body = UpsertWebhookConfig(member_id=AGENT_TARGET, url="https://hooks.example.com/sabotage-attempt")
            with pytest.raises(HTTPException) as exc:
                await upsert_webhook_config(
                    body=body, repo=WebhookConfigRepository(s, ORG),
                    caller_member_id=caller_member_id, auth=auth, org_id=ORG, session=s,
                )
            assert exc.value.status_code == 403
            await s.rollback()

        async with Session() as s:
            assert await _webhook_row(s, ORG, AGENT_TARGET) is None  # target 미반영(당연)
            assert await _webhook_row(s, ORG, MEMBER_OM) is None  # ⭐caller 자신도 침묵 저장 0(sabotage 방어)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_self_service_unaffected_agent_caller():
    """target==caller(자기서비스)는 role 무관 그대로 통과 — 무회귀 증명."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository
    from app.routers.webhooks import _get_caller_member_id, upsert_webhook_config
    from app.schemas.webhook_config import UpsertWebhookConfig

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            auth = _agent_auth(AGENT_TARGET)
            caller_member_id = await _get_caller_member_id(auth=auth, org_id=ORG, session=s)
            assert caller_member_id == AGENT_TARGET

            body = UpsertWebhookConfig(member_id=AGENT_TARGET, url="https://hooks.example.com/self")
            result = await upsert_webhook_config(
                body=body, repo=WebhookConfigRepository(s, ORG),
                caller_member_id=caller_member_id, auth=auth, org_id=ORG, session=s,
            )
            await s.commit()
            assert result.member_id == AGENT_TARGET

        async with Session() as s:
            assert await _webhook_row(s, ORG, AGENT_TARGET) == "https://hooks.example.com/self"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_target_404_not_body_claimed():
    """target이 caller org 밖(타 org agent)이면 404 — org 소속은 body가 아닌 caller의 검증된 org로 판정."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository
    from app.routers.webhooks import _get_caller_member_id, upsert_webhook_config
    from app.schemas.webhook_config import UpsertWebhookConfig

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            auth = _admin_auth()
            caller_member_id = await _get_caller_member_id(auth=auth, org_id=ORG, session=s)

            body = UpsertWebhookConfig(member_id=OTHER_ORG_AGENT, url="https://hooks.example.com/cross-org")
            with pytest.raises(HTTPException) as exc:
                await upsert_webhook_config(
                    body=body, repo=WebhookConfigRepository(s, ORG),
                    caller_member_id=caller_member_id, auth=auth, org_id=ORG, session=s,
                )
            assert exc.value.status_code == 404
            await s.rollback()

        async with Session() as s:
            assert await _webhook_row(s, OTHER_ORG, OTHER_ORG_AGENT) is None
            assert await _webhook_row(s, ORG, ADMIN_OM) is None  # admin 자신에게도 침묵 저장 0
    finally:
        await engine.dispose()

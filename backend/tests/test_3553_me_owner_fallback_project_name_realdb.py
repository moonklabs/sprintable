"""story #3553(BE·결함·소형, 페드루 PO 라이브 재현, 2026-09-06) — switch-org 뒤 owner인데
`/api/me`(BFF)·`get_me`(BE)가 role은 정확히 보여주면서 project_name만 null.

## 실측(PO Test Org db474a4e·772609ea po-verification-project, 2026-09-06 02:25Z)
- org_members(db474a4e, sellerking) = role 'owner'·deleted_at NULL
- projects(org db474a4e) = 1건 po-verification-project·deleted_at NULL
- team_members(org db474a4e·이 user) = 0행
- users.last_project_id = 772609ea(정확) — switch_organization의 first_accessible_project_id가
  이미 맞는 project로 해소해 굳혀 놓았다.

## 근본 원인
`get_me()`가 JWT `app_metadata.project_id`로 1차 TeamMember 조회를 하는데, owner라서
team_member 행이 아예 없으면(org 소유만으로 접근하는 형태) `member=None`이 되어
org_members 기반 폴백(158행~)으로 떨어진다. 이 폴백은 `project_id`는 project_id_str
그대로 채우지만(정확), 그 `return MeResponse(...)` 리터럴에 `project_name` 필드가 아예
없어 스키마 기본값(None)이 조용히 나간다 — 일반 경로(`member.project.name`)는 이 폴백을
안 타 무사했던 것뿐, project_name이 항상 null인 건 이 폴백 특유의 결함이었다.

## 처방
폴백에서 project_id_str이 실제 project를 가리킬 때만 Project를 1회 더 읽어 project_name을
채운다(0-project org 폴백은 project_id_str이 애초에 없어 조회 안 함 — None 그대로가 맞다).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("35530000-0000-0000-0000-0000000001a1")  # owner뿐·team_member 0행(PO Test Org 표본)
ORG_EMPTY = uuid.UUID("35530000-0000-0000-0000-0000000001b1")  # 0-project org(회귀 0 확인용)
USER = uuid.UUID("35530000-0000-0000-0000-000000001111")
OM = uuid.UUID("35530000-0000-0000-0000-0000000002a1")
OM_EMPTY = uuid.UUID("35530000-0000-0000-0000-0000000002b1")
PROJ = uuid.UUID("35530000-0000-0000-0000-000000003333")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM members WHERE org_id IN ('{ORG}','{ORG_EMPTY}')",
        f"DELETE FROM org_members WHERE org_id IN ('{ORG}','{ORG_EMPTY}')",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{ORG_EMPTY}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES "
        f"('{ORG}','S3553Org','s3553-org','free'),('{ORG_EMPTY}','S3553EmptyOrg','s3553-org-empty','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','u@s3553.test','x','U',true,true,0,false,0)",
        # ORG: owner인데 team_member 행 없음(PO Test Org 실측 그대로) — 프로젝트 1개.
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
        f"INSERT INTO members (id,org_id,type,user_id,name) VALUES "
        f"('{OM}','{ORG}','human','{USER}','U')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','PO Verification Project','s3553-proj','warn')",
        # ORG_EMPTY: owner인데 project 자체가 0개 — project_id claim이 ""로 온다(회귀 0 대조군).
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_EMPTY}','{ORG_EMPTY}','{USER}','owner')",
        f"INSERT INTO members (id,org_id,type,user_id,name) VALUES "
        f"('{OM_EMPTY}','{ORG_EMPTY}','human','{USER}','U')",
    ]:
        await s.execute(text(sql))
    await s.commit()


def _auth(org_id: uuid.UUID, project_id_str: str):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(USER), email="u@s3553.test",
        claims={"app_metadata": {"org_id": str(org_id), "project_id": project_id_str}},
        org_id=str(org_id),
    )


@pytest.mark.anyio
async def test_owner_without_team_member_gets_project_name_from_fallback():
    from app.routers.me import get_me

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            resp = await get_me(member_id=None, session=s, auth=_auth(ORG, str(PROJ)))

        assert resp.role == "owner"
        assert resp.project_id == PROJ
        assert resp.project_name == "PO Verification Project", (
            f"owner·team_member 0행 폴백이 project_id({resp.project_id})는 정확히 채우면서 "
            f"project_name={resp.project_name!r}로 비어 있으면 #3553 그대로 재발 — 폴백 응답에 "
            "project_name 필드가 없어 스키마 기본값(None)이 조용히 나가는 결함."
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_owner_zero_project_org_still_returns_none_project_name_no_regression():
    """0-project org(project_id claim="")는 project_id_str이 애초에 없어 Project 조회를
    안 한다 — project_name=None 그대로가 맞다(회귀 0 확인, #2873과 같은 축)."""
    from app.routers.me import get_me

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            resp = await get_me(member_id=None, session=s, auth=_auth(ORG_EMPTY, ""))

        assert resp.project_name is None
    finally:
        await eng.dispose()

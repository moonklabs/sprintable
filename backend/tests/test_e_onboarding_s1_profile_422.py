"""E-ONBOARDING S1: 프로필 저장 422 수정 — update_me가 auth에서 타겟 파생 + ownership.

데모 headline 버그: PATCH /me {name} (member_id 쿼리 없이) → 200. 남의 member_id → 차단.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.dependencies.auth import AuthContext
from app.routers.me import update_me
from app.schemas.me import UpdateMe


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_tm(user_id: uuid.UUID, name: str = "Old Name") -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.org_id = uuid.uuid4()
    m.project_id = uuid.uuid4()
    m.user_id = user_id
    m.name = name
    m.email = "u@example.com"  # MeResponse.email (S2 머지 후 존재)
    m.type = "human"
    m.role = "member"
    m.is_active = True
    m.project_name = None
    m.project = None
    m.has_password = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return m


def _tm_result(member):
    r = MagicMock()
    r.scalars.return_value.first.return_value = member
    return r


def _auth(uid: uuid.UUID, *, org_id=None, project_id=None):
    meta = {}
    if org_id:
        meta["org_id"] = str(org_id)
    if project_id:
        meta["project_id"] = str(project_id)
    return AuthContext(user_id=str(uid), email="u@example.com", claims={"app_metadata": meta}, org_id=str(org_id) if org_id else None)


@pytest.mark.anyio
async def test_patch_me_without_member_id_query_returns_200():
    """member_id 쿼리 없이 PATCH /me {name} → auth.user_id로 파생 → 성공(422 아님)."""
    uid = uuid.uuid4()
    member = _mock_tm(uid)
    session = AsyncMock()
    session.expire = MagicMock()  # 실제 Session.expire는 동기 (AsyncMock 경고 방지)
    # [select TM, UPDATE members, select TM refreshed]
    session.execute = AsyncMock(side_effect=[_tm_result(member), MagicMock(), _tm_result(member)])

    res = await update_me(
        body=UpdateMe(name="New Name"),
        member_id=None,
        session=session,
        auth=_auth(uid),
    )
    assert res.user_id == uid
    # UPDATE members.name이 새 이름으로 호출됐는지 (2번째 execute = sa_update)
    update_call = session.execute.await_args_list[1]
    compiled = str(update_call.args[0])
    assert "UPDATE members" in compiled


@pytest.mark.anyio
async def test_patch_me_other_member_id_is_blocked():
    """남의 member_id를 줘도 본인 소유가 아니면 매칭 0 → 404 (ownership 강제)."""
    uid = uuid.uuid4()
    other_member_id = uuid.uuid4()
    session = AsyncMock()
    # where_clause에 user_id==uid가 AND되므로 남의 행은 안 잡힘 → first()=None
    session.execute = AsyncMock(side_effect=[_tm_result(None)])

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        await update_me(
            body=UpdateMe(name="Hacked"),
            member_id=other_member_id,
            session=session,
            auth=_auth(uid),
        )
    assert exc.value.status_code == 404
    # UPDATE까지 가지 않음 (select 1회만)
    assert session.execute.await_count == 1

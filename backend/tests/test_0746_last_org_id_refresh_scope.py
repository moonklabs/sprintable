"""0746 후속: refresh 0-project org leak fix — _build_app_metadata가 org_id 미지정 시
user.last_org_id로 스코프 (refresh는 org 컨텍스트가 없어 cross-org 재주입하던 구멍 차단).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_B = uuid.uuid4()   # 현재 org (0-project)
UID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _user(last_org_id, last_project_id=None):
    u = MagicMock()
    u.id = UID
    u.email = "x@example.com"
    u.last_project_id = last_project_id
    u.last_org_id = last_org_id
    return u


@pytest.mark.anyio
async def test_refresh_scopes_to_last_org_id_no_crossorg():
    """org_id 미지정(refresh) + last_org_id=0-project org + stale cross-org last_project_id →
    last_org_id로 스코프 → project_id='' (옛 org 프로젝트 재주입 0)."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_org_id=ORG_B, last_project_id=uuid.uuid4())  # stale cross-org project
    q1 = MagicMock(); q1.scalar_one_or_none.return_value = None  # branch1(ORG_B 스코프) no match
    q2 = MagicMock(); q2.scalar_one_or_none.return_value = None  # fallback(ORG_B 스코프) no match
    om = MagicMock(); om.scalar_one_or_none.return_value = "member"
    session = AsyncMock(); session.execute = AsyncMock(side_effect=[q1, q2, om])

    with patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=None)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session)  # org_id 생략 → last_org_id 사용

    assert md["org_id"] == str(ORG_B)
    assert md["project_id"] == ""          # cross-org 옛 프로젝트 주입 0
    assert user.last_org_id == ORG_B       # 현재 org 유지(다음 refresh도 동일)


@pytest.mark.anyio
async def test_explicit_org_id_takes_precedence_over_last_org_id():
    """switch가 넘긴 org_id가 last_org_id보다 우선(전환 즉시 반영)."""
    from app.routers.auth import _build_app_metadata

    ORG_C = uuid.uuid4()
    user = _user(last_org_id=ORG_B)  # 이전 org
    q2 = MagicMock(); q2.scalar_one_or_none.return_value = None  # fallback(ORG_C) no match
    om = MagicMock(); om.scalar_one_or_none.return_value = "admin"
    session = AsyncMock(); session.execute = AsyncMock(side_effect=[q2, om])

    with patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=None)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_C)  # 명시 org_id

    assert md["org_id"] == str(ORG_C)      # last_org_id(ORG_B) 아닌 명시 ORG_C
    assert user.last_org_id == ORG_C       # 명시 org로 갱신

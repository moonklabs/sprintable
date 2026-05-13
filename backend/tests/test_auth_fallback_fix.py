"""AUTH fallback fix: _build_app_metadata ASC 복원 + login last_project_id 자동 설정."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_user(last_project_id=None) -> MagicMock:
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "user@example.com"
    u.is_active = True
    u.last_project_id = last_project_id
    return u


def _make_member(project_id=None, org_id=None, days_ago=0) -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.user_id = uuid.uuid4()
    m.project_id = project_id or uuid.uuid4()
    m.org_id = org_id or uuid.uuid4()
    m.role = "member"
    m.is_active = True
    m.created_at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    m.type = "human"
    return m


# ─── AC1: fallback ASC 복원 ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_fallback_uses_oldest_member_when_no_last_project():
    """last_project_id 없으면 created_at ASC (가장 오래된) member 선택."""
    from app.routers.auth import _build_app_metadata

    sprintable_member = _make_member(days_ago=40)   # 가장 오래된 — 선택돼야 함
    jangsawang_member = _make_member(days_ago=10)   # 최신 — 선택되면 안 됨

    user = _make_user(last_project_id=None)

    session = AsyncMock()

    # fallback ASC → sprintable_member 반환
    fallback_result = MagicMock()
    fallback_result.scalar_one_or_none.return_value = sprintable_member
    # all_members
    all_scalars = MagicMock()
    all_scalars.all.return_value = [sprintable_member, jangsawang_member]
    all_result = MagicMock()
    all_result.scalars.return_value = all_scalars

    session.execute.side_effect = [fallback_result, all_result]

    result = await _build_app_metadata(user, session)

    assert result["project_id"] == str(sprintable_member.project_id)


# ─── AC2: login 시 last_project_id 자동 갱신 ─────────────────────────────────

@pytest.mark.anyio
async def test_login_auto_sets_last_project_id_when_null():
    """last_project_id=None인 사용자 로그인 → 선택된 project_id로 자동 설정."""
    from app.routers.auth import _build_app_metadata

    oldest_member = _make_member(days_ago=40)
    user = _make_user(last_project_id=None)

    session = AsyncMock()
    fallback_result = MagicMock()
    fallback_result.scalar_one_or_none.return_value = oldest_member
    all_scalars = MagicMock()
    all_scalars.all.return_value = [oldest_member]
    all_result = MagicMock()
    all_result.scalars.return_value = all_scalars
    session.execute.side_effect = [fallback_result, all_result]

    await _build_app_metadata(user, session)

    # user.last_project_id가 선택된 project_id로 설정됐는지
    assert user.last_project_id == oldest_member.project_id


# ─── AC3: last_project_id 있는 사용자는 해당 project 유지 ────────────────────

@pytest.mark.anyio
async def test_existing_last_project_id_preserved():
    """last_project_id 있으면 해당 project member 사용 + last_project_id 갱신 안 됨."""
    from app.routers.auth import _build_app_metadata

    preferred_project = uuid.uuid4()
    preferred_member = _make_member(project_id=preferred_project, days_ago=5)
    user = _make_user(last_project_id=preferred_project)

    session = AsyncMock()
    # last_project_id 기반 조회 → preferred_member
    last_project_result = MagicMock()
    last_project_result.scalar_one_or_none.return_value = preferred_member
    # all_members
    all_scalars = MagicMock()
    all_scalars.all.return_value = [preferred_member]
    all_result = MagicMock()
    all_result.scalars.return_value = all_scalars
    session.execute.side_effect = [last_project_result, all_result]

    result = await _build_app_metadata(user, session)

    assert result["project_id"] == str(preferred_project)
    # last_project_id가 이미 동일하므로 변경 없음
    assert user.last_project_id == preferred_project


@pytest.mark.anyio
async def test_login_updates_last_project_id_if_changed():
    """last_project_id가 선택된 member의 project와 다르면 갱신됨."""
    from app.routers.auth import _build_app_metadata

    old_project = uuid.uuid4()
    new_member = _make_member(days_ago=40)  # last_project 삭제됐으면 fallback으로 이쪽 선택
    user = _make_user(last_project_id=old_project)

    session = AsyncMock()
    # last_project_id 조회 → None (해당 project에서 제거됐거나 비활성)
    last_project_result = MagicMock()
    last_project_result.scalar_one_or_none.return_value = None
    # fallback ASC → new_member
    fallback_result = MagicMock()
    fallback_result.scalar_one_or_none.return_value = new_member
    # all_members
    all_scalars = MagicMock()
    all_scalars.all.return_value = [new_member]
    all_result = MagicMock()
    all_result.scalars.return_value = all_scalars
    session.execute.side_effect = [last_project_result, fallback_result, all_result]

    result = await _build_app_metadata(user, session)

    assert result["project_id"] == str(new_member.project_id)
    # last_project_id가 새 project_id로 갱신됐는지
    assert user.last_project_id == new_member.project_id

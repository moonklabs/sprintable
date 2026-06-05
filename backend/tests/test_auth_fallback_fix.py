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
    u.last_org_id = None  # 0746 후속: 신규 필드 — None이어야 org_id-None(cross-org fallback) 경로 유지
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


def _org_roles_empty() -> MagicMock:
    """S-MBR-03: org_roles 쿼리 mock — 결과 없음 (role 상속 없음)."""
    r = MagicMock()
    r.all.return_value = []
    return r


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

    session.execute.side_effect = [fallback_result, _org_roles_empty(), all_result]

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
    session.execute.side_effect = [fallback_result, _org_roles_empty(), all_result]

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
    session.execute.side_effect = [last_project_result, _org_roles_empty(), all_result]

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
    session.execute.side_effect = [last_project_result, fallback_result, _org_roles_empty(), all_result]

    result = await _build_app_metadata(user, session)

    assert result["project_id"] == str(new_member.project_id)
    # last_project_id가 새 project_id로 갱신됐는지
    assert user.last_project_id == new_member.project_id


# ─── AC2-2b: Path4 team_member auto-INSERT 제거 (드리프트 차단, story 3dfcada4) ──

def test_path4_no_team_member_auto_insert_in_source():
    """_build_app_metadata에 team_members auto-INSERT 코드 부재 — org-member 휴먼
    로그인마다 곱연산 team_member 재생산하던 드리프트 소스 제거 확인."""
    import inspect
    from app.routers import auth as auth_mod

    src = inspect.getsource(auth_mod._build_app_metadata)
    assert "INSERT INTO team_members" not in src


@pytest.mark.anyio
async def test_path4_org_member_only_no_insert_uses_first_accessible(monkeypatch):
    """org-member-only 휴먼(team_member 없음) → auto-INSERT 안 하고
    first_accessible_project_id 기반 project_id 반환."""
    from app.routers import auth as auth_mod
    from app.routers.auth import _build_app_metadata

    user = _make_user(last_project_id=None)
    org_id = uuid.uuid4()
    proj_id = uuid.uuid4()
    org_member = MagicMock()
    org_member.org_id = org_id
    org_member.role = "member"

    none_res = MagicMock()
    none_res.scalar_one_or_none.return_value = None
    om_res = MagicMock()
    om_res.scalar_one_or_none.return_value = org_member

    session = AsyncMock()
    # fallback team_member(None) → Invitation(None) → OrgInvite(None) → org_member(found)
    session.execute.side_effect = [none_res, none_res, none_res, om_res]

    monkeypatch.setattr(auth_mod, "first_accessible_project_id", AsyncMock(return_value=proj_id))

    result = await _build_app_metadata(user, session)

    assert result == {"org_id": str(org_id), "project_id": str(proj_id), "role": "member"}
    # team_member INSERT 시도 없음
    for call in session.execute.call_args_list:
        stmt = str(call.args[0]) if call.args else ""
        assert "INSERT INTO team_members" not in stmt


@pytest.mark.anyio
async def test_path4_grant_less_member_no_accessible_project_empty():
    """B4 회귀: org에 project 있어도 grant-less 일반 member(team_member·grant·owner/admin 전무)는
    접근 가능 project 없음 → project_id="". first_accessible를 patch하지 않고 실 동작(3쿼리 전부 None)
    으로 검증 — 접근 불가 project를 착지로 반환하던 회귀 차단."""
    from app.routers.auth import _build_app_metadata

    user = _make_user(last_project_id=None)
    org_id = uuid.uuid4()
    org_member = MagicMock()
    org_member.org_id = org_id
    org_member.role = "member"  # 일반 member — owner/admin 아님

    none_res = MagicMock()
    none_res.scalar_one_or_none.return_value = None
    om_res = MagicMock()
    om_res.scalar_one_or_none.return_value = org_member

    session = AsyncMock()
    # Path4: fallback_tm(None)·invitation(None)·orginvite(None)·org_member(found)
    # + first_accessible: tm(None)·grant(None)·owner/admin-org-project(None — member라 EXISTS 실패)
    session.execute.side_effect = [none_res, none_res, none_res, om_res, none_res, none_res, none_res]

    result = await _build_app_metadata(user, session)
    assert result == {"org_id": str(org_id), "project_id": "", "role": "member"}


# ─── B4: first_accessible_project_id 3번째 fallback owner/admin 전용 ───────────

@pytest.mark.anyio
async def test_first_accessible_grant_less_member_returns_none():
    """grant-less 일반 member: team_member·grant 없고 owner/admin 아니면 None (접근 불가 project 반환 금지)."""
    from app.services.project_auth import first_accessible_project_id

    none_res = MagicMock()
    none_res.scalar_one_or_none.return_value = None
    session = AsyncMock()
    session.execute.side_effect = [none_res, none_res, none_res]  # tm·grant·owner/admin-project 전부 None

    result = await first_accessible_project_id(session, uuid.uuid4(), uuid.uuid4())
    assert result is None


@pytest.mark.anyio
async def test_first_accessible_owner_admin_returns_org_first_project():
    """owner/admin: team_member·grant 없어도 org 첫 project 반환(org-wide 접근권)."""
    from app.services.project_auth import first_accessible_project_id

    proj = uuid.uuid4()
    none_res = MagicMock()
    none_res.scalar_one_or_none.return_value = None
    proj_res = MagicMock()
    proj_res.scalar_one_or_none.return_value = proj  # owner/admin EXISTS 통과 → org 첫 project
    session = AsyncMock()
    session.execute.side_effect = [none_res, none_res, proj_res]

    result = await first_accessible_project_id(session, uuid.uuid4(), uuid.uuid4())
    assert result == proj

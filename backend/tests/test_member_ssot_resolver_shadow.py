"""E-MEMBER-SSOT AC2-3: anchor resolver shadow (members+aliases) 단위 테스트.

플래그 on(per-test monkeypatch)으로 anchor 경로 검증. 기본 off는 레거시(다른 테스트가 커버).
parity(legacy vs anchor 0-diff)는 실 PG 하네스로 별도 검증.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id, is_api_key=False):
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.claims = {"app_metadata": ({"api_key_id": "ak"} if is_api_key else {})}
    return ctx


def _result(scalar=None, first=None, all_=None, rows=None):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar
    r.scalars.return_value.first.return_value = first
    r.scalars.return_value.all.return_value = all_ if all_ is not None else []
    r.all.return_value = rows if rows is not None else []  # 2+컬럼 select(.all()) 용
    return r


# ── resolve_member anchor (flag on) ───────────────────────────────────────────

@pytest.mark.anyio
async def test_anchor_resolve_member_agent(monkeypatch):
    """API키 에이전트 → members(type=agent) + project_access.role + agent_project_profiles.project_id."""
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    agent_id = uuid.uuid4()
    org_id = uuid.uuid4()
    proj_id = uuid.uuid4()
    member = MagicMock()
    member.id = agent_id
    member.name = "Agent Bot"
    member.type = "agent"
    member.org_id = org_id

    session = AsyncMock()
    # Member(agent) → ProjectAccess.role → AgentProjectProfile.project_id
    session.execute = AsyncMock(side_effect=[_result(first=member), _result(scalar="member"), _result(scalar=proj_id)])

    resolved = await mr.resolve_member(_auth(agent_id, is_api_key=True), org_id, session)
    assert resolved.id == agent_id
    assert resolved.type == "agent"
    assert resolved.role == "member"
    assert resolved.project_id == proj_id
    assert resolved.user_id is None


@pytest.mark.anyio
async def test_anchor_resolve_member_human(monkeypatch):
    """JWT 휴먼 → members(type=human, org_role) + name=users.email (레거시 정합)."""
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    user_id = uuid.uuid4()
    org_id = uuid.uuid4()
    member = MagicMock()
    member.id = uuid.uuid4()
    member.user_id = user_id
    member.org_id = org_id
    member.org_role = "admin"
    user = MagicMock()
    user.email = "human@test.com"

    session = AsyncMock()
    # Member(human) → User(email)
    session.execute = AsyncMock(side_effect=[_result(scalar=member), _result(scalar=user)])

    resolved = await mr.resolve_member(_auth(user_id), org_id, session, project_id=None)
    assert resolved.type == "human"
    assert resolved.user_id == user_id
    assert resolved.role == "admin"   # org_role
    assert resolved.name == "human@test.com"


@pytest.mark.anyio
async def test_anchor_resolve_member_human_not_found_400(monkeypatch):
    import app.services.member_resolver as mr
    from fastapi import HTTPException

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result(scalar=None)])  # member 없음
    with pytest.raises(HTTPException) as exc:
        await mr.resolve_member(_auth(uuid.uuid4()), uuid.uuid4(), session, project_id=None)
    assert exc.value.status_code == 400


# ── lookup_members_by_ids anchor (flag on) ────────────────────────────────────

@pytest.mark.anyio
async def test_anchor_lookup_direct_member(monkeypatch):
    """id가 곧 member.id면 직접 해소 (휴먼)."""
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    mid = uuid.uuid4()
    m = MagicMock()
    m.id = mid; m.user_id = uuid.uuid4(); m.name = "H"; m.type = "human"; m.org_role = "member"; m.org_id = uuid.uuid4()

    session = AsyncMock()
    # Member.in_(ids) → [m]
    session.execute = AsyncMock(side_effect=[_result(all_=[m])])

    out = await mr.lookup_members_by_ids({mid}, session)
    assert out[mid].id == mid
    assert out[mid].type == "human"
    assert out[mid].role == "member"


@pytest.mark.anyio
async def test_anchor_lookup_alias_canonicalizes(monkeypatch):
    """레거시 team_member.id는 alias로 canonical member(org_member.id)로 해소 (908075db de-fallback)."""
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    legacy_tm_id = uuid.uuid4()
    canonical_id = uuid.uuid4()
    canon = MagicMock()
    canon.id = canonical_id; canon.user_id = uuid.uuid4(); canon.name = "H"; canon.type = "human"; canon.org_role = "member"; canon.org_id = uuid.uuid4()

    session = AsyncMock()
    # 1) Member.in_ → [] (직접 매칭 없음)  2) alias rows → [(legacy_tm_id, canonical_id)]  3) Member.in_(target) → [canon]
    session.execute = AsyncMock(side_effect=[
        _result(all_=[]),                              # Member.in_ → 직접 매칭 없음
        _result(rows=[(legacy_tm_id, canonical_id)]),  # alias rows (.all())
        _result(all_=[canon]),                         # Member.in_(target) → canonical
    ])

    out = await mr.lookup_members_by_ids({legacy_tm_id}, session)
    # key는 원본 id, .id는 canonical
    assert legacy_tm_id in out
    assert out[legacy_tm_id].id == canonical_id


@pytest.mark.anyio
async def test_anchor_lookup_true_orphan_telemetry(monkeypatch):
    """member·alias 모두 없으면 telemetry-only + 크래시 방지 placeholder (가짜 resolve 아님)."""
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    orphan = uuid.uuid4()
    session = AsyncMock()
    # Member.in_ → []  / alias → []
    session.execute = AsyncMock(side_effect=[_result(all_=[]), _result(all_=[])])

    with patch.object(mr.logger, "warning") as mock_warn:
        out = await mr.lookup_members_by_ids({orphan}, session)
    assert orphan in out  # placeholder
    assert mock_warn.called  # telemetry 로그

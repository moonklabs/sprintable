"""E-MEMBER-SSOT Phase 0: resolve_member + 인가 불변식 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.member_resolver import ResolvedMember, lookup_members_by_ids, resolve_member

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_TM_ID = uuid.uuid4()
ORG_MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_auth(user_id: uuid.UUID = USER_ID, is_api_key: bool = False) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    if is_api_key:
        ctx.claims = {"app_metadata": {"api_key_id": "ak_xxx", "org_id": str(ORG_ID)}}
    else:
        ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    return ctx


def _make_team_member(tid=AGENT_TM_ID, ttype="agent", org_id=ORG_ID):
    tm = MagicMock()
    tm.id = tid
    tm.user_id = None
    tm.name = "TestAgent"
    tm.type = ttype
    tm.role = "agent"
    tm.org_id = org_id
    tm.project_id = PROJECT_ID
    return tm


def _make_org_member(oid=ORG_MEMBER_ID, user_id=USER_ID, org_id=ORG_ID):
    om = MagicMock()
    om.id = oid
    om.user_id = user_id
    om.org_id = org_id
    om.role = "member"
    om.deleted_at = None
    return om


# ── API키 에이전트 경로 ───────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_member_api_key_returns_team_member_id():
    """API키 인증 → team_member.id 반환."""
    auth = _make_auth(is_api_key=True)
    tm = _make_team_member()

    session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.first.return_value = tm
    session.execute = AsyncMock(return_value=result)

    resolved = await resolve_member(auth, ORG_ID, session)
    assert resolved.id == AGENT_TM_ID
    assert resolved.type == "agent"
    assert resolved.user_id is None


@pytest.mark.anyio
async def test_resolve_member_api_key_not_found_raises_400():
    """API키이지만 team_member 없음 → 400."""
    auth = _make_auth(is_api_key=True)

    session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.first.return_value = None
    session.execute = AsyncMock(return_value=result)

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        await resolve_member(auth, ORG_ID, session)
    assert exc_info.value.status_code == 400


# ── JWT 휴먼 경로 ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_member_jwt_returns_org_member_id():
    """JWT 인증 → org_member.id 반환."""
    auth = _make_auth()
    om = _make_org_member()

    session = AsyncMock()
    user_mock = MagicMock()
    user_mock.email = "user@test.com"
    om_result = MagicMock(); om_result.scalar_one_or_none.return_value = om
    user_result = MagicMock(); user_result.scalar_one_or_none.return_value = user_mock

    with patch("app.services.member_resolver.has_project_access", return_value=True):
        session.execute = AsyncMock(side_effect=[om_result, user_result])
        resolved = await resolve_member(auth, ORG_ID, session, project_id=PROJECT_ID)

    assert resolved.id == ORG_MEMBER_ID
    assert resolved.type == "human"
    assert resolved.user_id == USER_ID
    assert resolved.name == "user@test.com"


@pytest.mark.anyio
async def test_resolve_member_jwt_no_project_access_403():
    """JWT 유저가 project에 접근권 없음 → 403."""
    auth = _make_auth()

    session = AsyncMock()
    from fastapi import HTTPException
    with patch("app.services.member_resolver.has_project_access", return_value=False):
        with pytest.raises(HTTPException) as exc_info:
            await resolve_member(auth, ORG_ID, session, project_id=PROJECT_ID)
    assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_resolve_member_jwt_no_org_member_400():
    """JWT 유저가 org_member에 없음 → 400."""
    auth = _make_auth()

    session = AsyncMock()
    om_result = MagicMock(); om_result.scalar_one_or_none.return_value = None

    from fastapi import HTTPException
    with patch("app.services.member_resolver.has_project_access", return_value=True):
        session.execute = AsyncMock(return_value=om_result)
        with pytest.raises(HTTPException) as exc_info:
            await resolve_member(auth, ORG_ID, session, project_id=PROJECT_ID)
    assert exc_info.value.status_code == 400


# ── lookup_members_by_ids ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_lookup_members_team_member_first():
    """TeamMember 조회 우선 — org_member 조회 없음."""
    tm = _make_team_member()
    session = AsyncMock()
    tm_result = MagicMock(); tm_result.scalars.return_value.all.return_value = [tm]
    session.execute = AsyncMock(return_value=tm_result)

    result = await lookup_members_by_ids({AGENT_TM_ID}, session)
    assert AGENT_TM_ID in result
    assert result[AGENT_TM_ID].type == "agent"
    assert session.execute.call_count == 1  # TM만 조회


@pytest.mark.anyio
async def test_lookup_members_falls_back_to_org_member():
    """TeamMember에 없으면 OrgMember에서 fallback."""
    om = _make_org_member()
    session = AsyncMock()
    empty_tm = MagicMock(); empty_tm.scalars.return_value.all.return_value = []
    om_result = MagicMock(); om_result.scalars.return_value.all.return_value = [om]
    user_result = MagicMock(); user_result.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(side_effect=[empty_tm, om_result, user_result])

    result = await lookup_members_by_ids({ORG_MEMBER_ID}, session)
    assert ORG_MEMBER_ID in result
    assert result[ORG_MEMBER_ID].type == "human"


# ── _enforce_agent_creator_policy 유닛 테스트 ────────────────────────────────

@pytest.mark.anyio
async def test_policy_skip_no_agents():
    """에이전트 없음 → 정책 skip."""
    from app.routers.conversations import _enforce_agent_creator_policy
    session = AsyncMock()
    no_agents = MagicMock(); no_agents.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(return_value=no_agents)
    sender = ResolvedMember(id=ORG_MEMBER_ID, user_id=USER_ID, name="u", type="human", role="member", org_id=ORG_ID)
    await _enforce_agent_creator_policy(sender, [uuid.uuid4()], session)  # 예외 없음


@pytest.mark.anyio
async def test_policy_skip_agents_only():
    """에이전트↔에이전트 (휴먼 없음) → creator 무관 허용."""
    from app.routers.conversations import _enforce_agent_creator_policy
    agent1_id, agent2_id = uuid.uuid4(), uuid.uuid4()
    sender_agent = MagicMock()
    sender_agent.id = agent1_id
    sender_agent.type = "agent"
    sender_agent.user_id = None

    agent2_tm = MagicMock()
    agent2_tm.id = agent2_id
    agent2_tm.type = "agent"
    agent2_tm.created_by = None  # creator 없어도 OK

    session = AsyncMock()
    agents_result = MagicMock(); agents_result.scalars.return_value.all.return_value = [sender_agent, agent2_tm]
    session.execute = AsyncMock(return_value=agents_result)

    await _enforce_agent_creator_policy(sender_agent, [agent2_id], session)  # 403 없음


@pytest.mark.anyio
async def test_policy_creator_in_participants_group():
    """그룹: 비-creator 휴먼이 [에이전트+creator+자기] 열기 → 허용(creator가 참가자에 있음)."""
    from app.routers.conversations import _enforce_agent_creator_policy
    agent_id = uuid.uuid4()
    creator_user_id = uuid.uuid4()
    creator_member_id = uuid.uuid4()
    requestor_member_id = ORG_MEMBER_ID  # 다른 유저

    sender = ResolvedMember(
        id=requestor_member_id, user_id=USER_ID, name="u", type="human", role="member", org_id=ORG_ID
    )

    agent_tm = MagicMock(); agent_tm.id = agent_id; agent_tm.type = "agent"; agent_tm.created_by = creator_user_id

    session = AsyncMock()
    # 1st execute: agent 조회 (all_ids에서)
    agents_result = MagicMock(); agents_result.scalars.return_value.all.return_value = [agent_tm]
    # 2nd execute: remaining TM 조회 → creator_member_id가 TM
    creator_tm = MagicMock(); creator_tm.id = creator_member_id; creator_tm.user_id = creator_user_id
    tms_result = MagicMock(); tms_result.scalars.return_value.all.return_value = [creator_tm]
    session.execute = AsyncMock(side_effect=[agents_result, tms_result])

    # creator_member_id가 participant_ids에 있음
    await _enforce_agent_creator_policy(sender, [agent_id, creator_member_id], session)  # 예외 없음


@pytest.mark.anyio
async def test_policy_creator_not_in_participants_403():
    """그룹: 에이전트 creator가 참가자에 없음 → 403."""
    from app.routers.conversations import _enforce_agent_creator_policy
    from fastapi import HTTPException
    agent_id = uuid.uuid4()
    creator_user_id = uuid.uuid4()

    sender = ResolvedMember(
        id=ORG_MEMBER_ID, user_id=USER_ID, name="u", type="human", role="member", org_id=ORG_ID
    )

    agent_tm = MagicMock(); agent_tm.id = agent_id; agent_tm.type = "agent"; agent_tm.created_by = creator_user_id

    session = AsyncMock()
    agents_result = MagicMock(); agents_result.scalars.return_value.all.return_value = [agent_tm]
    # remaining TM 없음
    empty_tms = MagicMock(); empty_tms.scalars.return_value.all.return_value = []
    empty_oms = MagicMock(); empty_oms.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(side_effect=[agents_result, empty_tms, empty_oms])

    with pytest.raises(HTTPException) as exc_info:
        await _enforce_agent_creator_policy(sender, [agent_id], session)
    assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_policy_no_creator_in_human_conversation_403():
    """creator 없는 에이전트 + 휴먼 대화 → 403."""
    from app.routers.conversations import _enforce_agent_creator_policy
    from fastapi import HTTPException
    agent_id = uuid.uuid4()

    sender = ResolvedMember(
        id=ORG_MEMBER_ID, user_id=USER_ID, name="u", type="human", role="member", org_id=ORG_ID
    )

    agent_tm = MagicMock(); agent_tm.id = agent_id; agent_tm.type = "agent"; agent_tm.created_by = None

    session = AsyncMock()
    agents_result = MagicMock(); agents_result.scalars.return_value.all.return_value = [agent_tm]
    session.execute = AsyncMock(return_value=agents_result)

    with pytest.raises(HTTPException) as exc_info:
        await _enforce_agent_creator_policy(sender, [agent_id], session)
    assert exc_info.value.status_code == 403


# ── QA B1 보강: resolve_member_identity 2단 조회 + org 필터 독립 검증 ──────────

@pytest.mark.anyio
async def test_resolve_member_identity_prefers_team_member():
    """TM 존재 시 OrgMember 조회 없이 TM 반환 (TM 우선, 단 1회 execute)."""
    from app.services.member_resolver import resolve_member_identity

    tm = _make_team_member(ttype="agent")
    tm.avatar_url = "http://a/x.png"
    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = tm

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result])

    resolved = await resolve_member_identity(AGENT_TM_ID, ORG_ID, session)
    assert resolved is not None
    assert resolved.id == AGENT_TM_ID
    assert resolved.type == "agent"
    assert resolved.avatar_url == "http://a/x.png"
    # TM 매칭 시 OrgMember 조회를 하지 않음 — 1회 execute
    assert session.execute.await_count == 1


@pytest.mark.anyio
async def test_resolve_member_identity_falls_back_to_org_member():
    """TM 없으면 OrgMember로 fallback — TM→OM→User 3단 독립 조회."""
    from app.services.member_resolver import resolve_member_identity

    om = _make_org_member()
    user = MagicMock(); user.email = "human@test.com"; user.id = USER_ID

    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = None  # TeamMember 미존재
    om_result = MagicMock()
    om_result.scalar_one_or_none.return_value = om            # OrgMember 존재
    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = user

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result, om_result, user_result])

    resolved = await resolve_member_identity(ORG_MEMBER_ID, ORG_ID, session)
    assert resolved is not None
    assert resolved.id == ORG_MEMBER_ID
    assert resolved.type == "human"
    assert resolved.user_id == USER_ID
    assert resolved.name == "human@test.com"
    # 2단(+User) 조회 확정
    assert session.execute.await_count == 3


@pytest.mark.anyio
async def test_resolve_member_identity_none_when_not_in_org():
    """TM·OM 둘 다 없으면 None — orphan fallback 없음(404 유도)."""
    from app.services.member_resolver import resolve_member_identity

    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = None
    om_result = MagicMock()
    om_result.scalar_one_or_none.return_value = None

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result, om_result])

    resolved = await resolve_member_identity(uuid.uuid4(), ORG_ID, session)
    assert resolved is None
    assert session.execute.await_count == 2


# ── QA B1 보강: filter_org_member_ids 2단 조회 + cross-org 차단 검증 ───────────

@pytest.mark.anyio
async def test_filter_org_member_ids_keeps_tm_and_om_drops_foreign():
    """TM∪OM 소속만 통과, cross-org/orphan은 제거 — 2단 독립 조회."""
    from app.services.member_resolver import filter_org_member_ids

    tm_id, om_id, foreign_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    tm_result = MagicMock()
    tm_result.scalars.return_value.all.return_value = [tm_id]   # TeamMember 소속
    om_result = MagicMock()
    om_result.scalars.return_value.all.return_value = [om_id]   # OrgMember 소속

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result, om_result])

    out = await filter_org_member_ids({tm_id, om_id, foreign_id}, ORG_ID, session)
    assert out == {tm_id, om_id}
    assert foreign_id not in out
    # TeamMember 후 잔여(om_id, foreign_id)에 대해 OrgMember 2단 조회
    assert session.execute.await_count == 2


@pytest.mark.anyio
async def test_filter_org_member_ids_skips_om_query_when_all_team_members():
    """전부 TeamMember면 OrgMember 조회 스킵 — 1회 execute."""
    from app.services.member_resolver import filter_org_member_ids

    a, b = uuid.uuid4(), uuid.uuid4()
    tm_result = MagicMock()
    tm_result.scalars.return_value.all.return_value = [a, b]

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result])

    out = await filter_org_member_ids({a, b}, ORG_ID, session)
    assert out == {a, b}
    assert session.execute.await_count == 1


@pytest.mark.anyio
async def test_filter_org_member_ids_empty_short_circuits():
    """빈 입력은 쿼리 없이 빈 집합."""
    from app.services.member_resolver import filter_org_member_ids

    session = AsyncMock()
    session.execute = AsyncMock()

    out = await filter_org_member_ids(set(), ORG_ID, session)
    assert out == set()
    session.execute.assert_not_awaited()


# ── 2차 버그 가드: resolve_auth_member team_member-first (스탠드업 카드 매칭) ────

@pytest.mark.anyio
async def test_resolve_auth_member_prefers_team_member():
    """JWT 휴먼에 team_member 있으면 team_member.id 반환(카드 매칭) — org_member 조회 안 함."""
    from app.services.member_resolver import resolve_auth_member

    auth = _make_auth()  # JWT
    tm = _make_team_member(ttype="human")
    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = tm

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result])

    resolved = await resolve_auth_member(auth, ORG_ID, session, project_id=PROJECT_ID)
    assert resolved is tm  # team_member.id 그대로 (org_member.id-always 아님)
    assert session.execute.await_count == 1  # team_member 매칭 시 org_member 조회 스킵


@pytest.mark.anyio
async def test_resolve_auth_member_falls_back_to_org_member():
    """team_member 없으면(grant-only) resolve_member(org_member.id)로 fallback."""
    from app.services import member_resolver as mr
    from app.services.member_resolver import ResolvedMember, resolve_auth_member

    auth = _make_auth()
    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = None  # team_member 없음

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result])

    om_member = ResolvedMember(
        id=ORG_MEMBER_ID, user_id=USER_ID, name="u", type="human", role="member", org_id=ORG_ID
    )
    with patch.object(mr, "resolve_member", new=AsyncMock(return_value=om_member)) as mock_rm:
        resolved = await resolve_auth_member(auth, ORG_ID, session, project_id=PROJECT_ID)
    assert resolved.id == ORG_MEMBER_ID
    mock_rm.assert_awaited_once()


@pytest.mark.anyio
async def test_resolve_auth_member_api_key_returns_team_member():
    """API키(에이전트)는 team_member.id 반환."""
    from app.services.member_resolver import resolve_auth_member

    auth = _make_auth(is_api_key=True)
    tm = _make_team_member()
    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = tm

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_result])

    resolved = await resolve_auth_member(auth, ORG_ID, session)
    assert resolved is tm

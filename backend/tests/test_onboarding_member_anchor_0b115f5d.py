"""온보딩 휴먼 members 앵커 보장(0b115f5d) — 3경로 ensure_human_member 호출 회귀.

근본: 휴먼 org_member는 생기나 canonical members 앵커(type='human')가 안 생겨
created_by NULL·assignee 누락·DM 403의 공통 뿌리가 됨. org 생성·project 생성·invite 수락
3경로가 org_member INSERT 직후 그 org_member.id로 ensure_human_member를 호출하는지 검증.

mocked 세션 + ensure_human_member 패치 — 항상 도는 구조 회귀(실 PG INSERT는 parity 테스트 영역).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _scalar_result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


# ─── 경로 ①: organizations.create_organization ──────────────────────────────


@pytest.mark.anyio
async def test_create_organization_ensures_human_member():
    """org 생성 시 owner org_member.id로 ensure_human_member 호출(앵커 보장)."""
    from app.routers import organizations as orgs

    om_id = uuid.uuid4()
    user_id = uuid.uuid4()

    session = AsyncMock()
    # email_verified user → org-create 허용, 이후 om_id SELECT 캡처
    user = MagicMock()
    user.email_verified = True
    session.execute = AsyncMock(
        side_effect=[
            _scalar_result(user),   # email_verified 조회
            MagicMock(),            # org_members INSERT
            _scalar_result(om_id),  # om_id 재조회(캡처)
        ]
    )
    session.commit = AsyncMock()

    repo = MagicMock()
    org_obj = MagicMock()
    org_obj.id = uuid.uuid4()
    repo.create = AsyncMock(return_value=org_obj)

    auth = MagicMock()
    auth.user_id = str(user_id)

    body = MagicMock()
    body.name = "Acme"
    body.slug = "acme"
    body.owner_member_id = None

    with patch.object(orgs, "ensure_human_member", new=AsyncMock()) as ehm, \
            patch.object(orgs.OrganizationResponse, "model_validate", return_value=MagicMock()):
        await orgs.create_organization(body=body, auth=auth, repo=repo, session=session)

    ehm.assert_awaited_once()
    assert ehm.await_args.args == (session, om_id)


# ─── 경로 ②: projects.create_project ────────────────────────────────────────


@pytest.mark.anyio
async def test_create_project_ensures_human_member():
    """project 생성 시 생성자 org_member.id로 ensure_human_member 호출(생성자 앵커 보장)."""
    from app.routers import projects as projs

    om_id = uuid.uuid4()
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()

    session = AsyncMock()
    session.execute = AsyncMock(
        side_effect=[
            MagicMock(),            # org_members INSERT
            _scalar_result(om_id),  # om_id 재조회(캡처)
        ]
    )
    session.commit = AsyncMock()

    auth = MagicMock()
    auth.user_id = str(user_id)

    body = MagicMock()
    body.name = "Board"
    body.description = None

    project_obj = MagicMock()

    fake_repo = MagicMock()
    fake_repo.create = AsyncMock(return_value=project_obj)

    with patch.object(projs, "ProjectRepository", return_value=fake_repo), \
            patch.object(projs, "ensure_human_member", new=AsyncMock()) as ehm, \
            patch.object(projs.ProjectResponse, "model_validate", return_value=MagicMock()):
        await projs.create_project(body=body, session=session, auth=auth, org_id=org_id)

    ehm.assert_awaited_once()
    assert ehm.await_args.args == (session, om_id)


# ─── 경로 ③: org_invite.OrgInviteRepository.accept ──────────────────────────


@pytest.mark.anyio
async def test_invite_accept_ensures_human_member():
    """invite 수락(pending → accepted) 시 수락자 org_member.id로 ensure_human_member 호출."""
    from datetime import datetime, timedelta, timezone

    from app.repositories.org_invite import OrgInviteRepository

    om_id = uuid.uuid4()
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()

    invite = MagicMock()
    invite.status = "pending"
    invite.organization_id = org_id
    invite.role = "member"
    invite.email = "invitee@example.com"
    invite.expires_at = datetime.now(timezone.utc) + timedelta(days=3)
    invite.project_ids = []  # _grant_invite_project_access no-op

    session = AsyncMock()
    session.execute = AsyncMock(
        side_effect=[
            _scalar_result(invite),  # accept(): invite 조회
            MagicMock(),             # org_members upsert
            _scalar_result(om_id),   # _ensure_member_anchor: om_id 재조회
        ]
    )
    session.flush = AsyncMock()

    repo = OrgInviteRepository(session)

    with patch(
        "app.services.agent_anchor_sync.ensure_human_member", new=AsyncMock()
    ) as ehm:
        result = await repo.accept(
            token="tok", user_id=user_id, user_email="invitee@example.com"
        )

    assert result["ok"] is True
    ehm.assert_awaited_once()
    assert ehm.await_args.args == (session, om_id)


# ─── 구조 가드: 3경로가 ensure_human_member를 import/호출 ────────────────────


def test_three_paths_reference_ensure_human_member():
    """org/project 라우터 + org_invite 리포가 ensure_human_member 경로를 보유."""
    from app.routers import organizations as orgs
    from app.routers import projects as projs
    from app.repositories.org_invite import OrgInviteRepository

    assert hasattr(orgs, "ensure_human_member")
    assert hasattr(projs, "ensure_human_member")
    assert hasattr(OrgInviteRepository, "_ensure_member_anchor")

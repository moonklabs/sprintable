"""story #4358 — 웹훅 발송기가 설정 주인의 프로젝트 접근을 다시 보지 않는다(AC1 재현).

4729(4350 PR 3)는 웹훅 **만들기 · 고치기**에 프로젝트 접근 확인을 넣었지만, 이미 만들어진 설정은 발송 때 다시 보지 않는다:
`webhook_dispatch._fetch_webhook_targets`는 org의 활성 설정 전부를 고르고 `recipient_member_ids`가 주어질 때만 구성원으로 좁힌다.
그래서 프로젝트 P 범위 웹훅을 만든 구성원이 P 접근을 잃어도 이벤트가 그 URL로 계속 간다.

재현: P 범위 · 활성 · 주인 = P 접근이 없는 구성원 → 발송 대상에 그 URL이 있다(지금) → 고친 뒤 0이어야 한다(RED).
대조: 같은 모양인데 주인이 P 접근을 가진 설정은 그대로 대상이다(회귀 0).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _human_member(s, org_id, *, grant_project_id=None):
    """사람 구성원(users + org_members + members) · grant_project_id가 있으면 그 프로젝트 접근."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await s.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    s.add(om)
    member = Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="M", is_active=True)
    s.add(member)
    await s.flush()
    if grant_project_id is not None:
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=grant_project_id, org_member_id=om.id, member_id=member.id, permission="granted"))
    await s.flush()
    return member.id


async def test_webhook_of_an_owner_without_project_access_still_receives_events():
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.webhook_config import WebhookConfig
    from app.services.webhook_dispatch import _fetch_webhook_targets

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.flush()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.flush()
            lost = await _human_member(s, org.id)  # P 접근 없음(잃었다)
            kept = await _human_member(s, org.id, grant_project_id=project.id)
            for member_id, tag in ((lost, "LOST"), (kept, "KEPT")):
                s.add(WebhookConfig(
                    id=uuid.uuid4(), org_id=org.id, member_id=member_id, project_id=project.id,
                    url=f"https://hooks.example.com/{tag}", is_active=True,
                ))
            await s.commit()
        async with Session() as s:
            targets = await _fetch_webhook_targets(s, org.id, "story.updated")
        urls = {t["url"] for t in targets}
        assert "https://hooks.example.com/KEPT" in urls, "접근이 있는 주인의 설정은 그대로 대상(회귀 0)"
        assert "https://hooks.example.com/LOST" not in urls, "P 접근을 잃은 주인의 P 범위 웹훅으로 이벤트가 간다"
    finally:
        await engine.dispose()

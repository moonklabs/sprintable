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


async def _human_member(s, org_id, *, grant_project_id=None, distinct_ids=False):
    """사람 구성원(users + org_members + members) · grant_project_id가 있으면 그 프로젝트 접근.

    `distinct_ids` — members.id ≠ org_members.id(까디르 뮤테이션 09-27): 같은 id면 신원을 user_id 대신 member_id로 넘겨도 같은 grant가
    맞아 테스트가 틀린 신원을 못 가른다."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await s.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    s.add(om)
    member = Member(id=uuid.uuid4() if distinct_ids else om.id, org_id=org_id, type="human", user_id=user_id, name="M", is_active=True)
    s.add(member)
    await s.flush()
    if grant_project_id is not None:
        # distinct_ids면 grant는 사람 grant 라우터의 레거시 모양(`routers/project_access.py` — org_member_id만 · members 행 보장 전이면
        # member_id 없음): members.id로는 이 grant에 닿지 않아, 신원을 member_id로 넘기면 접근 있는 주인도 막힌다.
        s.add(ProjectAccess(
            id=uuid.uuid4(), project_id=grant_project_id, org_member_id=om.id,
            member_id=None if distinct_ids else member.id, permission="granted",
        ))
    await s.flush()
    return member.id


async def _world_with_webhooks(*, distinct_ids=False):
    """org · 프로젝트 P · 주인 셋(P 접근 잃음 · P 접근 있음 · 비활성) · 각자 P 범위 활성 웹훅."""
    from sqlalchemy import update

    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.webhook_config import WebhookConfig

    engine, Session = await _session_factory()
    async with Session() as s:
        org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
        s.add(org)
        await s.flush()
        project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
        s.add(project)
        await s.flush()
        lost = await _human_member(s, org.id, distinct_ids=distinct_ids)  # P 접근 없음(잃었다)
        kept = await _human_member(s, org.id, grant_project_id=project.id, distinct_ids=distinct_ids)
        gone = await _human_member(s, org.id, grant_project_id=project.id, distinct_ids=distinct_ids)
        await s.execute(update(Member).where(Member.id == gone).values(is_active=False))
        for member_id, tag in ((lost, "LOST"), (kept, "KEPT"), (gone, "GONE")):
            s.add(WebhookConfig(
                id=uuid.uuid4(), org_id=org.id, member_id=member_id, project_id=project.id,
                url=f"https://hooks.example.com/{tag}", is_active=True,
            ))
        await s.commit()
    return engine, Session, org.id, project.id


async def test_project_event_is_not_sent_to_an_owner_who_lost_project_access(caplog):
    """AC1 · AC2 — 이벤트에 project_id가 있으면 주인의 지금 접근을 본다: 잃은 주인 → 막힘(사유 로그) · 가진 주인 → 그대로."""
    from app.services.webhook_dispatch import _fetch_webhook_targets

    engine, Session, org_id, project_id = await _world_with_webhooks()
    try:
        async with Session() as s:
            targets = await _fetch_webhook_targets(s, org_id, "story.updated", event_data={"project_id": str(project_id)})
        urls = {t["url"] for t in targets}
        assert "https://hooks.example.com/KEPT" in urls, "접근이 있는 주인의 설정은 그대로 대상(회귀 0)"
        assert "https://hooks.example.com/LOST" not in urls, "P 접근을 잃은 주인의 P 범위 웹훅으로 이벤트가 간다"
        assert "https://hooks.example.com/GONE" not in urls, "비활성 주인에게 간다"
        assert "owner_no_project_access" in caplog.text, "막힌 발송은 사유가 남아야 한다(조용히 사라지지 않게)"
    finally:
        await engine.dispose()


async def test_org_level_event_needs_an_active_owner_only():
    """AC2 — project_id 없는 org 수준 이벤트: 활성 구성원 주인은 받는다(프로젝트 접근과 무관 · 회귀 0) · 비활성 주인은 막힌다."""
    from app.services.webhook_dispatch import _fetch_webhook_targets

    engine, Session, org_id, _project_id = await _world_with_webhooks()
    try:
        async with Session() as s:
            targets = await _fetch_webhook_targets(s, org_id, "agent_deployment.terminated", event_data={})
        urls = {t["url"] for t in targets}
        assert {"https://hooks.example.com/KEPT", "https://hooks.example.com/LOST"} <= urls
        assert "https://hooks.example.com/GONE" not in urls
    finally:
        await engine.dispose()


async def test_owner_removed_from_the_org_is_blocked_even_if_the_member_row_stays_active():
    """PO 09-27(까디르에 준 후보) — org에서 빠진 사람(org_members.deleted_at)인데 members 행 · 프로젝트 grant가 아직 활성이면 해소기의 team_member
    갈래가 org 소속을 안 봐 통과할 수 있다 → 실 PG로 잰다: 그런 주인의 P 범위 웹훅은 P 이벤트를 못 받아야 한다."""
    from datetime import UTC, datetime

    from sqlalchemy import update

    from app.models.project import OrgMember
    from app.services.webhook_dispatch import _fetch_webhook_targets

    engine, Session, org_id, project_id = await _world_with_webhooks()
    try:
        async with Session() as s:
            from app.models.webhook_config import WebhookConfig

            kept_member = (await s.execute(
                __import__("sqlalchemy").select(WebhookConfig.member_id).where(
                    WebhookConfig.org_id == org_id, WebhookConfig.url == "https://hooks.example.com/KEPT",
                )
            )).scalar_one()
            # KEPT 주인을 org에서 뺀다(org_members만 소프트 삭제 · members 행 · grant는 그대로 둔다).
            await s.execute(update(OrgMember).where(OrgMember.id == kept_member).values(deleted_at=datetime.now(UTC)))
            await s.commit()
        async with Session() as s:
            targets = await _fetch_webhook_targets(s, org_id, "story.updated", event_data={"project_id": str(project_id)})
        assert "https://hooks.example.com/KEPT" not in {t["url"] for t in targets}, "org에서 빠진 주인에게 P 이벤트가 간다"
    finally:
        await engine.dispose()


async def test_owner_identity_is_the_person_not_the_member_row_when_the_ids_differ(caplog):
    """까디르 뮤테이션 ① — members.id ≠ org_members.id인 주인: 사람 주인의 접근은 **사람(user_id)**으로 풀어야 grant가 맞는다.
    신원을 member_id로 넘기면 접근 있는 주인도 막힌다(RED) — 같은 id 픽스처는 이 차이를 못 가른다."""
    from app.services.webhook_dispatch import _fetch_webhook_targets

    engine, Session, org_id, project_id = await _world_with_webhooks(distinct_ids=True)
    try:
        async with Session() as s:
            targets = await _fetch_webhook_targets(s, org_id, "story.updated", event_data={"project_id": str(project_id)})
        urls = {t["url"] for t in targets}
        assert "https://hooks.example.com/KEPT" in urls, "P 접근이 있는 사람 주인(members.id ≠ org_members.id)이 막혔다 — 신원 축이 틀림"
        assert "https://hooks.example.com/LOST" not in urls
        assert "https://hooks.example.com/GONE" not in urls
    finally:
        await engine.dispose()


async def test_delivery_worker_rechecks_the_owner_at_delivery_time(monkeypatch):
    """까디르 뮤테이션 ② — 워커 길(`delivery_dispatcher._deliver_one`)을 그대로 탄다: 같은 배달 작업이 접근 있을 때는 KEPT로 가고, 접근을
    뺏은 뒤 다시 돌리면 0. 워커가 `event_data`를 안 넘기면 org 수준 판정(활성만)으로 떨어져 LOST · 뺏긴 KEPT로 간다(RED)."""
    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models.project_access import ProjectAccess
    from app.services.delivery_dispatcher import _deliver_one

    engine, Session, org_id, project_id = await _world_with_webhooks(distinct_ids=True)
    try:
        monkeypatch.setattr("app.core.database.async_session_factory", async_sessionmaker(engine, expire_on_commit=False))
        sent: list[set[str]] = []

        async def _send(targets, event, data, org_id=None):
            sent.append({t["url"] for t in targets})

        monkeypatch.setattr("app.services.webhook_dispatch._send_webhook_targets", _send)
        job = {
            "id": uuid.uuid4(), "org_id": org_id, "kind": "org_webhook", "attempts": 0,
            "payload": {"event": "story.updated", "data": {"project_id": str(project_id)}, "preserve_broadcast": True},
        }
        await _deliver_one(job)
        assert sent[-1] == {"https://hooks.example.com/KEPT"}, sent

        async with Session() as s:
            await s.execute(delete(ProjectAccess).where(ProjectAccess.project_id == project_id))
            await s.commit()
        await _deliver_one(job)
        assert len(sent) == 2 and sent[-1] == set(), f"접근을 뺏은 뒤 같은 작업이 보냈다: {sent}"
    finally:
        await engine.dispose()

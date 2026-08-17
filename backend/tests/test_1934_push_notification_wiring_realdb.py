"""story 1934(선생님 앱 done-gate: "디스코드 떼고 승인게이트·채팅 알림 실기기 즉시 수신"):
gate 생성(pending)과 채팅 멘션/메시지가 dispatch_notification()을 실제로 호출해 human 수신자에게
in-app Notification(+push, EE 게이트)이 생성되는지 실증. deliver_expo_push 자체(Expo API 왕복)는
E-MOBILE M0·S3 자체 스코프 밖이라 여기선 dispatch_notification의 core 부분(Notification INSERT)
까지만 확인 — 이미 배선된 push 채널(is_ee_enabled 게이트)은 별도로 신뢰."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_admin(session, org_id):
    """org owner/admin human 1명 시드 — gate 알림 대상 해소 확인용."""
    from app.core.security import hash_password
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    session.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
    await session.commit()
    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"admin-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    org_member_id = uuid.uuid4()
    session.add(OrgMember(id=org_member_id, org_id=org_id, user_id=user_id, role="admin"))
    await session.commit()
    return org_member_id, user_id


@pytest.mark.anyio
async def test_create_gate_pending_notifies_org_admin():
    """gate_service.create_gate()가 pending 상태로 생성되면 org owner/admin에게 in-app
    Notification이 실제로 INSERT돼야 한다(story 1934 핵심 갭 수정 실증)."""
    from sqlalchemy import select
    from app.models.notification import Notification
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            admin_member_id, _user_id = await _seed_org_admin(s, org_id)

            gate = await create_gate(
                s, org_id, uuid.uuid4(), "story", "pr_review",
                uuid.uuid4(), uuid.uuid4(),
            )
            assert gate.status == "pending"
            await s.commit()

            notif = (await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id,
                    Notification.type == "gate.pending_approval",
                    Notification.reference_id == gate.id,
                )
            )).scalar_one_or_none()
            assert notif is not None
            assert notif.user_id == _user_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_gate_auto_passed_does_not_notify():
    """allow_auto 정책(disposition)이면 status=auto_passed — 결재 대기가 아니므로 알림 0."""
    from sqlalchemy import select
    from app.models.hitl_config import OrgGatePolicy
    from app.models.notification import Notification
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            admin_member_id, _user_id = await _seed_org_admin(s, org_id)
            s.add(OrgGatePolicy(id=uuid.uuid4(), org_id=org_id, posture="permissive"))
            await s.commit()

            gate = await create_gate(
                s, org_id, uuid.uuid4(), "story", "pr_review",
                uuid.uuid4(), uuid.uuid4(),
            )
            await s.commit()

            notif = (await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id,
                    Notification.type == "gate.pending_approval",
                    Notification.reference_id == gate.id,
                )
            )).scalar_one_or_none()
            if gate.status != "pending":
                assert notif is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_gate_pending_notification_via_outbox():
    """story #2688: create_gate()의 dispatch_notification 콜이 via_outbox=True를 넘기는지 pin.

    동기 개인 webhook POST가 create_gate() 호출부(예: docs/{id}/transition draft→pending)의
    열린 트랜잭션 커넥션을 붙잡아 2.7s대 지연을 유발했다(실측·story #2687과 동일 결함 클래스).
    Notification INSERT 자체(위 test_create_gate_pending_notifies_org_admin)는 via_outbox와
    무관하게 그대로 발생 — 이 테스트는 그 위에 얹힌 배달 채널 계약만 별도로 고정한다."""
    from unittest.mock import AsyncMock, patch
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await _seed_org_admin(s, org_id)

            dn = AsyncMock()
            with patch("app.services.notification_dispatch.dispatch_notification", dn):
                gate = await create_gate(
                    s, org_id, uuid.uuid4(), "story", "pr_review",
                    uuid.uuid4(), uuid.uuid4(),
                )
            assert gate.status == "pending"
            dn.assert_awaited_once()
            assert dn.await_args.kwargs["via_outbox"] is True
            assert dn.await_args.kwargs["event_type"] == "gate.pending_approval"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_rejected_gate_notification_via_outbox():
    """story #2688: 재상신(rejected→pending re-open) 경로도 동일 결함·동일 fix.

    _reopen_rejected_gate()는 create_gate()가 기존 rejected(terminal) gate를 발견했을 때
    타는 별도 콜사이트 — 새 gate 생성과 나란한 두 번째 dispatch_notification 호출."""
    from unittest.mock import AsyncMock, patch
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    work_item_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await _seed_org_admin(s, org_id)

            # 1차: rejected 상태 gate를 만든다(알림 무시 — 이 테스트의 관심사는 재상신 쪽).
            gate = await create_gate(
                s, org_id, work_item_id, "story", "pr_review",
                uuid.uuid4(), uuid.uuid4(),
            )
            await s.commit()
            from app.models.gate import set_gate_status
            from datetime import datetime, timezone
            set_gate_status(gate, "rejected", now=datetime.now(timezone.utc))
            await s.commit()

            dn = AsyncMock()
            with patch("app.services.notification_dispatch.dispatch_notification", dn):
                reopened = await create_gate(
                    s, org_id, work_item_id, "story", "pr_review",
                    uuid.uuid4(), uuid.uuid4(),
                )
            assert reopened.status == "pending"
            dn.assert_awaited_once()
            assert dn.await_args.kwargs["via_outbox"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_gate_notify_false_suppresses_generic_notification():
    """story #373cfaa1: notify=False 호출부(예: doc.py — 자체 리치 알림을 따로 쏘는 콜사이트)는
    create_gate()의 generic "gate.pending_approval" 벨을 받지 않는다(중복 제거 opt-out).
    mutation-kill: doc.py의 notify=False 인자를 빼면 이 자리의 dn이 호출돼 RED가 된다."""
    from unittest.mock import AsyncMock, patch
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await _seed_org_admin(s, org_id)

            dn = AsyncMock()
            with patch("app.services.notification_dispatch.dispatch_notification", dn):
                gate = await create_gate(
                    s, org_id, uuid.uuid4(), "doc", "doc_approval",
                    uuid.uuid4(), uuid.uuid4(), notify=False,
                )
            assert gate.status == "pending"
            dn.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_rejected_gate_notify_false_suppresses_generic_notification():
    """story #373cfaa1: 재상신(rejected→pending reopen) 경로도 notify=False면 generic 벨이
    안 나간다(doc 재상신 시 doc.py 자체 알림과의 중복 제거가 이 경로에도 동일 적용)."""
    from unittest.mock import AsyncMock, patch
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    work_item_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await _seed_org_admin(s, org_id)

            gate = await create_gate(
                s, org_id, work_item_id, "doc", "doc_approval",
                uuid.uuid4(), uuid.uuid4(), notify=False,
            )
            await s.commit()
            from app.models.gate import set_gate_status
            from datetime import datetime, timezone
            set_gate_status(gate, "rejected", now=datetime.now(timezone.utc))
            await s.commit()

            dn = AsyncMock()
            with patch("app.services.notification_dispatch.dispatch_notification", dn):
                reopened = await create_gate(
                    s, org_id, work_item_id, "doc", "doc_approval",
                    uuid.uuid4(), uuid.uuid4(), notify=False,
                )
            assert reopened.status == "pending"
            dn.assert_not_awaited()
    finally:
        await engine.dispose()


# ─── story #2694: gate_service 잔존 동기 dispatch_notification 2콜(#2688과 동일 클래스) ──────

@pytest.mark.anyio
async def test_resolve_artifact_canonicalize_gate_notification_via_outbox():
    """artifact.canonicalized 알림(_resolve_artifact_canonicalize_gate, transition_gate 호출부
    안에서 발화 — 요청의 열린 트랜잭션 커넥션을 무는 동일 결함 클래스)도 via_outbox=True로
    옮겨졌는지 pin. mutation-kill: via_outbox=True를 빼면 이 assert가 RED가 된다."""
    from unittest.mock import AsyncMock, MagicMock, patch
    from app.models.visual_artifact import VisualArtifact
    from app.services.gate_service import _resolve_artifact_canonicalize_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            artifact_id = uuid.uuid4()
            creator_id = uuid.uuid4()
            s.add(VisualArtifact(
                id=artifact_id, org_id=org_id, project_id=uuid.uuid4(),
                title="mock artifact", created_by=creator_id,
            ))
            await s.commit()

            gate = MagicMock(
                work_item_type="visual_artifact", gate_type="artifact_canonicalize",
                work_item_id=artifact_id, org_id=org_id,
                neutral_facts={"version_number": 2, "requested_by_member_id": str(creator_id)},
                resolver_id=uuid.uuid4(),
            )

            dn = AsyncMock()
            with patch("app.services.notification_dispatch.dispatch_notification", dn):
                await _resolve_artifact_canonicalize_gate(s, gate, "approved")
            dn.assert_awaited_once()
            assert dn.await_args.kwargs["via_outbox"] is True
            assert dn.await_args.kwargs["event_type"] == "artifact.canonicalized"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_override_gate_notification_via_outbox():
    """gate_overridden 알림(override_gate, owner 강제결정 경로)도 via_outbox=True로 옮겨졌는지
    pin. 발화 조건(targets=requester+bypassed approver)을 채우려면 pending
    WorkflowLineStepApproval row 1건이 필요(override_gate의 기존 발화 조건 — 이 스토리 스코프
    밖이라 그대로 재사용). transition_gate 자체(FSM+line 배선)는 이 테스트의 관심사가
    아니므로 no-op 처리."""
    from unittest.mock import AsyncMock, patch
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepApproval
    from app.services.gate_service import override_gate

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            gate_id = uuid.uuid4()
            s.add(Gate(
                id=gate_id, org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="task",
                gate_type="qa", status="pending", requires_human=True,
            ))
            s.add(WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id,
                step_run_id=uuid.uuid4(), gate_id=gate_id, approval_group_id=uuid.uuid4(),
                approver_member_id=uuid.uuid4(), approver_member_type="human",
                requested_by_member_id=uuid.uuid4(), status="pending",
            ))
            await s.commit()

            dn = AsyncMock()
            with patch("app.services.gate_service.transition_gate", new=AsyncMock()), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await override_gate(s, org_id, gate_id, uuid.uuid4(), "approved", "긴급 강제결정")
            dn.assert_awaited_once()
            assert dn.await_args.kwargs["via_outbox"] is True
            assert dn.await_args.kwargs["event_type"] == "gate_overridden"
    finally:
        await engine.dispose()

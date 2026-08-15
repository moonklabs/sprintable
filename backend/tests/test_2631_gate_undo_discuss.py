"""story #2631 — 오클릭 정정(undo_gate_resolution) + «보류·논의»(request_gate_discussion).

축: ①undo=해소자 본인만·짧은 창(GATE_UNDO_WINDOW)·doc_approval doc.status 동반 복원·ActivityLog
스냅샷. ②discuss=pending 그대로(전이 無)·neutral_facts 확장·requester 회신은 doc_approval만
(다른 타입은 no-op을 requester_notified=False로 명시 — #2655 「조용한 재연결 루프」 교훈 재적용).
③엔드포인트 인가: undo=body 무관 actor 강제(별도 role 없음, self-check은 서비스 레이어)·
discuss=승인/거부와 동일 자격(_authorize_gate_approve_equivalent, transition과 DRY 공유).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.activity_log  # noqa: F401 — #2201 후속: app.models 벌크 import 미등재 10개 중 하나.
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_resolved_gate(s, org, resolver, *, status="approved", resolved_at=None, gate_type="merge",
                               work_item_type="story"):
    from app.models.gate import Gate
    now = resolved_at or datetime.now(timezone.utc)
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=uuid.uuid4(), work_item_type=work_item_type,
                gate_type=gate_type, status=status, resolver_id=resolver, resolved_at=now,
                resolution_note="사유")
    s.add(gate)
    await s.flush()
    return gate


async def _seed_doc_gate(s, org, resolver, requester, *, gate_status="approved", doc_status="confirmed"):
    from app.models.gate import Gate
    from app.models.doc import Doc
    from app.models.project import Project
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    doc = Doc(id=uuid.uuid4(), org_id=org, project_id=proj, title="t", slug=f"t-{uuid.uuid4().hex[:8]}",
              status=doc_status)
    s.add(doc)
    await s.flush()
    now = datetime.now(timezone.utc)
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=doc.id, work_item_type="doc",
                gate_type="doc_approval", status=gate_status, resolver_id=resolver, resolved_at=now,
                resolution_note="사유", neutral_facts={"requested_by_member_id": str(requester)})
    s.add(gate)
    await s.flush()
    return gate, doc


# ── undo_gate_resolution(realdb) ────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_reverts_to_pending_and_clears_resolver_fields():
    from app.services.gate_service import undo_gate_resolution
    engine, Session = await _session()
    async with Session() as s:
        org, resolver = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, resolver)
        await s.commit()
        g = await undo_gate_resolution(s, org, gate.id, resolver)
        await s.commit()
        assert g.status == "pending"
        assert g.resolver_id is None and g.resolved_at is None and g.resolution_note is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_not_self_raises():
    from app.services.gate_service import undo_gate_resolution, GateUndoNotSelfError
    engine, Session = await _session()
    async with Session() as s:
        org, resolver = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, resolver)
        await s.commit()
        with pytest.raises(GateUndoNotSelfError):
            await undo_gate_resolution(s, org, gate.id, uuid.uuid4())  # 타인
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_window_expired_raises():
    from app.services.gate_service import undo_gate_resolution, GateUndoWindowExpiredError, GATE_UNDO_WINDOW
    engine, Session = await _session()
    async with Session() as s:
        org, resolver = uuid.uuid4(), uuid.uuid4()
        stale = datetime.now(timezone.utc) - GATE_UNDO_WINDOW - timedelta(seconds=1)
        gate = await _seed_resolved_gate(s, org, resolver, resolved_at=stale)
        await s.commit()
        with pytest.raises(GateUndoWindowExpiredError):
            await undo_gate_resolution(s, org, gate.id, resolver)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_within_window_still_succeeds_boundary():
    """⚠️경계값: 창을 «넘지 않은» 경우(window - 1s)엔 여전히 통과해야 — off-by-one 핀."""
    from app.services.gate_service import undo_gate_resolution, GATE_UNDO_WINDOW
    engine, Session = await _session()
    async with Session() as s:
        org, resolver = uuid.uuid4(), uuid.uuid4()
        almost_stale = datetime.now(timezone.utc) - GATE_UNDO_WINDOW + timedelta(seconds=1)
        gate = await _seed_resolved_gate(s, org, resolver, resolved_at=almost_stale)
        await s.commit()
        g = await undo_gate_resolution(s, org, gate.id, resolver)
        assert g.status == "pending"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_pending_gate_rejected():
    from app.services.gate_service import undo_gate_resolution
    engine, Session = await _session()
    async with Session() as s:
        org, resolver = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, resolver, status="pending")
        await s.commit()
        with pytest.raises(ValueError, match="취소 불가"):
            await undo_gate_resolution(s, org, gate.id, resolver)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_doc_approval_reverts_doc_status_confirmed_to_pending():
    from app.services.gate_service import undo_gate_resolution
    from sqlalchemy import select
    from app.models.doc import Doc
    engine, Session = await _session()
    async with Session() as s:
        org, resolver, requester = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        gate, doc = await _seed_doc_gate(s, org, resolver, requester, gate_status="approved", doc_status="confirmed")
        await s.commit()
        await undo_gate_resolution(s, org, gate.id, resolver)
        await s.commit()
        d = (await s.execute(select(Doc).where(Doc.id == doc.id))).scalar_one()
        assert d.status == "pending"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_doc_approval_reverts_doc_status_denied_to_pending():
    from app.services.gate_service import undo_gate_resolution
    from sqlalchemy import select
    from app.models.doc import Doc
    engine, Session = await _session()
    async with Session() as s:
        org, resolver, requester = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        gate, doc = await _seed_doc_gate(s, org, resolver, requester, gate_status="rejected", doc_status="denied")
        await s.commit()
        await undo_gate_resolution(s, org, gate.id, resolver)
        await s.commit()
        d = (await s.execute(select(Doc).where(Doc.id == doc.id))).scalar_one()
        assert d.status == "pending"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_doc_status_already_changed_elsewhere_is_idempotent_guard():
    """⭐멱등 가드: doc.status가 그 사이 다른 경로로 이미 바뀌어 있으면(기대값 불일치) 건드리지 않는다."""
    from app.services.gate_service import undo_gate_resolution
    from sqlalchemy import select
    from app.models.doc import Doc
    engine, Session = await _session()
    async with Session() as s:
        org, resolver, requester = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        # gate=approved(→기대 doc.status=confirmed) 인데 실제 doc.status는 이미 superseded로 바뀜.
        gate, doc = await _seed_doc_gate(s, org, resolver, requester, gate_status="approved", doc_status="superseded")
        await s.commit()
        await undo_gate_resolution(s, org, gate.id, resolver)
        await s.commit()
        d = (await s.execute(select(Doc).where(Doc.id == doc.id))).scalar_one()
        assert d.status == "superseded"  # 안 건드림
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undo_writes_activity_log_snapshot():
    from app.services.gate_service import undo_gate_resolution
    from sqlalchemy import select
    from app.models.activity_log import ActivityLog
    engine, Session = await _session()
    async with Session() as s:
        org, resolver = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, resolver, status="rejected")
        await s.commit()
        await undo_gate_resolution(s, org, gate.id, resolver)
        await s.commit()
        log = (await s.execute(
            select(ActivityLog).where(ActivityLog.entity_id == gate.id, ActivityLog.action == "gate_resolution_undone")
        )).scalar_one()
        assert log.actor_id == resolver
        assert log.context["previous_status"] == "rejected"
        assert log.context["previous_resolver_id"] == str(resolver)
    await engine.dispose()


# ── request_gate_discussion(realdb) ─────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_discuss_keeps_gate_pending_and_sets_neutral_facts():
    from app.services.gate_service import request_gate_discussion
    engine, Session = await _session()
    async with Session() as s:
        org, actor = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, uuid.uuid4(), status="pending")
        await s.commit()
        g = await request_gate_discussion(s, org, gate.id, actor, "설계 재확인 필요")
        await s.commit()
        assert g.status == "pending"  # 전이 없음
        assert g.neutral_facts["discussion_requested"]["reason"] == "설계 재확인 필요"
        assert g.neutral_facts["discussion_requested"]["requested_by_member_id"] == str(actor)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_discuss_non_pending_gate_rejected():
    from app.services.gate_service import request_gate_discussion
    engine, Session = await _session()
    async with Session() as s:
        org, actor = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, uuid.uuid4(), status="approved")
        await s.commit()
        with pytest.raises(ValueError, match="pending만"):
            await request_gate_discussion(s, org, gate.id, actor, "사유")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_discuss_empty_reason_rejected():
    from app.services.gate_service import request_gate_discussion
    engine, Session = await _session()
    async with Session() as s:
        org, actor = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, uuid.uuid4(), status="pending")
        await s.commit()
        with pytest.raises(ValueError, match="필수"):
            await request_gate_discussion(s, org, gate.id, actor, "   ")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_discuss_non_doc_gate_activity_log_notified_false():
    """PO 판정 ③: requester 개념 없는 타입은 조용한 no-op 대신 requester_notified=False를 남긴다."""
    from app.services.gate_service import request_gate_discussion
    from sqlalchemy import select
    from app.models.activity_log import ActivityLog
    engine, Session = await _session()
    async with Session() as s:
        org, actor = uuid.uuid4(), uuid.uuid4()
        gate = await _seed_resolved_gate(s, org, uuid.uuid4(), status="pending", gate_type="merge")
        await s.commit()
        await request_gate_discussion(s, org, gate.id, actor, "사유")
        await s.commit()
        log = (await s.execute(
            select(ActivityLog).where(ActivityLog.entity_id == gate.id, ActivityLog.action == "gate_discussion_requested")
        )).scalar_one()
        assert log.context["requester_notified"] is False
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_discuss_doc_gate_dispatches_reply_and_logs_notified_true():
    from app.services.gate_service import request_gate_discussion
    from sqlalchemy import select
    from app.models.activity_log import ActivityLog
    engine, Session = await _session()
    async with Session() as s:
        org, actor, requester = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        gate, doc = await _seed_doc_gate(s, org, uuid.uuid4(), requester, gate_status="pending")
        await s.commit()
        with patch(
            "app.services.approval_delivery.dispatch_approval_discussion_reply", new=AsyncMock()
        ) as mock_dispatch:
            await request_gate_discussion(s, org, gate.id, actor, "논의합시다")
            await s.commit()
        mock_dispatch.assert_awaited_once()
        kw = mock_dispatch.await_args.kwargs
        assert kw["requester_id"] == requester
        assert kw["resolver_id"] == actor
        assert kw["reason"] == "논의합시다"
        log = (await s.execute(
            select(ActivityLog).where(ActivityLog.entity_id == gate.id, ActivityLog.action == "gate_discussion_requested")
        )).scalar_one()
        assert log.context["requester_notified"] is True
    await engine.dispose()


# ── _notify_gate_discussion_requester(mock, no_db — #2624 패턴 재사용) ──────
def _gate_sn(**overrides):
    defaults = dict(
        id=uuid.uuid4(), org_id=uuid.uuid4(), work_item_id=uuid.uuid4(),
        work_item_type="doc", gate_type="doc_approval",
        neutral_facts={"requested_by_member_id": str(uuid.uuid4())},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.mark.anyio
async def test_notify_discussion_non_doc_gate_is_noop_zero_db_calls():
    from app.services.gate_service import _notify_gate_discussion_requester
    session = AsyncMock()
    gate = _gate_sn(work_item_type="story", gate_type="merge")
    ok = await _notify_gate_discussion_requester(session, gate, uuid.uuid4(), "사유")
    assert ok is False
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_notify_discussion_missing_requester_in_facts_is_noop():
    from app.services.gate_service import _notify_gate_discussion_requester
    session = AsyncMock()
    gate = _gate_sn(neutral_facts={})
    ok = await _notify_gate_discussion_requester(session, gate, uuid.uuid4(), "사유")
    assert ok is False
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_notify_discussion_doc_not_found_returns_false():
    from app.services.gate_service import _notify_gate_discussion_requester
    session = AsyncMock()
    result = AsyncMock()
    result.scalar_one_or_none = lambda: None
    session.execute = AsyncMock(return_value=result)
    gate = _gate_sn()
    ok = await _notify_gate_discussion_requester(session, gate, uuid.uuid4(), "사유")
    assert ok is False


@pytest.mark.anyio
async def test_notify_discussion_dispatch_exception_swallowed_returns_false():
    from app.services.gate_service import _notify_gate_discussion_requester
    session = AsyncMock()
    fake_doc = SimpleNamespace(id=uuid.uuid4(), title="T")
    result = AsyncMock()
    result.scalar_one_or_none = lambda: fake_doc
    session.execute = AsyncMock(return_value=result)
    gate = _gate_sn()
    with patch(
        "app.services.approval_delivery.dispatch_approval_discussion_reply",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        ok = await _notify_gate_discussion_requester(session, gate, uuid.uuid4(), "사유")
    assert ok is False  # 예외 전파 없이 False


# ── 엔드포인트(mock, CI-runnable) ────────────────────────────────────────────
def _resolved_human(id_=None):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=id_ or uuid.uuid4(), user_id=uuid.uuid4(), name="a", type="human",
                          role="member", org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_undo_endpoint_forces_actor_from_auth_no_admin_gate():
    """⭐undo는 admin 게이팅이 없다(본인 해소를 본인이 되돌리는 축) — actor=인증 caller 강제."""
    from app.routers import gates as gates_mod
    from app.routers.gates import undo_gate_resolution_endpoint
    caller = _resolved_human()
    undofn = AsyncMock(return_value=SimpleNamespace())
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "undo_gate_resolution", undofn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        await undo_gate_resolution_endpoint(id=uuid.uuid4(), session=AsyncMock(), org_id=uuid.uuid4(),
                                            auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    # undo_gate_resolution(session, org_id, gate_id, actor_id) — actor=caller.id
    assert undofn.call_args.args[3] == caller.id


@pytest.mark.anyio
async def test_undo_endpoint_maps_not_self_to_403():
    from app.routers import gates as gates_mod
    from app.routers.gates import undo_gate_resolution_endpoint, GateUndoNotSelfError
    from fastapi import HTTPException
    caller = _resolved_human()
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "undo_gate_resolution", AsyncMock(side_effect=GateUndoNotSelfError("본인만"))):
        with pytest.raises(HTTPException) as ei:
            await undo_gate_resolution_endpoint(id=uuid.uuid4(), session=AsyncMock(), org_id=uuid.uuid4(),
                                                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_undo_endpoint_maps_window_expired_to_403():
    from app.routers import gates as gates_mod
    from app.routers.gates import undo_gate_resolution_endpoint, GateUndoWindowExpiredError
    from fastapi import HTTPException
    caller = _resolved_human()
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "undo_gate_resolution", AsyncMock(side_effect=GateUndoWindowExpiredError("만료"))):
        with pytest.raises(HTTPException) as ei:
            await undo_gate_resolution_endpoint(id=uuid.uuid4(), session=AsyncMock(), org_id=uuid.uuid4(),
                                                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_discuss_endpoint_non_approver_403_service_not_called():
    """⭐discuss는 승인/거부와 동일 자격 — non-doc 게이트에서 project owner/admin 아니면 403."""
    from app.routers import gates as gates_mod
    from app.routers.gates import request_gate_discussion_endpoint, GateDiscussionRequest
    from fastapi import HTTPException
    caller = _resolved_human()
    fake_gate = SimpleNamespace(id=uuid.uuid4(), gate_type="merge", work_item_type="story",
                                work_item_id=uuid.uuid4())
    result = AsyncMock()
    result.scalar_one_or_none = lambda: fake_gate
    discussfn = AsyncMock()
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "resolve_work_item_project_id", AsyncMock(return_value=uuid.uuid4())), \
         patch.object(gates_mod, "_non_doc_can_approve", AsyncMock(return_value=False)), \
         patch.object(gates_mod, "request_gate_discussion", discussfn):
        session = AsyncMock()
        session.execute = AsyncMock(return_value=result)
        with pytest.raises(HTTPException) as ei:
            await request_gate_discussion_endpoint(
                id=uuid.uuid4(), body=GateDiscussionRequest(reason="사유"), session=session,
                org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())),
            )
    assert ei.value.status_code == 403
    discussfn.assert_not_awaited()


@pytest.mark.anyio
async def test_discuss_endpoint_agent_caller_403():
    """⭐승인/거부와 동일하게 에이전트(비휴먼)는 discuss 요청도 불가."""
    from app.routers import gates as gates_mod
    from app.routers.gates import request_gate_discussion_endpoint, GateDiscussionRequest
    from fastapi import HTTPException
    from app.services.member_resolver import ResolvedMember
    caller = ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="agent", type="agent",
                            role="member", org_id=uuid.uuid4())
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)):
        session = AsyncMock()
        session.execute = AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: None))
        with pytest.raises(HTTPException) as ei:
            await request_gate_discussion_endpoint(
                id=uuid.uuid4(), body=GateDiscussionRequest(reason="사유"), session=session,
                org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())),
            )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_discuss_endpoint_forces_actor_from_auth():
    from app.routers import gates as gates_mod
    from app.routers.gates import request_gate_discussion_endpoint, GateDiscussionRequest
    caller = _resolved_human()
    fake_gate = SimpleNamespace(id=uuid.uuid4(), gate_type="artifact_canonicalize", work_item_type="visual_artifact",
                                work_item_id=uuid.uuid4())
    result = SimpleNamespace(scalar_one_or_none=lambda: fake_gate)
    discussfn = AsyncMock(return_value=SimpleNamespace())
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "request_gate_discussion", discussfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        session = AsyncMock()
        session.execute = AsyncMock(return_value=result)
        await request_gate_discussion_endpoint(
            id=uuid.uuid4(), body=GateDiscussionRequest(reason="사유"), session=session,
            org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())),
        )
    # request_gate_discussion(session, org_id, gate_id, actor_id, reason) — actor=caller.id
    assert discussfn.call_args.args[3] == caller.id

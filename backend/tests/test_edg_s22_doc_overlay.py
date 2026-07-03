"""E-DG S22: doc decision overlay (docs.status·draft→confirmed line overlay).

핵심: doc FSM·gate 승인 applier 가 native transition_doc(via_gate) 재사용·⭐SoD(approver≠created_by
author)·author 자동재개 wake(commit=False)·default-off byte-동일(agent confirm 차단). 마이그 백필 draft.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── doc FSM(unit·DB 없이) ─────────────────────────────────────────────────────
def test_doc_fsm_valid_transitions():
    from app.models.doc import DOC_STATUSES, is_valid_doc_transition
    # 48f064e5: pending(결재 대기·인앱 Gate) 추가.
    assert DOC_STATUSES == {"draft", "pending", "confirmed", "denied", "superseded", "deprecated"}
    assert is_valid_doc_transition("draft", "confirmed")
    assert is_valid_doc_transition("draft", "pending")          # 상신(doc-gate)
    assert is_valid_doc_transition("pending", "confirmed")      # 승인(gate)
    assert is_valid_doc_transition("pending", "denied")         # 반려(gate)
    assert is_valid_doc_transition("pending", "draft")          # 상신 취소
    assert is_valid_doc_transition("denied", "draft")          # revise
    assert is_valid_doc_transition("confirmed", "superseded")
    assert not is_valid_doc_transition("confirmed", "draft")   # 역전이 금지
    assert not is_valid_doc_transition("draft", "deprecated")  # 비합법
    assert not is_valid_doc_transition("pending", "superseded")  # 비합법


def test_matrix_doc_eligible_draft_to_confirmed_only():
    from app.services.workflow_readiness_matrix import get_readiness, is_transition_supported
    d = get_readiness("doc")
    assert d.gating_eligible is True and d.has_native_status is True
    assert d.valid_transitions == frozenset({("draft", "confirmed")})
    assert is_transition_supported("doc", "draft", "confirmed") is True
    assert is_transition_supported("doc", "confirmed", "superseded") is False  # scope 밖


@pytest.mark.anyio
async def test_apply_sod_blocks_author_null_doc():
    """⭐RC②(SoD fail-closed·CI-runnable·skipif 없음): created_by=None(저자 불명) doc → confirm 차단.
    없으면 created_by=null 생성 후 self-confirm 으로 SoD 우회(UUID==None=False 빈틈)."""
    from unittest.mock import AsyncMock, MagicMock
    from app.services.workflow_line_resolution import _apply_doc_confirmed
    doc = MagicMock(status="draft", created_by=None, id=uuid.uuid4(),
                    title="x", project_id=uuid.uuid4())
    result = MagicMock()
    result.scalar_one_or_none.return_value = doc
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    sr = MagicMock(entity_type="doc", entity_id=doc.id, org_id=uuid.uuid4())
    await _apply_doc_confirmed(session, sr, resolver_id=uuid.uuid4())  # 임의 approver
    assert sr.status == "skipped"  # author 불명 → fail-closed 차단(transition_doc 미도달)


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.event  # noqa: F401 — author wake dispatched 이벤트(events 테이블)
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_doc(s, org, proj, author, status="draft"):
    from app.models.doc import Doc
    d = Doc(org_id=org, project_id=proj, created_by=author, title="문서", slug="doc-x",
            content="", status=status)
    s.add(d)
    await s.flush()
    return d


async def _seed_sr(s, org, proj, doc_id):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="doc", entity_id=doc_id,
        from_status="draft", to_status="confirmed", status="gate_pending", mode="enforcing",
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
    )
    s.add(sr)
    await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_sod_blocks_author_self_confirm():
    """⭐SoD: approver == created_by(author) → 차단(skipped)·doc draft 유지."""
    from app.services.workflow_line_resolution import _apply_doc_confirmed
    from app.models.project import Project
    from sqlalchemy import text as sa_text
    engine, Session = await _session()
    async with Session() as s:
        org, proj, author = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        doc = await _seed_doc(s, org, proj, author)
        sr = await _seed_sr(s, org, proj, doc.id)
        await _apply_doc_confirmed(s, sr, resolver_id=author)  # author 자기 confirm
        await s.commit()
        st = (await s.execute(sa_text("SELECT status FROM docs WHERE id=:i"), {"i": doc.id})).scalar()
        assert st == "draft" and sr.status == "skipped"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_different_approver_confirms_and_wakes_author(monkeypatch):
    """approver ≠ author → confirmed + author(created_by) 자동재개 wake 호출(member_id=author)."""
    from app.services.workflow_line_resolution import _apply_doc_confirmed
    from app.models.project import Project
    from sqlalchemy import text as sa_text
    import app.services.agent_dispatch as ad
    captured = {}

    async def _fake_wake(db, org_id, member_id, **kw):
        captured["member_id"] = member_id
        captured["commit"] = kw.get("commit")
        from app.services.agent_dispatch import DispatchResponse
        return DispatchResponse(dispatched=True, reason="ok")

    monkeypatch.setattr(ad, "dispatch_payload_to_member", _fake_wake)
    engine, Session = await _session()
    async with Session() as s:
        org, proj, author, approver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        doc = await _seed_doc(s, org, proj, author)
        sr = await _seed_sr(s, org, proj, doc.id)
        await _apply_doc_confirmed(s, sr, resolver_id=approver)
        await s.commit()
        st = (await s.execute(sa_text("SELECT status FROM docs WHERE id=:i"), {"i": doc.id})).scalar()
        assert st == "confirmed" and sr.status == "applied"
        # ⭐author 자동재개: created_by 대상 wake·commit=False(gate 트랜잭션 합류·§6).
        assert captured["member_id"] == author and captured["commit"] is False
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_idempotent_already_confirmed():
    from app.services.workflow_line_resolution import _apply_doc_confirmed
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj, author, approver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        doc = await _seed_doc(s, org, proj, author, status="confirmed")
        sr = await _seed_sr(s, org, proj, doc.id)
        await _apply_doc_confirmed(s, sr, resolver_id=approver)
        await s.commit()
        assert sr.status == "applied"  # no-op·예외 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_default_off_agent_confirm_blocked():
    """default-off(라인 없음): agent confirm 시도 → overlay decision=plain → inline HUMAN_CONFIRM_REQUIRED
    유지(byte-동일·fail-open=통과 아님)."""
    from app.services.doc import transition_doc, DocTransitionError
    from app.services.member_resolver import ResolvedMember
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj, author = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        doc = await _seed_doc(s, org, proj, author)
        await s.commit()
        agent = ResolvedMember(id=uuid.uuid4(), user_id=None, name="a", type="agent",
                               role="member", org_id=org)
        with pytest.raises(DocTransitionError) as ei:
            await transition_doc(s, org, agent, doc.id, "confirmed")
        assert ei.value.code == "HUMAN_CONFIRM_REQUIRED"
    await engine.dispose()

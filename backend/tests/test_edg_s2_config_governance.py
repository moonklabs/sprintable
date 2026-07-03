"""E-DG S2: workflow line config 거버넌스 테스트.

순수(DB 불요): lint 8종 + clean pass · config_hash 결정성 · connector allow-list SDK 동기화 가드.
DB-backed(real PG 필요): create_draft · request_publish(lint fail/pass·gate) · complete_publish
(self-approval 금지 · published + active pointer flip · 멱등).
"""
from __future__ import annotations

import ast
import os
import uuid

import pytest

from app.services.workflow_line_config import (
    WORKFLOW_EVENT_ALLOWLIST,
    compute_config_hash,
    lint_config,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── clean config (passes lint) ────────────────────────────────────────────────
def _clean_config() -> dict:
    return {
        "name": "story line",
        "steps": [
            {
                "step_key": "story.in-review.done", "step_type": "merge-gate",
                "from_status": "in-review", "to_status": "done", "step_order": 1,
                "approval_policy": {"approvers": ["role:po"], "self_approval": "forbid"},
                "assignee_policy": {"role": "po", "deputy": "role:lead"},
                "routing_rules": [{"mode": "all", "conditions": [
                    {"field": "trust_score", "op": "gte", "value": 0.8}], "decision": "auto_route"}],
                "sla_policy": {"timeout_minutes": 60, "on_timeout": "escalate"},
            }
        ],
    }


def _rules(errors):
    return {e["rule"] for e in errors}


# ── pure: lint 8종 ──────────────────────────────────────────────────────────────
def test_lint_clean_passes():
    assert lint_config(_clean_config()) == []


def test_lint_no_steps():
    assert "no_steps" in _rules(lint_config({"steps": []}))
    assert "no_steps" in _rules(lint_config({}))


def test_lint_unknown_field_and_op():
    c = _clean_config()
    c["steps"][0]["routing_rules"] = [{"mode": "all", "conditions": [
        {"field": "secret_backdoor", "op": "regex"}], "decision": "auto_route"}]
    r = _rules(lint_config(c))
    assert "unknown_field" in r and "unknown_op" in r


def test_lint_no_approver():
    c = _clean_config()
    c["steps"][0]["approval_policy"] = {"self_approval": "forbid"}
    assert "no_approver" in _rules(lint_config(c))


def test_lint_self_approval_only():
    c = _clean_config()
    c["steps"][0]["approval_policy"] = {"approvers": ["self"], "self_approval": "allow_only"}
    assert "self_approval_only" in _rules(lint_config(c))


def test_lint_no_fallback_deputy():
    c = _clean_config()
    c["steps"][0]["assignee_policy"] = {"role": "po"}  # no deputy/fallback
    assert "no_fallback" in _rules(lint_config(c))


def test_lint_all_transitions_blocked():
    c = _clean_config()
    c["steps"][0]["step_type"] = "agent-handoff"
    c["steps"][0]["routing_rules"] = [{"mode": "all", "conditions": [], "decision": "block"}]
    assert "all_transitions_blocked" in _rules(lint_config(c))


def test_lint_catch_all_auto_route():
    c = _clean_config()
    c["steps"][0]["routing_rules"] = [{"mode": "any", "catch_all": True, "decision": "auto_route"}]
    assert "catch_all_auto_route" in _rules(lint_config(c))


def test_lint_high_risk_timeout_auto_approve():
    c = _clean_config()
    c["steps"][0]["sla_policy"] = {"timeout_minutes": 30, "on_timeout": "auto_approve"}
    assert "high_risk_timeout_auto_approve" in _rules(lint_config(c))


def test_lint_event_not_in_allowlist():
    c = _clean_config()
    c["steps"][0]["on_approve"] = {"emit_event": "totally_made_up_event"}
    assert "event_not_in_allowlist" in _rules(lint_config(c))
    # allow-list 내 event 는 통과
    c["steps"][0]["on_approve"] = {"emit_event": "handoff"}
    assert "event_not_in_allowlist" not in _rules(lint_config(c))


# ── pure: config_hash ───────────────────────────────────────────────────────────
def test_config_hash_deterministic_and_order_insensitive():
    a = {"x": 1, "y": [1, 2], "z": {"b": 2, "a": 1}}
    b = {"z": {"a": 1, "b": 2}, "y": [1, 2], "x": 1}
    assert compute_config_hash(a) == compute_config_hash(b)
    assert compute_config_hash(a) != compute_config_hash({"x": 2})
    assert len(compute_config_hash(a)) == 64  # sha256 hex


# ── pure: connector allow-list SDK 동기화 가드 ──────────────────────────────────
def test_event_allowlist_matches_sdk_source():
    """WORKFLOW_EVENT_ALLOWLIST 가 SDK INJECTABLE_EVENT_TYPES 단일출처와 일치(드리프트 가드).

    SDK 모듈은 backend 가 import 하지 않으므로 AST 로 frozenset literal 을 파싱해 비교한다.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    sdk = os.path.normpath(os.path.join(here, "..", "..", "connectors", "sdk", "sprintable_sse.py"))
    tree = ast.parse(open(sdk, encoding="utf-8").read())
    found = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "INJECTABLE_EVENT_TYPES" for t in node.targets
        ):
            call = node.value
            assert isinstance(call, ast.Call), "expected frozenset({...}) literal"
            found = set(ast.literal_eval(call.args[0]))
            break
    assert found is not None, "INJECTABLE_EVENT_TYPES not found in SDK"
    assert set(WORKFLOW_EVENT_ALLOWLIST) == found, (
        f"allow-list drift: backend={set(WORKFLOW_EVENT_ALLOWLIST)} vs sdk={found}"
    )


# ── DB-backed: lifecycle + publish gate + active flip ────────────────────────────
async def _make_engine_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 등록(create_all)
    import app.models.workflow_line  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole
    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="default", label="Default", is_default=True)
    session.add(role)
    await session.flush()
    return role


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_request_publish_lint_fail_blocks():
    from app.services.workflow_line_config import PublishLintError, create_draft, request_publish

    engine, Session = await _make_engine_session()
    org_id, member = uuid.uuid4(), uuid.uuid4()
    async with Session() as session:
        await _seed_default_role(session, org_id)
        bad = {"steps": [{"step_key": "s", "step_type": "merge-gate"}]}  # no approver/fallback
        version = await create_draft(session, org_id, None, "story", bad, member)
        assert version.lint_status == "failed"
        with pytest.raises(PublishLintError):
            await request_publish(session, org_id, version, member)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_publish_flow_gate_and_active_flip():
    from app.services.workflow_line_config import (
        SelfApprovalError, complete_publish, create_draft, request_publish,
    )
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineDefinition

    engine, Session = await _make_engine_session()
    org_id, requester, approver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as session:
        await _seed_default_role(session, org_id)
        version = await create_draft(session, org_id, None, "story", _clean_config(), requester)
        version, gate = await request_publish(session, org_id, version, requester)
        # default disposition = ask → pending gate, version pending_review
        assert gate.status == "pending" and version.status == "pending_review"
        assert gate.gate_type == "workflow_config_publish"
        assert (gate.neutral_facts or {}).get("version_id") == str(version.id)
        assert (gate.neutral_facts or {}).get("config_hash") == version.config_hash

        # self-approval 금지: requester == resolver
        gate.status = "approved"
        await session.flush()
        with pytest.raises(SelfApprovalError):
            await complete_publish(session, version, gate, resolver_id=requester)

        # 다른 org owner/admin 승인 → published + active definition 생성
        version = await complete_publish(session, version, gate, resolver_id=approver)
        assert version.status == "published" and version.published_at is not None
        defs = (await session.execute(
            select(WorkflowLineDefinition).where(
                WorkflowLineDefinition.org_id == org_id, WorkflowLineDefinition.is_active.is_(True))
        )).scalars().all()
        assert len(defs) == 1 and defs[0].config_hash == version.config_hash

        # 2번째 라인 publish → 기존 active retire, 신규 active 1개만
        v2 = await create_draft(session, org_id, None, "story", _clean_config(), requester)
        v2, g2 = await request_publish(session, org_id, v2, requester)
        g2.status = "approved"
        await session.flush()
        await complete_publish(session, v2, g2, resolver_id=approver)
        active = (await session.execute(
            select(WorkflowLineDefinition).where(
                WorkflowLineDefinition.org_id == org_id, WorkflowLineDefinition.is_active.is_(True))
        )).scalars().all()
        assert len(active) == 1 and active[0].version == v2.version
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_allow_auto_disposition_publishes_immediately():
    """org posture=permissive → disposition allow_auto → gate 'auto_passed' → 즉시 published.

    SME blocking: create_gate 는 allow_auto 를 'auto_passed'(approved 아님)로 만든다 — request_publish
    가 이 경로도 즉시 publish 확정해야 pending_review drift 가 없다.
    """
    from app.models.hitl_config import OrgGatePolicy
    from app.services.workflow_line_config import create_draft, request_publish
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineDefinition

    engine, Session = await _make_engine_session()
    org_id, member = uuid.uuid4(), uuid.uuid4()
    async with Session() as session:
        await _seed_default_role(session, org_id)
        session.add(OrgGatePolicy(id=uuid.uuid4(), org_id=org_id, posture="permissive"))
        await session.flush()
        version = await create_draft(session, org_id, None, "story", _clean_config(), member)
        version, gate = await request_publish(session, org_id, version, member)
        assert gate.status == "auto_passed", f"expected auto_passed, got {gate.status}"
        assert version.status == "published", f"allow_auto should publish immediately, got {version.status}"
        active = (await session.execute(
            select(WorkflowLineDefinition).where(
                WorkflowLineDefinition.org_id == org_id, WorkflowLineDefinition.is_active.is_(True))
        )).scalars().all()
        assert len(active) == 1 and active[0].config_hash == version.config_hash
    await engine.dispose()

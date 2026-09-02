"""story #3291(M1·마케팅자동화) — external_publish 게이트: 불가역 외부 발신(SNS/광고 게시)은
org posture(permissive 포함) 무관 항상 사람 승인을 거쳐야 한다.

⚠️이 스토리는 "게이트 타입이 항상-수동"임을 강제할 뿐 — 실제 발행 직전 gate.status 확인
(chokepoint)은 발행 커넥터 스토리 몫(doc axis2-recipe-mechanism-event-definitions-design §E
경계 그대로).

검증 축:
- AC1: org posture=permissive(allow_auto)여도 create_gate가 status="pending"·
  requires_human=True를 강제(뮤테이션: _ALWAYS_MANUAL_GATE_TYPES에서 external_publish를
  빼면 이 pin이 RED — "진짜 항상-수동"의 증거).
- AC2: rejected 후 재상신(create_gate 재호출)도 pending으로 재오픈.
- AC3: hitl_config.GATE_TYPES에 등재 — generic POST /api/v2/gates 스키마 검증 통과.
- AC4: a2a.py LinkGateBody가 reason="external_publish"를 거부하지 않음.
- AC5: _HIGH_RISK_GATE_TYPES 명시 등재(doc_approval 미등재 실사고 선례 반복 방지).
"""
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
async def _dispose_global_engine_after_test():
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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3291", slug=f"org3291-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _set_permissive_posture(session, org_id):
    from app.models.hitl_config import OrgGatePolicy

    session.add(OrgGatePolicy(id=uuid.uuid4(), org_id=org_id, posture="permissive"))
    await session.commit()


# ─── AC1: 핵심 pin — permissive posture여도 external_publish는 항상 pending ──────

@pytest.mark.anyio
async def test_external_publish_always_pending_even_with_permissive_posture():
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _set_permissive_posture(s, org_id)
            caller_id = uuid.uuid4()
            work_item_id = uuid.uuid4()

            gate = await create_gate(
                session=s, org_id=org_id, work_item_id=work_item_id,
                work_item_type="marketing_publish", gate_type="external_publish",
                member_id=caller_id, role_id=caller_id,
                neutral_facts={"channel": "linkedin", "content": "draft post"},
                project_id=project_id, notify=False,
            )
            await s.commit()

            assert gate.status == "pending", (
                "external_publish는 _ALWAYS_MANUAL — org posture(permissive)와 무관하게 항상 pending"
            )
            assert gate.requires_human is True
    finally:
        await engine.dispose()


# ─── AC2: rejected 후 재상신 → pending 재오픈 ────────────────────────────────

@pytest.mark.anyio
async def test_external_publish_rejected_reopens_to_pending():
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _set_permissive_posture(s, org_id)
            caller_id = uuid.uuid4()
            work_item_id = uuid.uuid4()

            gate = await create_gate(
                session=s, org_id=org_id, work_item_id=work_item_id,
                work_item_type="marketing_publish", gate_type="external_publish",
                member_id=caller_id, role_id=caller_id,
                neutral_facts={"channel": "linkedin"}, project_id=project_id, notify=False,
            )
            await s.commit()

            # 반려 상태로 직접 전이(사람이 거부했다고 가정) — 재상신 시나리오 세팅.
            gate.status = "rejected"
            gate.resolved_at = None
            await s.commit()

            reopened = await create_gate(
                session=s, org_id=org_id, work_item_id=work_item_id,
                work_item_type="marketing_publish", gate_type="external_publish",
                member_id=caller_id, role_id=caller_id,
                neutral_facts={"channel": "linkedin", "content": "revised post"},
                project_id=project_id, notify=False,
            )
            await s.commit()

            assert reopened.id == gate.id
            assert reopened.status == "pending"
            assert reopened.requires_human is True
    finally:
        await engine.dispose()


# ─── AC3: hitl_config.GATE_TYPES 등재 — schema validator 통과 ────────────────

def test_gate_types_includes_external_publish():
    from app.models.hitl_config import GATE_TYPES

    assert "external_publish" in GATE_TYPES


def test_schema_validator_accepts_external_publish():
    from app.schemas.hitl_config import OrgGateOverrideCreate

    # gate_type 필드 검증기가 GATE_TYPES를 그대로 참조 — 미등재였다면 ValueError.
    override = OrgGateOverrideCreate(
        role_id=uuid.uuid4(), gate_type="external_publish", disposition="ask",
    )
    assert override.gate_type == "external_publish"


# ─── AC4: a2a.py LinkGateBody reason 허용 ────────────────────────────────────

def test_a2a_link_gate_accepts_external_publish_reason():
    from app.routers.a2a import _VALID_LINK_GATE_REASONS

    assert "external_publish" in _VALID_LINK_GATE_REASONS


# ─── AC5: high-risk 명시 등재(doc_approval 미등재 실사고 재발 방지) ──────────

def test_high_risk_gate_types_includes_external_publish():
    from app.services.gate_service import _HIGH_RISK_GATE_TYPES

    assert "external_publish" in _HIGH_RISK_GATE_TYPES

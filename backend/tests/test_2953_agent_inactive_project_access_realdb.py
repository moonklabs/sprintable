"""story #2953(보안·인가) — 비활성(is_active=false·미삭제) 에이전트의 기존 project_access
grant가 has_project_access/accessible_project_ids_in_org/grant-생성/reassign_approver에서
계속 유효로 통과하던 비대칭 수정.

그라운딩 결론(디디, 2026-08-23·fork 전수 스윕 70+ 콜사이트): 이 predicate가 「단독 인가
관문」이 되는 진짜 authz-bypass 자리는 0건 — 모든 호출부가 이미 is_active를 검증한 살아있는
인증 컨텍스트의 identity만 넘긴다(agent가 자기 API 키로 인증하려는 시도는 `_resolve_api_key`가
두 토글 상태(SSOT-cut/legacy) 모두에서 is_active를 이미 막는다). 즉 이건 **심층방어 정합
fix**다 — SSOT(`_project_access_predicate`)가 하나뿐이라 여기 한 곳만 고치면 70+ 콜사이트가
한 번에 정합해진다. 단, `reassign_approver`(workflow_parallel_approval.py)에서 비활성
에이전트가 parallel-gate approver로 재지정될 수 있던 실 결함(자기 키로 영원히 인증 불가한
approver를 지정 → 게이트 영구 대기, 보안 아니라 데드락 버그)은 SSOT 수정만으로 자동 해소된다
(별도 코드 변경 불요 — 아래 회귀 테스트로 확認)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _bypass_fk(s) -> None:
    from sqlalchemy import text as _text
    await s.execute(_text("SET session_replication_role = replica"))


async def _seed_agent_with_grant(s, org_id, project_id, *, is_active=True):
    """AC3-1 dual-write 재현(member.id=team_member.id) — resolve_member_identity는
    team_members를 보고, has_project_access의 agent_grant_branch는 members를 본다. 실
    서비스에선 같은 id로 양쪽에 존재(1:1 미러) — 테스트도 그대로 재현해야 두 경로가 실제로
    같은 에이전트를 가리킨다."""
    from app.models.member import Member
    from app.models.team import TeamMember
    from app.models.project_access import ProjectAccess
    from app.models.project import Project

    await _bypass_fk(s)
    agent_id = uuid.uuid4()
    s.add(Project(id=project_id, org_id=org_id, name="p"))
    s.add(TeamMember(
        id=agent_id, org_id=org_id, project_id=project_id, type="agent",
        name="test-agent", role="member", is_active=is_active,
    ))
    s.add(Member(
        id=agent_id, org_id=org_id, type="agent", name="test-agent", is_active=is_active,
    ))
    s.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=agent_id, permission="granted",
    ))
    await s.flush()
    return agent_id


# ── has_project_access / accessible_project_ids_in_org — AC1+AC3 ───────────


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_has_project_access_denies_inactive_agent_with_existing_grant():
    from app.services.project_auth import has_project_access

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, proj = uuid.uuid4(), uuid.uuid4()
            agent_id = await _seed_agent_with_grant(s, org, proj, is_active=False)
            await s.commit()

            assert await has_project_access(s, agent_id, proj, org) is False
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_has_project_access_allows_active_agent_with_grant():
    """양성대조 — 활성 에이전트는 그대로 통과(무회귀)."""
    from app.services.project_auth import has_project_access

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, proj = uuid.uuid4(), uuid.uuid4()
            agent_id = await _seed_agent_with_grant(s, org, proj, is_active=True)
            await s.commit()

            assert await has_project_access(s, agent_id, proj, org) is True
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_has_project_access_restores_on_reactivation():
    """AC3 — 비활성→재활성 시 접근 복원(grant row 자체는 그대로, is_active만 토글)."""
    from app.models.member import Member
    from app.models.team import TeamMember
    from sqlalchemy import update
    from app.services.project_auth import has_project_access

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, proj = uuid.uuid4(), uuid.uuid4()
            agent_id = await _seed_agent_with_grant(s, org, proj, is_active=False)
            await s.commit()
            assert await has_project_access(s, agent_id, proj, org) is False

            await s.execute(update(Member).where(Member.id == agent_id).values(is_active=True))
            await s.execute(update(TeamMember).where(TeamMember.id == agent_id).values(is_active=True))
            await s.commit()
            assert await has_project_access(s, agent_id, proj, org) is True
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_accessible_project_ids_excludes_inactive_agent_grant():
    from app.services.project_auth import accessible_project_ids_in_org

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, proj = uuid.uuid4(), uuid.uuid4()
            agent_id = await _seed_agent_with_grant(s, org, proj, is_active=False)
            await s.commit()

            ids = await accessible_project_ids_in_org(s, agent_id, org)
            assert proj not in ids
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_accessible_project_ids_includes_active_agent_grant():
    """양성대조."""
    from app.services.project_auth import accessible_project_ids_in_org

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, proj = uuid.uuid4(), uuid.uuid4()
            agent_id = await _seed_agent_with_grant(s, org, proj, is_active=True)
            await s.commit()

            ids = await accessible_project_ids_in_org(s, agent_id, org)
            assert proj in ids
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


# ── reassign_approver(workflow_parallel_approval.py) — 데드락 방지(SSOT 수정의 부수 효과) ──


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_reassign_approver_rejects_inactive_agent_target():
    """비활성 에이전트를 parallel gate approver로 재지정하면 has_project_access가 이제
    False를 내 ValueError로 거부된다 — 예전엔 통과해 «자기 키로 영원히 인증 불가한 approver»
    가 지정돼 게이트가 영구 대기하는 데드락이었다."""
    from app.models.gate import Gate
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
    from app.services.workflow_parallel_approval import reassign_approver

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            org = uuid.uuid4()
            proj = uuid.uuid4()
            s.add(Project(id=proj, org_id=org, name="p"))
            await s.flush()
            wi = uuid.uuid4()
            gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=wi, work_item_type="story",
                        gate_type="merge", status="pending")
            s.add(gate)
            await s.flush()
            sr = WorkflowLineStepRun(
                org_id=org, project_id=proj, entity_type="story", entity_id=wi,
                from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
                gate_id=gate.id, correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
            s.add(sr)
            await s.flush()
            old_approver_id = uuid.uuid4()
            appr = WorkflowLineStepApproval(
                org_id=org, project_id=proj, step_run_id=sr.id, gate_id=gate.id,
                approval_group_id=uuid.uuid4(), approver_member_id=old_approver_id,
                approver_member_type="human", kind="approver", blocking=True, status="pending",
            )
            s.add(appr)
            await s.flush()

            # _seed_agent_with_grant가 Project도 새로 만드니 별도 project_id를 쓰되, 재지정
            # 대상 gate와 같은 has_project_access 판정 축(org)에 있어야 하므로 org는 공유한다.
            # target.project_id(=proj)에 대한 grant가 필요하므로 project_id 자체는 gate와
            # 동일해야 한다 — Project 중복 생성을 피하려 member/grant만 별도로 심는다.
            from app.models.member import Member
            from app.models.team import TeamMember
            from app.models.project_access import ProjectAccess
            inactive_agent_id = uuid.uuid4()
            s.add(TeamMember(
                id=inactive_agent_id, org_id=org, project_id=proj, type="agent",
                name="test-agent", role="member", is_active=False,
            ))
            s.add(Member(
                id=inactive_agent_id, org_id=org, type="agent", name="test-agent", is_active=False,
            ))
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=proj, member_id=inactive_agent_id, permission="granted",
            ))
            await s.commit()

            with pytest.raises(ValueError, match="접근권이 없습니다"):
                await reassign_approver(s, org, gate.id, inactive_agent_id, uuid.uuid4())
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


# ── project_access 그랜트 생성 엔드포인트 — is_active 라벨-실체 정합 ─────────────


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_create_project_access_rejects_inactive_agent_target():
    """POST /project-access가 "member_id must be an active agent" 에러 문구 그대로
    비활성 에이전트를 실제로 거부하는지(예전엔 deleted_at만 봐 문구와 실체가 안 맞았다)."""
    from app.models.member import Member
    from app.models.project import Project
    from app.routers.project_access import ProjectAccessCreate, create_project_access
    from unittest.mock import AsyncMock, MagicMock, patch

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            org, proj = uuid.uuid4(), uuid.uuid4()
            s.add(Project(id=proj, org_id=org, name="p"))
            agent_id = uuid.uuid4()
            s.add(Member(id=agent_id, org_id=org, type="agent", name="inactive-agent", is_active=False))
            await s.commit()

            auth = MagicMock()
            auth.user_id = str(uuid.uuid4())
            auth.claims = {"app_metadata": {"org_id": str(org)}}
            with patch("app.routers.project_access._require_owner_or_admin", AsyncMock(return_value=None)):
                from fastapi import HTTPException
                with pytest.raises(HTTPException) as exc_info:
                    await create_project_access(
                        proj, ProjectAccessCreate(member_id=agent_id, permission="granted"),
                        auth, s,
                    )
                assert exc_info.value.status_code == 400
    finally:
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()

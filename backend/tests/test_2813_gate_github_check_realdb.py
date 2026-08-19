"""story #2813(Gate→GitHub required check) — gate_github_check.py 실 PG 영속 검증.

github_app.py의 실 GitHub API 호출만 mock(checks:write 권한 미착지 — 설계 doc §2-4, PO 4/19
확認: "라이브 AC는 권한 착지 후"), DB 왕복(migration 0262 컬럼/테이블·SHA 귀속·재-pending·원장)은
전부 실 Postgres로 검증한다.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드(GateGithubCheckEvent 포함).
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session, *, gate_status="pending", approved_head_sha=None, github_check_run_id=None):
    from app.models.gate import Gate
    from app.models.github_installation import GithubInstallation
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.pull_request_story_link import PullRequestStoryLink
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="gate check target")
    session.add(story)
    await session.commit()

    gate = Gate(
        id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
        gate_type=MERGE_GATE_TYPE, status=gate_status,
        approved_head_sha=approved_head_sha, github_check_run_id=github_check_run_id,
    )
    session.add(gate)

    installation = GithubInstallation(
        id=uuid.uuid4(), org_id=org.id, installation_id=424242, account_login="acme",
    )
    session.add(installation)

    link = PullRequestStoryLink(
        id=uuid.uuid4(), org_id=org.id, story_id=story.id,
        repo_full_name="acme/repo", pr_number=7, link_source="sid", confidence="high",
    )
    session.add(link)
    await session.commit()
    await session.refresh(gate)

    return {"org_id": org.id, "story_id": story.id, "gate_id": gate.id}


@pytest.mark.anyio
async def test_publish_gate_check_creates_pending_check_and_ledger_row_realdb():
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.gate_github_check_event import GateGithubCheckEvent
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="pending")

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 9001}),
        ) as create_mock, patch(
            "app.core.database.async_session_factory", Session,
        ):
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-pending-1", repo_full_name="acme/repo", pr_number=7,
            )

        create_mock.assert_awaited_once()
        _, kwargs = create_mock.call_args
        assert create_mock.call_args.args[1:3] == ("acme/repo", "sha-pending-1")
        assert create_mock.call_args.kwargs["status"] == "in_progress"
        assert create_mock.call_args.kwargs["conclusion"] is None

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.github_check_run_id == 9001
            assert gate.approved_head_sha is None  # pending이라 SHA 귀속 아직

            events = (
                await s.execute(select(GateGithubCheckEvent).where(GateGithubCheckEvent.gate_id == gate.id))
            ).scalars().all()
            assert len(events) == 1
            assert events[0].event_type == "published"
            assert events[0].head_sha == "sha-pending-1"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_approved_sets_conclusion_success_and_sha_attribution_realdb():
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved", github_check_run_id=9001)

        with patch(
            "app.services.gate_github_check.update_check_run",
            AsyncMock(return_value={"id": 9001, "conclusion": "success"}),
        ) as update_mock, patch(
            "app.core.database.async_session_factory", Session,
        ):
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-approved-1", repo_full_name="acme/repo", pr_number=7,
            )

        assert update_mock.call_args.kwargs["status"] == "completed"
        assert update_mock.call_args.kwargs["conclusion"] == "success"

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.approved_head_sha == "sha-approved-1"  # SHA 귀속(AC②) 실제 저장 확認.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_fail_closed_on_github_error_does_not_set_success_realdb():
    """fail-closed(설계 doc §2-3) — create/update_check_run이 실패(None)하면 approved_head_sha도
    ledger row도 안 남는다(요청 자체가 GitHub에 성공적으로 안 갔으므로)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.gate_github_check_event import GateGithubCheckEvent
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved")

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value=None),
        ), patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-fail-1", repo_full_name="acme/repo", pr_number=7,
            )

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.approved_head_sha is None
            assert gate.github_check_run_id is None
            events = (
                await s.execute(select(GateGithubCheckEvent).where(GateGithubCheckEvent.gate_id == gate.id))
            ).scalars().all()
            assert events == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_never_raises_on_unexpected_exception_realdb():
    """fail-closed 최종 경계 — 예측 못 한 예외도 삼킨다(백그라운드 태스크는 절대 안 죽는다)."""
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved")

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(side_effect=RuntimeError("boom")),
        ), patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(  # 예외 없이 반환돼야 함(raise 안 함).
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-x", repo_full_name="acme/repo", pr_number=7,
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_gate_if_new_sha_flips_approved_to_pending_realdb():
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(
                s, gate_status="approved", approved_head_sha="old-sha", github_check_run_id=9001,
            )

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "new-sha")
            await s.commit()

        assert flipped is True

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            assert gate.status == "pending"
            assert gate.approved_head_sha is None
            assert gate.github_check_run_id is None  # 새 SHA는 새 check-run(§2-2).
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_gate_if_new_sha_noop_when_sha_matches_realdb():
    """양성대조 — SHA가 같으면 재-pending 안 한다(vacuous하게 항상 flip하는 버그 방지)."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved", approved_head_sha="same-sha")

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "same-sha")

        assert flipped is False

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            assert gate.status == "approved"  # 무회귀.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_gate_if_new_sha_noop_when_not_approved_realdb():
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="pending")

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "any-sha")

        assert flipped is False
    finally:
        await engine.dispose()

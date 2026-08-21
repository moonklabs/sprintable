"""story #2835(PO AC 확定 2026-08-20, #2826 계열 마지막 반쪽) — 승인 «전이» 경로가 여전히
PullRequestStoryLink row에 의존해, row-less 자동 생성 gate(2826 주처방의 기본 케이스 — SID
해소는 link row를 안 만든다)는 승인해도 check success 발행이 죽던 결함의 회귀.

실사고(2026-08-20): gate `dbefee69`(story #2834, PR#3259) — PO 승인 10:08:03, 백엔드 상태
완벽(approved·anchor 정확·github_check_run_id/sha 보유)인데 GitHub check는 in_progress 잔류.
#3258이 심은 사유 로그가 정확히 발화: "repo_full_name/pr_number 인자 없음 + PR 링크도 없음 —
check 발행 skip". #3258은 **웹훅 수명주기 경로**(인자 보유)만 고쳤고, **승인 전이 경로**
(`gates.py::transition_gate_endpoint`가 `background_tasks.add_task(publish_gate_check,
org_id, gate.id)`를 인자 없이 호출)는 그대로였다.

fix: `gate.neutral_facts`가 이미 repo+pr_number를 갖고 있음을 그라운딩으로 실측
(`evaluate_merge_gate`가 gate 생성/재평가마다 채우는 facts dict, merge_verdict_gate.py) —
새 컬럼/installation 도출 불요, 있으면 그대로 background task에 전달. 없으면(legacy gate)
기존 link-row 폴백이 그대로 받는다(#2835 AC⑤, 명시 수용).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


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
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드.
    import app.models.activity_log  # noqa: F401 — transition_gate()가 ActivityLog를 씀(#2201 후속 미등재 갭).

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_common(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="owner",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_rowless_autocreated_gate_approve_publishes_success_via_neutral_facts():
    """실사고 재현(양성대조): PullRequestStoryLink row가 **하나도 없는** gate(SID 해소로 자동
    생성된 케이스와 동형) — neutral_facts에 repo+pr_number만 있고 anchor(github_check_run_sha)도
    이미 웹훅 경로가 찍어 둔 상태(그 부분은 #3258이 이미 고쳤음). 여기서 승인하면 배경 태스크가
    link row 없이도 neutral_facts만으로 발행에 성공해야 한다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.github_installation import GithubInstallation
    from app.models.pm import Story
    from app.models.pull_request_story_link import PullRequestStoryLink
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="row-less 승인 발행 회귀",
            )
            s.add(story)
            await s.commit()
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=555835, account_login="acme",
            ))
            await s.commit()

            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=90201, github_check_run_sha="sha-rowless",
                neutral_facts={"repo": "acme/rowless-repo", "pr_number": 2835},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id
            story_id = story.id

        # row-less 확인 — 이 story에 PullRequestStoryLink 행이 정말로 0개인지 사전 검증.
        async with Session() as s:
            links = (
                await s.execute(select(PullRequestStoryLink).where(PullRequestStoryLink.story_id == story_id))
            ).scalars().all()
            assert links == [], "이 테스트의 전제는 link row 0개(row-less) — 세팅 오류"

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            update_mock = AsyncMock(return_value={"id": 90201})
            create_mock = AsyncMock()
            with patch("app.services.gate_github_check.update_check_run", update_mock), \
                 patch("app.services.gate_github_check.create_check_run", create_mock), \
                 patch("app.core.database.async_session_factory", Session):
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    json={"status": "approved", "note": "row-less 발행 자립 확인", "evidence_viewed": True},
                )
                assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        # link row 안 만들고도(#3258 웹훅 경로 우회와 동형) 발행 성공했는지 — update_check_run이
        # 실제로 정확한 repo_full_name/head_sha로 호출됐는지 확인(create가 아니라 update — 기존
        # check-run id/sha가 이미 일치하므로 PATCH 경로).
        create_mock.assert_not_called()
        update_mock.assert_awaited_once()
        assert update_mock.call_args.args[1] == "acme/rowless-repo", update_mock.call_args
        assert update_mock.call_args.args[2] == 90201, update_mock.call_args
        assert update_mock.call_args.kwargs["conclusion"] == "success", update_mock.call_args

        async with Session() as s:
            refetched = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert refetched.status == "approved"
            assert refetched.approved_head_sha == "sha-rowless"

            links = (
                await s.execute(select(PullRequestStoryLink).where(PullRequestStoryLink.story_id == story_id))
            ).scalars().all()
            assert links == [], "발행 경로가 link row를 만들어내면 안 됨(row-less 유지 확인)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

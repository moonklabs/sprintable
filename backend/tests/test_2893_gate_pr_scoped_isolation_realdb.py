"""story #2893(설계안 gate-auto-creation-design-2893 §2 A1, PR①) — gate PR단위 슬롯.

실사고1/2 재발방지 회귀가드: 같은 스토리에 PR A·B가 동시에 열려 있을 때, ①각자 독립된
gate row를 갖고(rebind 없음) ②PR B의 새 SHA/CI 증거가 이미 approved인 PR A의 gate를
건드리지 않으며(reconcile_merge_gate_with_real_evidence 격리) ③웹훅의 reopen-vs-auto생성
분기가 정확히 그 PR의 gate만 골라 재-pending시킨다(verdict_capture.py 격리)는 것을 실 PG
왕복으로 증명한다.

github_app.py의 실 GitHub API 호출만 mock — DB 왕복은 실 Postgres(test_2826과 동일 관례,
Base.metadata.create_all이라 0271의 부분 유니크 인덱스 자체는 여기서 검증 안 됨 — 애플리케이션
레벨 격리 로직만 잰다. 인덱스 자체의 존재는 alembic upgrade head가 별도로 증명).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]

APP_SECRET = "app-secret-2893"


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
    import app.models  # noqa: F401
    import app.models.verdict  # noqa: F401 — capture_pr_ci_verdict가 verdict 테이블을 쓴다(#2826 동일 관례).
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _post_app(payload, Session, *, delivery_id):
    from app.main import app as fastapi_app
    from app.routers import verdict_capture as mod
    from tests.conftest import override_db_and_read

    async def override_db():
        async with Session() as s:
            yield s

    override_db_and_read(fastapi_app, override_db)
    body = json.dumps(payload).encode()
    headers = {
        "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": delivery_id,
        "X-Hub-Signature-256": _sign(body, APP_SECRET),
    }
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_webhook_secret", "legacy-unused"), \
                 patch.object(mod.settings, "github_app_webhook_secret", APP_SECRET):
                return await c.post(
                    "/api/v2/internal/verdict/github-webhook", content=body, headers=headers,
                )
    finally:
        fastapi_app.dependency_overrides.clear()


def _pr_payload(*, action, pr_number, installation_id, head_sha, merged=False, title="chore: unrelated"):
    return {
        "action": action,
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": merged,
            "head": {"sha": head_sha, "ref": f"feat-branch-{pr_number}"},
        },
    }


async def _seed_org_project_story(s, *, with_participation: bool):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    s.add(project)
    await s.commit()
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress")
    s.add(story)
    await s.commit()

    if with_participation:
        from app.models.participation import Participation, ParticipationRole

        role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="implementation", label="Impl", is_default=True)
        s.add(role)
        await s.commit()
        member_id = uuid.uuid4()
        s.add(Participation(id=uuid.uuid4(), org_id=org.id, story_id=story.id, member_id=member_id, role_id=role.id))
        await s.commit()

    return org, project, story


async def _seed_installation(s, org, *, installation_id, enforced=False):
    from app.models.github_installation import GithubInstallation

    inst = GithubInstallation(
        id=uuid.uuid4(), org_id=org.id, installation_id=installation_id, account_login="moonklabs",
        enforced_check_repos=["moonklabs/sprintable"] if enforced else None,
    )
    s.add(inst)
    await s.commit()
    return inst


async def _seed_link(s, org, story, *, pr_number):
    from app.models.pull_request_story_link import PullRequestStoryLink

    s.add(PullRequestStoryLink(
        id=uuid.uuid4(), org_id=org.id, story_id=story.id,
        repo_full_name="moonklabs/sprintable", pr_number=pr_number,
        link_source="explicit", confidence="high",
    ))
    await s.commit()


async def _gates_for_story(s, story_id):
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    rows = (
        await s.execute(
            select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE)
        )
    ).scalars().all()
    return sorted(rows, key=lambda g: g.pr_number or 0)


@pytest.mark.anyio
async def test_two_open_prs_get_independent_gate_rows_not_one_shared_slot():
    """실사고1(story 2889/#3298·#3302) 재현 방지 — PR A·B가 같은 스토리에 동시에 열리면
    gate가 2개 생겨야 한다(1슬롯 rebind 아님)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680001)
            await _seed_link(s, org, story, pr_number=101)
            await _seed_link(s, org, story, pr_number=102)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 91001}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _pr_payload(action="opened", pr_number=101, installation_id=680001, head_sha="sha-a1"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            await _post_app(
                _pr_payload(action="opened", pr_number=102, installation_id=680001, head_sha="sha-b1"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 2, "PR A·B 각자 독립 gate row(1슬롯 rebind 아님)"
            assert {g.pr_number for g in gates} == {101, 102}
            assert gates[0].approved_head_sha != "sha-b1"  # PR A 게이트에 PR B의 SHA가 안 샘
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pr_b_new_sha_does_not_reopen_prs_a_approved_gate():
    """실사고2(3302 머지 후 3298 고립) 재현 방지의 역방향 — PR A가 이미 approved인 상태에서
    PR B가 새 push(synchronize)를 해도, reconcile/reopen 둘 다 PR A의 gate를 건드리면 안
    된다(같은 스토리 다른 PR의 SHA가 새는 실사고1의 정확한 반대축)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=680002)
            await _seed_link(s, org, story, pr_number=201)
            await _seed_link(s, org, story, pr_number=202)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 91002}),
        ), patch("app.core.database.async_session_factory", Session):
            # PR A 오픈 → gate 생성.
            await _post_app(
                _pr_payload(action="opened", pr_number=201, installation_id=680002, head_sha="sha-a-orig"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        # PR A의 gate를 사람이 이미 승인(approved)한 상태로 직접 세팅 — 실 승인 API(gates.py)를
        # 타지 않고 이 테스트의 관심사(재조정 격리)만 좁혀 재현한다.
        async with Session() as s:
            from datetime import datetime, timezone

            from app.models.gate import Gate as _Gate, set_gate_status
            from app.services.merge_verdict_gate import MERGE_GATE_TYPE

            gate_a = (
                await s.execute(
                    select(_Gate).where(
                        _Gate.work_item_id == story_id, _Gate.gate_type == MERGE_GATE_TYPE, _Gate.pr_number == 201,
                    )
                )
            ).scalar_one()
            set_gate_status(gate_a, "approved", now=datetime.now(timezone.utc))
            gate_a.approved_head_sha = "sha-a-orig"
            gate_a_id = gate_a.id
            await s.commit()

        # PR B 오픈(신규 gate) → PR B synchronize(새 SHA push) — PR A는 절대 안 건드려야 한다.
        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 91003}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _pr_payload(action="opened", pr_number=202, installation_id=680002, head_sha="sha-b-orig"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            await _post_app(
                _pr_payload(action="synchronize", pr_number=202, installation_id=680002, head_sha="sha-b-new"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        async with Session() as s:
            from app.models.gate import Gate as _Gate

            gate_a_after = (
                await s.execute(select(_Gate).where(_Gate.id == gate_a_id))
            ).scalar_one()
            assert gate_a_after.status == "approved", "PR B의 이벤트가 PR A의 approved를 재-pending시키면 안 됨"
            assert gate_a_after.approved_head_sha == "sha-a-orig", "PR A의 anchor SHA가 PR B로 안 새야 함(실사고1의 정확한 역방향)"

            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 2, "PR A·B 여전히 독립 2행"
    finally:
        await engine.dispose()

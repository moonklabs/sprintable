"""story #2826(PO 확定 2026-08-20) — merge gate가 story→done 전이(evaluate_merge_gate 유일
호출부였던 board preflight)에만 묶여 있어, PR 머지 시점엔 gate가 아직 없는 게 기본 케이스였다.

주 처방: PR open/synchronize 웹훅에서 story 링크가 해소되고 gate가 없으면 evaluate_merge_gate를
그 자리에서 재사용해 즉시 생성 + check pending 발행(AC①, AC②=board-preflight와 중복 0).
부 처방: 링크가 아예 안 풀렸는데 이 repo가 required로 걸려 있으면(enforced) action_required
check로 다음 행동을 안내(AC③, 링크 없으면 강제 없음=AC④와 짝인 "관측 없인 침묵" 유지).

github_app.py의 실 GitHub API 호출만 mock — DB 왕복은 실 Postgres(test_2813과 동일 관례).
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

APP_SECRET = "app-secret-2826"
LEGACY_SECRET = "legacy-secret-2826"


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
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드.
    import app.models.verdict  # noqa: F401 — app.models.__init__ 미등재 10건 중 하나(의도적,
    # #2201 후속 코멘트 참고) — evaluate_merge_gate가 capture_pr_ci_verdict로 verdict 테이블을
    # 쓰므로 이 파일에서만 로컬로 등재한다.
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


async def _post_legacy(payload, Session, *, delivery_id):
    """story #2827 라이브 실사고 정정 회귀 — repo-level 웹훅(installation payload 없음)은 실제로
    legacy secret으로 서명돼 온다(App 자체 웹훅 구독 0건, 페드루 그라운딩 실측). _post_app과
    유일한 차이는 서명 secret과 payload에 installation 키가 없다는 것뿐."""
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
        "X-Hub-Signature-256": _sign(body, LEGACY_SECRET),
    }
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_webhook_secret", LEGACY_SECRET), \
                 patch.object(mod.settings, "github_app_webhook_secret", "app-secret-unused-2826"):
                return await c.post(
                    "/api/v2/internal/verdict/github-webhook", content=body, headers=headers,
                )
    finally:
        fastapi_app.dependency_overrides.clear()


def _pr_payload_legacy(*, action, pr_number, head_sha, title="chore: unrelated"):
    """installation 키 없음(legacy 웹훅 실물 형태) — repo만으로 owner 매치."""
    return {
        "action": action,
        "repository": {"full_name": "moonklabs/sprintable"},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": False,
            "head": {"sha": head_sha, "ref": "feat-branch"},
        },
    }


def _pr_payload(*, action, pr_number, installation_id, head_sha, title="chore: unrelated"):
    return {
        "action": action,
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": False,
            "head": {"sha": head_sha, "ref": "feat-branch"},
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

    link = PullRequestStoryLink(
        id=uuid.uuid4(), org_id=org.id, story_id=story.id,
        repo_full_name="moonklabs/sprintable", pr_number=pr_number,
        link_source="explicit", confidence="high",
    )
    s.add(link)
    await s.commit()


async def _gates_for_story(s, story_id):
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    return (
        await s.execute(
            select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE)
        )
    ).scalars().all()


@pytest.mark.anyio
async def test_ac1_pr_open_with_link_creates_gate_and_publishes_pending_check():
    """AC①: 링크 있는 신규 PR — gate가 없으면 즉시 생성되고 check가 pending(in_progress)으로 뜬다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=555001)
            await _seed_link(s, org, story, pr_number=11)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 90001}),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload(action="opened", pr_number=11, installation_id=555001, head_sha="sha-ac1")
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1, "PR-open 경로가 gate를 정확히 1개 만들어야 한다"
            assert gates[0].status == "pending"

        create_mock.assert_called_once()
        _, kwargs = create_mock.call_args
        assert kwargs.get("status") == "in_progress"
        assert kwargs.get("conclusion") is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_pr_open_reuses_existing_gate_no_duplicate():
    """AC②: board-preflight(또는 이전 PR 이벤트)가 이미 gate를 만들어 뒀으면, PR-open 경로가
    새로 만들지 않고 그 gate 하나만 유지한다(2 경로 교차해도 gate 1개)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=555002)
            await _seed_link(s, org, story, pr_number=12)

            from app.models.gate import Gate
            from app.services.merge_verdict_gate import MERGE_GATE_TYPE

            existing_gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
            )
            s.add(existing_gate)
            await s.commit()
            story_id = story.id
            existing_gate_id = existing_gate.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 90002}),
        ), patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload(action="synchronize", pr_number=12, installation_id=555002, head_sha="sha-ac2")
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1
            assert gates[0].id == existing_gate_id, "기존 gate가 그대로 재사용돼야(중복 생성 0)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac3_pr_open_without_link_enforced_publishes_action_required():
    """AC③: story 링크가 아예 안 풀렸는데 이 repo가 required로 걸려 있으면(enforced) — 침묵 대신
    action_required check로 다음 행동을 안내한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, _story = await _seed_org_project_story(s, with_participation=False)
            await _seed_installation(s, org, installation_id=555003, enforced=True)
            # 링크·story 매치 자체를 안 만든다 — resolver가 no_match로 떨어지게.

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 90003}),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload(
                action="opened", pr_number=13, installation_id=555003, head_sha="sha-ac3",
                title="chore: no story link at all",
            )
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        create_mock.assert_called_once()
        _, kwargs = create_mock.call_args
        assert kwargs.get("status") == "completed"
        assert kwargs.get("conclusion") == "action_required"
        assert "연결" in (kwargs.get("summary") or "")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac4_pr_open_without_link_not_enforced_publishes_nothing():
    """AC④(관측모드 미해): enforced_check_repos에 없는(=required 미등록) repo면 링크 없는 PR에도
    아무 check도 안 뜬다 — 도입 마찰 0 원칙(#2813) 그대로 보존."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, _story = await _seed_org_project_story(s, with_participation=False)
            await _seed_installation(s, org, installation_id=555004, enforced=False)

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload(
                action="opened", pr_number=14, installation_id=555004, head_sha="sha-ac4",
                title="chore: no story link, not enforced",
            )
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        create_mock.assert_not_called()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac3b_legacy_source_without_installation_still_publishes_action_required():
    """실사고 회귀(2026-08-20, 라이브 시험 #3254 발견) — repo-level 웹훅은 실제로 legacy secret
    으로 온다(installation payload 없음, App 자체 웹훅 구독 0건). 최초 부처방 구현이
    `source=="app"`만 받아 이 경로에서 **한 번도 발화하지 않았다** — org_id(legacy도 repo owner
    exactly-1-match로 이미 해소됨) 기준으로 installation_id를 재조회하는 fix를 고정."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, _story = await _seed_org_project_story(s, with_participation=False)
            await _seed_installation(s, org, installation_id=555005, enforced=True)
            # 링크·story 매치 자체를 안 만든다 — resolver가 no_match로 떨어지게(AC③과 동일 조건),
            # 이번엔 app installation 대신 legacy 서명으로 보낸다.

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 90005}),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload_legacy(
                action="opened", pr_number=15, head_sha="sha-ac3b",
                title="chore: legacy webhook, no story link",
            )
            resp = await _post_legacy(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        create_mock.assert_called_once()
        _, kwargs = create_mock.call_args
        assert kwargs.get("conclusion") == "action_required"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_2847_ac2_pr_open_with_link_no_participation_enforced_publishes_action_required():
    """story #2847(AC2) — 링크는 정확히 풀렸는데 participation이 0건이면 evaluate_merge_gate가
    gate_id=None으로 조기반환(#2843/#3262 실사고 근본원인). 이 repo가 enforced면 AC③과 동형으로
    침묵 대신 action_required check(participation 전용 문구)로 안내 — gate row는 여전히 0개."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=False)
            await _seed_installation(s, org, installation_id=555006, enforced=True)
            await _seed_link(s, org, story, pr_number=16)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 90006}),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload(
                action="opened", pr_number=16, installation_id=555006, head_sha="sha-2847ac2",
            )
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        create_mock.assert_called_once()
        _, kwargs = create_mock.call_args
        assert kwargs.get("status") == "completed"
        assert kwargs.get("conclusion") == "action_required"
        assert "participation" in (kwargs.get("title") or "")
        assert "claim" in (kwargs.get("summary") or "")

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 0, "participation 없으면 gate가 서면 안 된다(#2843/#3262 재발 방지)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_2847_ac2_pr_open_with_link_no_participation_not_enforced_publishes_nothing():
    """AC4와 동형 음성대조 — enforced가 아니면 participation 미등록도 침묵(도입 마찰 0 원칙 보존)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=False)
            await _seed_installation(s, org, installation_id=555007, enforced=False)
            await _seed_link(s, org, story, pr_number=17)

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            payload = _pr_payload(
                action="opened", pr_number=17, installation_id=555007, head_sha="sha-2847ac2b",
            )
            resp = await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
            assert resp.status_code == 200, resp.text

        create_mock.assert_not_called()
    finally:
        await engine.dispose()

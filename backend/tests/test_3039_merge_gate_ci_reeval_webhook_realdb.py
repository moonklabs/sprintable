"""story #3039(2026-08-25, PO 판정) — CI-완료 웹훅이 merge 게이트 재평가를 다시 못 태우던
근본원인 2건의 회귀가드(실 사례: PR#3460 — 5개 워크플로 전부 green check_suite completed
웹훅을 200으로 수신했으나 gate.neutral_facts.ci_result가 영구 null이었다).

fix① — resolve_story_for_pr()의 SID/auto_match 해소는 매 호출 휘발성(반환만·미영속)이었다.
check_suite/workflow_run/status 이벤트는 payload에 PR title/body가 없어(_candidate_texts)
SID 텍스트로 다시 못 찾는다 — 최초 pull_request.opened 웹훅에서 SID로 한 번 풀린 뒤로는
텍스트 신호가 사라져 그 뒤 도착하는 CI-완료 웹훅은 전부 "story 못 찾음"으로 조용히
ignored 처리됐다. verdict_capture.py가 이제 텍스트 기반 해소 성공 시 그 자리서
PullRequestStoryLink로 영속화한다 — 다음부턴 explicit/stored 1)단계(텍스트 불요)가 바로 찾는다.

fix② — evaluate_merge_gate()가 재평가 때마다 ci/pr/decision을 정확히 재계산하고
decision_basis/auto_decision_reason(gate row 컬럼)은 write-back 하지만, create_gate()의
멱등 반환 특성상 neutral_facts(JSONB, FE가 실제로 읽는 "CI 통과/사유" 자리)는 최초 생성
시점 값에 영구히 갇혀 있었다 — 재평가 시 병합 갱신하도록 고쳤다.
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

APP_SECRET = "app-secret-3039"


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
    import app.models.verdict  # noqa: F401 — capture_pr_ci_verdict가 verdict 테이블을 쓴다.
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _post_app(payload, Session, *, delivery_id, event="pull_request"):
    from app.main import app as fastapi_app
    from app.routers import verdict_capture as mod
    from tests.conftest import override_db_and_read

    async def override_db():
        async with Session() as s:
            yield s

    override_db_and_read(fastapi_app, override_db)
    body = json.dumps(payload).encode()
    headers = {
        "X-GitHub-Event": event, "X-GitHub-Delivery": delivery_id,
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


def _pr_opened_payload(*, pr_number, installation_id, head_sha, title):
    """SID 태그만이 유일한 해소 신호(explicit link 사전등재 없음) — check_suite류는 이 텍스트가
    payload에 없다는 것이 fix①의 정확한 실측 지점."""
    return {
        "action": "opened",
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": False,
            "head": {"sha": head_sha, "ref": f"feat-branch-{pr_number}"},
        },
    }


def _check_suite_completed_payload(*, pr_number, installation_id, head_sha, conclusion):
    """check_suite payload — title/body 자체가 없다(_candidate_texts가 head_branch/ref만
    본다, SID 텍스트 원천 부재)."""
    return {
        "action": "completed",
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "check_suite": {
            "head_sha": head_sha, "head_branch": f"feat-branch-{pr_number}",
            "conclusion": conclusion,
            "pull_requests": [{"number": pr_number, "head": {"ref": f"feat-branch-{pr_number}"}}],
            "app": {"slug": "github-actions"},
        },
    }


async def _seed_org_project_story(s, *, with_participation: bool):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3039", slug=f"org3039-{uuid.uuid4().hex[:8]}")
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


async def _seed_installation(s, org, *, installation_id):
    from app.models.github_installation import GithubInstallation

    inst = GithubInstallation(
        id=uuid.uuid4(), org_id=org.id, installation_id=installation_id, account_login="moonklabs",
    )
    s.add(inst)
    await s.commit()
    return inst


async def _get_gate(s, story_id, pr_number):
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    return (
        await s.execute(
            select(Gate).where(
                Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE, Gate.pr_number == pr_number,
            )
        )
    ).scalar_one()


@pytest.mark.anyio
async def test_sid_only_resolution_persists_pr_story_link():
    """⭐fix① 핵심 — explicit link 사전등재 0, SID 텍스트만으로 해소된 pull_request.opened
    처리 後 PullRequestStoryLink가 실제로 DB에 남는다(다음부터 텍스트 불요 조회 가능)."""
    from app.models.pull_request_story_link import PullRequestStoryLink

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=690001)
            story_id, org_id = story.id, org.id

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92001}),
        ), patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _pr_opened_payload(
                    pr_number=3460, installation_id=690001, head_sha="sha-3460-orig",
                    title=f"[SID:{story_id}] fix billing gate",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            assert resp.status_code == 200, resp.text

        async with Session() as s:
            link = (await s.execute(
                select(PullRequestStoryLink).where(
                    PullRequestStoryLink.org_id == org_id,
                    PullRequestStoryLink.repo_full_name == "moonklabs/sprintable",
                    PullRequestStoryLink.pr_number == 3460,
                )
            )).scalar_one_or_none()
            assert link is not None, "SID 텍스트로만 풀린 해소가 링크로 영속화되지 않음(fix① 회귀)"
            assert link.story_id == story_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_check_suite_after_sid_open_updates_pending_gate_ci_result():
    """⭐#3460 실사고 정확 재현+회귀가드(fix①+②) — SID로만 해소된 PR 오픈 後, title/body가
    아예 없는 check_suite completed(success) 이벤트가 그 게이트를 찾아 ci_result를 실제로
    갱신한다. fix① 없으면 이 이벤트는 조용히 ignored(story 못 찾음)로 죽고, fix② 없으면
    설령 찾아도 neutral_facts가 create_gate 멱등경로에 막혀 갱신 안 된다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=690002)
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92002}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _pr_opened_payload(
                    pr_number=3461, installation_id=690002, head_sha="sha-3461-orig",
                    title=f"[SID:{story_id}] fix billing gate2",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        async with Session() as s:
            gate = await _get_gate(s, story_id, 3461)
            assert (gate.neutral_facts or {}).get("ci_result") is None, "생성 시점엔 CI 미지가 정상"

        with patch(
            "app.services.gate_github_check.publish_gate_check", AsyncMock(return_value=None),
        ), patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _check_suite_completed_payload(
                    pr_number=3461, installation_id=690002, head_sha="sha-3461-orig", conclusion="success",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}", event="check_suite",
            )
            assert resp.status_code == 200, resp.text

        async with Session() as s:
            gate = await _get_gate(s, story_id, 3461)
            assert gate.neutral_facts.get("ci_result") == "pass", (
                f"check_suite completed(success)가 도달했는데도 neutral_facts.ci_result가 "
                f"갱신 안 됨: {gate.neutral_facts}"
            )
            assert gate.status == "pending", "사람 승인 전이라 여전히 pending(자동 승격 아님)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluation_updates_neutral_facts_with_link_already_stored():
    """⭐fix② 단독 격리 — explicit link를 미리 심어(fix①과 무관하게 해소 자체는 항상 성공)도,
    같은 게이트에 대한 두 번째 재평가(check_suite completed, 첫 실패→두번째 성공)가 최신
    ci_result로 neutral_facts를 갱신하는지만 좁혀 검증한다."""
    from app.models.pull_request_story_link import PullRequestStoryLink

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=690003)
            s.add(PullRequestStoryLink(
                id=uuid.uuid4(), org_id=org.id, story_id=story.id,
                repo_full_name="moonklabs/sprintable", pr_number=3462,
                link_source="explicit", confidence="high",
            ))
            await s.commit()
            story_id = story.id

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 92003}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _pr_opened_payload(
                    pr_number=3462, installation_id=690003, head_sha="sha-3462-orig",
                    title="chore: no sid tag here",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )

        with patch(
            "app.services.gate_github_check.publish_gate_check", AsyncMock(return_value=None),
        ), patch("app.core.database.async_session_factory", Session):
            # 1차: CI 실패.
            await _post_app(
                _check_suite_completed_payload(
                    pr_number=3462, installation_id=690003, head_sha="sha-3462-orig", conclusion="failure",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}", event="check_suite",
            )
            async with Session() as s:
                gate = await _get_gate(s, story_id, 3462)
                assert gate.neutral_facts.get("ci_result") == "fail"

            # 2차: 같은 SHA 재실행 성공(예: 재-run) — 최신 값으로 갱신돼야 한다(첫 값에 안 갇힘).
            await _post_app(
                _check_suite_completed_payload(
                    pr_number=3462, installation_id=690003, head_sha="sha-3462-orig", conclusion="success",
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}", event="check_suite",
            )
            async with Session() as s:
                gate = await _get_gate(s, story_id, 3462)
                assert gate.neutral_facts.get("ci_result") == "pass", (
                    f"두번째 재평가가 첫 값(fail)에 갇힘: {gate.neutral_facts}"
                )
    finally:
        await engine.dispose()

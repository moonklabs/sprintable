"""story #2327(재정의, 2026-07-29) — github_webhook_delivery.skipped_reason 실PG 검증.

배경: `_process_webhook_event`가 "ignored"로 반환할 때 그 사유(skipped_reason)가 HTTP 응답
본문에만 있고 DB엔 안 남아, 실측(dev DB) 결과 pull_request 이벤트 2468건 중 2466건이
ignored인데 «어느 분기로 얼마나 갔는지» 회고로 측정 불가능했다. 이 파일은 실제 HTTP
엔드포인트(POST /api/v2/internal/verdict/github-webhook)를 실PG 세션으로 통과시켜
`skipped_reason`이 실제 delivery 행에 정확히 남는지 확認한다."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

LEGACY_SECRET = "legacy-secret"
APP_SECRET = "app-secret"


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


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _post(payload, Session, *, delivery_id, event="pull_request"):
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app
    from app.routers import verdict_capture as mod

    async def override_db():
        async with Session() as s:
            yield s

    fastapi_app.dependency_overrides[get_db] = override_db
    body = json.dumps(payload).encode()
    headers = {
        "X-GitHub-Event": event, "X-GitHub-Delivery": delivery_id,
        "X-Hub-Signature-256": _sign(body, LEGACY_SECRET),
    }
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_webhook_secret", LEGACY_SECRET), \
                 patch.object(mod.settings, "github_app_webhook_secret", APP_SECRET):
                return await c.post(
                    "/api/v2/internal/verdict/github-webhook", content=body, headers=headers,
                )
    finally:
        fastapi_app.dependency_overrides.clear()


async def _delivery_row(Session, delivery_id):
    from app.models.github_installation import GithubWebhookDelivery
    async with Session() as s:
        return (
            await s.execute(
                select(GithubWebhookDelivery).where(GithubWebhookDelivery.delivery_id == delivery_id)
            )
        ).scalar_one_or_none()


def _pr_payload(*, action, pr_number, installation_id=None, merged=False, title="chore: unrelated work"):
    payload = {
        "action": action,
        "repository": {"full_name": "moonklabs/sprintable"},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": merged,
            "head": {"sha": "sha1", "ref": "feat-branch"},
        },
    }
    if installation_id is not None:
        payload["installation"] = {"id": installation_id}
    return payload


@pytest.mark.anyio
async def test_no_actionable_signal_persists_skipped_reason():
    """④no_actionable_signal — legacy source(installation 없음)로 opened(미머지) 이벤트를
    보내면 resolve_story_for_pr가 SID 없어 먼저 실패할 수 있으니, SID를 실제 존재하는
    story에 달아 resolver를 통과시키고 merged=False로 no_actionable_signal까지 도달시킨다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
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
            story_id = story.id

        delivery_id = f"dlv-{uuid.uuid4().hex[:8]}"
        payload = _pr_payload(
            action="opened", pr_number=1, merged=False,
            title=f"feat: work [SID:{story_id}]",
        )
        resp = await _post(payload, Session, delivery_id=delivery_id)
        assert resp.status_code == 200, resp.text

        row = await _delivery_row(Session, delivery_id)
        assert row is not None
        assert row.status == "ignored"
        assert row.skipped_reason == "no_actionable_signal"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_installation_not_registered_persists_skipped_reason():
    """②installation_not_registered_or_suspended — app source(installation.id 있음)인데
    그 installation이 DB에 없으면 이 사유가 정확히 남아야 한다."""
    engine, Session = await _session_factory()
    try:
        delivery_id = f"dlv-{uuid.uuid4().hex[:8]}"
        payload = _pr_payload(action="opened", pr_number=2, installation_id=999999)

        from app.dependencies.database import get_db
        from app.main import app as fastapi_app
        from app.routers import verdict_capture as mod

        async def override_db():
            async with Session() as s:
                yield s

        fastapi_app.dependency_overrides[get_db] = override_db
        body = json.dumps(payload).encode()
        headers = {
            "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": delivery_id,
            "X-Hub-Signature-256": _sign(body, APP_SECRET),
        }
        try:
            async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
                with patch.object(mod.settings, "github_webhook_secret", LEGACY_SECRET), \
                     patch.object(mod.settings, "github_app_webhook_secret", APP_SECRET):
                    resp = await c.post(
                        "/api/v2/internal/verdict/github-webhook", content=body, headers=headers,
                    )
        finally:
            fastapi_app.dependency_overrides.clear()
        assert resp.status_code == 200, resp.text

        row = await _delivery_row(Session, delivery_id)
        assert row is not None
        assert row.status == "ignored"
        assert row.skipped_reason == "installation_not_registered_or_suspended"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_processed_delivery_has_null_skipped_reason():
    """⭐뮤테이션 대응 축 — status="processed"일 땐 skipped_reason이 항상 None이어야 한다
    (이전 delivery의 값이 실수로 남는 사고를 막는다 — 매 요청 값을 명시적으로 갱신해야 함)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
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
            story_id = story.id

        delivery_id = f"dlv-{uuid.uuid4().hex[:8]}"
        payload = _pr_payload(
            action="closed", pr_number=3, merged=True,
            title=f"feat: work [SID:{story_id}]",
        )
        resp = await _post(payload, Session, delivery_id=delivery_id)
        assert resp.status_code == 200, resp.text

        row = await _delivery_row(Session, delivery_id)
        assert row is not None
        assert row.status == "processed"
        assert row.skipped_reason is None
    finally:
        await engine.dispose()

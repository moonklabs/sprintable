"""E-UI-DAEGBYEON P0-05 후속(story 174be6bc·doc scope-violation-signal-design) — scope-violation
신호 실체화 realdb 통합. 실 PG.

크루=3중 침묵 조건(①미선언 ②fetch실패 ③전원범위내)·synchronize 재판정·evidence dict-merge
비파괴·cross-org 미해소·trust_pipeline 배선(has_scope_violation→derive_exception_signals).
GitHub API(fetch_pr_changed_files)·installation 토큰은 patch(네트워크 0 접촉).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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


async def _seed(session, *, declared_scope_paths=None, org_id=None):
    from app.models.github_installation import GithubInstallation
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = org_id
    if org is None:
        o = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
        session.add(o)
        await session.commit()
        org = o.id

    project = Project(id=uuid.uuid4(), org_id=org, name="P")
    session.add(project)
    await session.commit()

    story = Story(
        id=uuid.uuid4(), org_id=org, project_id=project.id, title="S",
        status="in-progress", declared_scope_paths=declared_scope_paths,
    )
    session.add(story)
    await session.commit()

    inst = (
        await session.execute(
            __import__("sqlalchemy").select(GithubInstallation).where(GithubInstallation.org_id == org)
        )
    ).scalar_one_or_none()
    if inst is None:
        inst = GithubInstallation(
            id=uuid.uuid4(), org_id=org, installation_id=90000 + abs(hash(str(org))) % 1000,
            account_login="moonklabs", account_type="Organization", suspended_at=None,
        )
        session.add(inst)
        await session.commit()

    return {"org_id": org, "project_id": project.id, "story_id": story.id, "installation_id": inst.installation_id}


def _delivery(source="app"):
    from app.models.github_installation import GithubWebhookDelivery
    return GithubWebhookDelivery(
        id=uuid.uuid4(), source=source, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
        event="pull_request", status="received",
    )


def _pr_payload(*, action, story_id, installation_id, pr_number=1, repo="moonklabs/sprintable"):
    return {
        "action": action,
        "installation": {"id": installation_id},
        "repository": {"full_name": repo},
        "pull_request": {
            "number": pr_number,
            "title": f"feat: work [SID:{story_id}]",
            "body": "",
            "merged": False,
            "head": {"sha": "sha1", "ref": "feat-branch"},
        },
    }


async def _process(session, payload, installation_id, *, changed_files):
    """공통 헬퍼 — installation 토큰·changed-files fetch만 patch(네트워크 0)."""
    from app.routers import verdict_capture as mod

    with patch.object(mod, "get_installation_token", new=AsyncMock(return_value="tok")), \
         patch.object(mod, "fetch_pr_changed_files", new=AsyncMock(return_value=changed_files)):
        result, status_label = await mod._process_webhook_event(
            session, "app", "pull_request", payload, installation_id, _delivery(),
        )
        await session.commit()
    return result, status_label


async def _link_evidence(session, org_id, story_id):
    from app.models.pull_request_story_link import PullRequestStoryLink
    from sqlalchemy import select
    link = (
        await session.execute(
            select(PullRequestStoryLink).where(
                PullRequestStoryLink.org_id == org_id, PullRequestStoryLink.story_id == story_id,
            )
        )
    ).scalar_one_or_none()
    return link


# ── 선언+이탈=true ────────────────────────────────────────────────────────────

async def test_declared_and_out_of_scope_file_violates():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, declared_scope_paths=["backend/app/routers/stories.py"])
        async with Session() as s:
            payload = _pr_payload(action="opened", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
            result, status_label = await _process(s, payload, seeded["installation_id"], changed_files=["backend/app/other.py"])
        assert status_label == "processed"
        assert result["scope_check"] == {"violated": True, "out_of_scope_files": ["backend/app/other.py"]}

        async with Session() as s:
            link = await _link_evidence(s, seeded["org_id"], seeded["story_id"])
            assert link is not None
            assert link.evidence["scope_check"]["violated"] is True
            assert link.evidence["scope_check"]["out_of_scope_files"] == ["backend/app/other.py"]

        # trust_pipeline 배선 확인 — has_scope_violation=True → derive_exception_signals 반영.
        async with Session() as s:
            from app.services.trust_pipeline import compute_trust_facts, derive_exception_signals
            facts = await compute_trust_facts(s, seeded["org_id"], seeded["story_id"])
            assert facts.has_scope_violation is True
            assert derive_exception_signals(facts)["scope_violation"] is True
    finally:
        await engine.dispose()


# ── 3중 침묵 조건 ─────────────────────────────────────────────────────────────

async def test_silence_no_declaration_skips_fetch_entirely():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, declared_scope_paths=None)
        async with Session() as s:
            from app.routers import verdict_capture as mod
            fetch_mock = AsyncMock(return_value=["irrelevant.py"])
            with patch.object(mod, "get_installation_token", new=AsyncMock(return_value="tok")), \
                 patch.object(mod, "fetch_pr_changed_files", new=fetch_mock):
                payload = _pr_payload(action="opened", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
                result, status_label = await mod._process_webhook_event(
                    s, "app", "pull_request", payload, seeded["installation_id"], _delivery(),
                )
                await s.commit()
            fetch_mock.assert_not_awaited()  # 침묵① — fetch 자체를 안 함.
        assert "scope_check" not in result
        assert status_label == "ignored"  # 다른 액션가능신호도 없어 순수 ignore.

        async with Session() as s:
            link = await _link_evidence(s, seeded["org_id"], seeded["story_id"])
            assert link is None  # 행 자체가 생성 안 됨.
    finally:
        await engine.dispose()


async def test_silence_fetch_failure_writes_nothing():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, declared_scope_paths=["backend/app/**"])
        async with Session() as s:
            payload = _pr_payload(action="synchronize", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
            result, status_label = await _process(s, payload, seeded["installation_id"], changed_files=None)
        assert "scope_check" not in result
        async with Session() as s:
            link = await _link_evidence(s, seeded["org_id"], seeded["story_id"])
            assert link is None  # 판정불가는 추측 금지 — 행도 안 남김.
    finally:
        await engine.dispose()


async def test_silence_all_files_in_scope_violated_false():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, declared_scope_paths=["backend/app/**"])
        async with Session() as s:
            payload = _pr_payload(action="opened", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
            result, _ = await _process(s, payload, seeded["installation_id"], changed_files=["backend/app/x.py"])
        assert result["scope_check"] == {"violated": False, "out_of_scope_files": []}
        async with Session() as s:
            link = await _link_evidence(s, seeded["org_id"], seeded["story_id"])
            assert link is not None
            assert link.evidence["scope_check"]["violated"] is False
    finally:
        await engine.dispose()


# ── synchronize 재판정 ────────────────────────────────────────────────────────

async def test_synchronize_rejudges_and_updates_same_link_row():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, declared_scope_paths=["backend/app/**"])

        async with Session() as s:
            payload = _pr_payload(action="opened", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
            r1, _ = await _process(s, payload, seeded["installation_id"], changed_files=["backend/app/x.py"])
        assert r1["scope_check"]["violated"] is False

        async with Session() as s:
            payload = _pr_payload(action="synchronize", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
            r2, _ = await _process(s, payload, seeded["installation_id"], changed_files=["backend/app/x.py", "frontend/y.ts"])
        assert r2["scope_check"]["violated"] is True

        async with Session() as s:
            from sqlalchemy import select
            from app.models.pull_request_story_link import PullRequestStoryLink
            rows = (
                await s.execute(
                    select(PullRequestStoryLink).where(
                        PullRequestStoryLink.org_id == seeded["org_id"],
                        PullRequestStoryLink.story_id == seeded["story_id"],
                    )
                )
            ).scalars().all()
            assert len(rows) == 1  # 재판정=같은 행 갱신(신규 행 중복 생성 아님).
            assert rows[0].evidence["scope_check"]["violated"] is True
    finally:
        await engine.dispose()


# ── evidence dict-merge 비파괴 ────────────────────────────────────────────────

async def test_existing_evidence_keys_preserved_on_merge():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, declared_scope_paths=["backend/app/**"])
            from app.services.pr_story_link import upsert_link
            await upsert_link(
                s, seeded["org_id"], seeded["story_id"], "moonklabs/sprintable", 1,
                link_source="explicit", confidence="high", evidence={"by": "explicit_api"},
            )
            await s.commit()

        async with Session() as s:
            payload = _pr_payload(action="opened", story_id=seeded["story_id"], installation_id=seeded["installation_id"])
            await _process(s, payload, seeded["installation_id"], changed_files=["backend/app/other_out.py"])

        async with Session() as s:
            link = await _link_evidence(s, seeded["org_id"], seeded["story_id"])
            assert link.evidence["by"] == "explicit_api"  # 기존 키 보존.
            assert "scope_check" in link.evidence          # 신규 키 병합.
    finally:
        await engine.dispose()


# ── cross-org 미해소 ──────────────────────────────────────────────────────────

async def test_cross_org_story_not_resolved_no_scope_check():
    """installation=org_a인데 SID가 org_b story를 가리키면 org-scoped resolver가 미해소 — scope-check 0."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.organization import Organization
            org_a = Organization(id=uuid.uuid4(), name="A", slug=f"a-{uuid.uuid4().hex[:8]}")
            org_b = Organization(id=uuid.uuid4(), name="B", slug=f"b-{uuid.uuid4().hex[:8]}")
            s.add_all([org_a, org_b])
            await s.commit()
            seeded_a = await _seed(s, org_id=org_a.id)  # installation for org_a
            seeded_b = await _seed(s, declared_scope_paths=["backend/app/**"], org_id=org_b.id)

        async with Session() as s:
            payload = _pr_payload(
                action="opened", story_id=seeded_b["story_id"], installation_id=seeded_a["installation_id"],
            )
            result, status_label = await _process(
                s, payload, seeded_a["installation_id"], changed_files=["backend/app/other.py"],
            )
        assert "scope_check" not in result
        assert result.get("skipped_reason") in ("story_not_found", "no_sid_tag")

        async with Session() as s:
            link = await _link_evidence(s, seeded_b["org_id"], seeded_b["story_id"])
            assert link is None
    finally:
        await engine.dispose()

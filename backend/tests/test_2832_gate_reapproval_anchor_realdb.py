"""story #2832(CRITICAL, PO 페드루 배정 2026-08-20) — «재-pending 후 재승인»이 approved_head_sha를
못 찍어 success 발행이 영구 skip되는 결함의 회귀 테스트.

실 사고(gate 38430aa8, PR#3255, 2026-08-20 07:36:06): story #2826에 PR#3252(머지 완료)·
PR#3255(잔류 fix, 진행 중) 두 PR 링크 행이 공존 — `resolve_pr_link`가 story_id만으로 "가장 최근
updated_at" 행 하나를 뽑는데, 07:14:09 explicit-link 호출(`upsert_link`, evidence **전체 교체**)이
head_sha 없는 얕은 evidence로 PR#3255 링크 행을 갱신해 그 행이 "가장 최근"이 됐다. 그 결과 07:36:06
재승인이 anchor를 못 찍고(`approved_head_sha=None` 그대로), 배경 발행이 "approved인데 anchor
없음"으로 fail-closed skip — check success가 영원히 안 뜬다.

fix(gates.py transition_gate_endpoint): anchor 1순위를 `gate.github_check_run_sha`로 바꿨다 — 이
필드는 story-스코프 다중-PR 모호성과 무관하게 **이 gate 자신**이 마지막으로 발행한 check-run의
SHA만 담으므로(publish_gate_check가 매 발행 시 갱신) 항상 정확하다. story 링크 조회(옛 로직)는
그 필드가 아예 빈 legacy 상태에만 폴백."""
from __future__ import annotations

import os
import uuid

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
async def test_realdb_reapproval_anchors_to_gate_tracked_sha_not_stale_link_evidence():
    """실 사고 재현: story에 PR 링크 행이 둘(머지된 옛 PR + 진행 중 새 PR), 새 PR 쪽 evidence는
    explicit-link 전체교체로 head_sha가 비어있다 — gate.github_check_run_sha(새 PR의 실제 SHA)가
    이 모호성과 무관하게 anchor로 쓰여야 한다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.pull_request_story_link import PullRequestStoryLink
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    SHA_OLD_MERGED_PR = "sha-old-merged-pr"
    SHA_CURRENT_PR = "sha-current-pr-tracked-by-gate"

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="재-pending 후 재승인 anchor 회귀",
            )
            s.add(story)
            await s.commit()

            # 옛 PR(이미 머지) 링크 — head_sha 보존돼 있음(정상 케이스라면 이게 정본이 아니어야 함).
            link_old = PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story.id,
                repo_full_name="acme/repo", pr_number=1, link_source="sid", confidence="high",
                evidence={"head_sha": SHA_OLD_MERGED_PR, "webhook_merge": {"recorded_at": "2026-08-20T05:22:49Z"}},
            )
            s.add(link_old)
            await s.commit()

            # 새 PR(진행 중) 링크 — explicit-link 전체교체로 head_sha 없는 얕은 evidence, 옛 PR
            # 행보다 나중에 갱신돼 "가장 최근"이 된다(resolve_pr_link가 이걸 고르면 옛 로직은 실패).
            link_new = PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story.id,
                repo_full_name="acme/repo", pr_number=2, link_source="explicit", confidence="high",
                evidence={"by": "explicit_api"},
            )
            s.add(link_new)
            await s.commit()

            # gate: 재-pending 직후 상태 — approved_head_sha는 reopen에서 이미 None으로 클리어됐고,
            # github_check_run_sha는 새 PR의 웹훅 발행이 이미 정확히 찍어 둔 값(publish_gate_check
            # 자체 로직, 이 테스트의 관심사 밖이라 직접 seed).
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=90099, github_check_run_sha=SHA_CURRENT_PR,
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={
                    "status": "approved", "note": "재승인 anchor 회귀 확인", "evidence_viewed": True,
                    "reviewed_head_sha": SHA_CURRENT_PR,  # story #2975 — PO가 review한 SHA 필수 대조.
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "approved", body
            assert body["approved_head_sha"] == SHA_CURRENT_PR, (
                f"anchor가 gate.github_check_run_sha({SHA_CURRENT_PR})가 아니라 "
                f"story-스코프 링크 모호성에 휘둘렸다: {body.get('approved_head_sha')!r}"
            )
            assert body["approved_head_sha"] != SHA_OLD_MERGED_PR

            recheck = await client.get(f"/api/v2/gates/{gate_id}")
            assert recheck.status_code == 200, recheck.text
            assert recheck.json()["approved_head_sha"] == SHA_CURRENT_PR
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_approve_falls_back_to_link_evidence_when_no_check_run_yet():
    """폴백 보존 확인: gate가 아직 어떤 check-run도 추적한 적 없으면(github_check_run_sha=None —
    #2813 이전 legacy 상태 등) 옛 경로(링크 evidence)로 여전히 anchor를 찍는다(회귀 없음)."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.pull_request_story_link import PullRequestStoryLink
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    SHA_FROM_LINK = "sha-from-link-evidence"

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="legacy 폴백 회귀",
            )
            s.add(story)
            await s.commit()

            link = PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story.id,
                repo_full_name="acme/repo", pr_number=9, link_source="sid", confidence="high",
                evidence={"head_sha": SHA_FROM_LINK},
            )
            s.add(link)
            await s.commit()

            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=None, github_check_run_sha=None,
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved", "note": "legacy 폴백 확인", "evidence_viewed": True},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["approved_head_sha"] == SHA_FROM_LINK, resp.json()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

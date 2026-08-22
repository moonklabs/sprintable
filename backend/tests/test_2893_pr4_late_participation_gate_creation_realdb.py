"""story #2893 후속(카디르 4라운드 verdict, PR#3357 qa:changes) — 순서 조합 갭.

참여등록이 라벨정렬보다 **늦으면**: opened(참여 無)→라벨정렬(PR④ 트리거는 실행되나
evaluate_merge_gate가 "no implementation participation"으로 gate_id=None 즉시반환)→
참여등록(재평가 훅 0)→이후 이벤트 없음 → 게이트 row가 영구 미생성된다(2893 원 증상이
이 순서에선 그대로 재현 — B3 재평가 API도 gate id가 없어 호출 불가).

처방: 참여 생성 공유 chokepoint(`ensure_implementation_participation` — assignee 자동참여·
story claim 양쪽 공유·`add_participation` 라우터 직접 생성)에 게이트 재평가 훅을 추가.
PR④의 기존 5건은 전부 참여 선시딩이라 이 "참여 後시딩" 순서를 커버하지 못했다 — 이 파일이
그 정확한 순서로 재현한다.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from tests.test_2893_gate_pr_scoped_isolation_realdb import (
    _post_app,
    _seed_installation,
    _seed_link,
    _session_factory,
)

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _labeled_payload(*, pr_number, installation_id, head_sha, labels):
    return {
        "action": "labeled",
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": "chore: unrelated", "body": "", "merged": False,
            "head": {"sha": head_sha, "ref": f"feat-branch-{pr_number}"},
            "labels": [{"name": name} for name in labels],
        },
    }


def _opened_payload(*, pr_number, installation_id, head_sha):
    return {
        "action": "opened",
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": "chore: unrelated", "body": "", "merged": False,
            "head": {"sha": head_sha, "ref": f"feat-branch-{pr_number}"},
            "labels": [],
        },
    }


async def _seed_org_project_story_no_role(s):
    """with_participation=False(test_2893_gate_pr_scoped_isolation_realdb)는 role조차 안
    만든다 — 이 파일은 "role은 있는데 participation만 나중에 생기는" 정확한 순서가 필요해
    role만 먼저 시드하는 별도 헬퍼를 쓴다."""
    from app.models.organization import Organization
    from app.models.participation import ParticipationRole
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
    role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="implementation", label="Impl", is_default=True)
    s.add(role)
    await s.commit()
    return org, project, story


async def _gates_for_story(s, story_id):
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    rows = (
        await s.execute(
            select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE)
        )
    ).scalars().all()
    return rows


def _live_pr_patches(*, head_sha="sha-late-1", ci_result="success"):
    # trigger_gate_creation_for_late_participation은 함수 내부(local import)에서
    # app.services.github_app/verdict_capture를 직접 불러온다 — patch 대상은 그 원본
    # 모듈(merge_verdict_gate의 재노출 이름이 아님, local import는 attribute lookup을
    # merge_verdict_gate 네임스페이스에 만들지 않는다).
    return (
        patch("app.services.github_app.get_installation_token", AsyncMock(return_value="inst-tok")),
        patch(
            "app.services.github_app.get_pull_request",
            AsyncMock(return_value={"head": {"sha": head_sha}, "merged": False}),
        ),
        patch(
            "app.services.verdict_capture.fetch_status_check_rollup",
            AsyncMock(return_value=(ci_result, None)),
        ),
    )


@pytest.mark.anyio
async def test_late_participation_after_opened_and_labeled_creates_missing_gate():
    """핵심 재현 — opened→labeled(둘 다) 순서에서 참여가 없어 게이트가 안 생기고, 나중에
    참여가 생기면 그 계기로 게이트가 생겨야 한다."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=680601)
            await _seed_link(s, org, story, pr_number=601)
            story_id = story.id

        # 1) opened — 참여 無 → 게이트 미생성.
        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 96001}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _opened_payload(pr_number=601, installation_id=680601, head_sha="sha-late-1"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        async with Session() as s:
            assert len(await _gates_for_story(s, story_id)) == 0, "참여 無 — 아직 게이트 없어야 함(전제)"

        # 2) labeled(둘 다) — 여전히 참여 無 → 여전히 게이트 미생성(PR④ 트리거는 타지만
        #    evaluate_merge_gate가 no-participation으로 조기반환).
        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 96002}),
        ), patch("app.core.database.async_session_factory", Session):
            await _post_app(
                _labeled_payload(
                    pr_number=601, installation_id=680601, head_sha="sha-late-1",
                    labels=["qa:pass", "design:pass"],
                ),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
        async with Session() as s:
            assert len(await _gates_for_story(s, story_id)) == 0, "라벨정렬로도 참여 無면 여전히 없어야 함(전제)"

        # 3) 참여 등록(늦게) — 이 훅이 갭을 메워야 한다. 훅은 호출자 세션(s)을 그대로 쓴다
        #    (카디르 QA② — SAVEPOINT 격리, 별도 세션 아님. read-your-own-write 유지).
        p1, p2, p3 = _live_pr_patches(head_sha="sha-late-1", ci_result="success")
        async with Session() as s:
            with p1, p2, p3:
                ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
                await s.commit()
            assert ok is True

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1, "참여등록이 늦어도 그 계기로 게이트가 생겨야 함(2893 원 증상 재발방지)"
            assert gates[0].pr_number == 601
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_add_participation_endpoint_also_triggers_gate_creation():
    """라우터 배선 확인 — POST /api/v2/participation(직접 생성 경로)도 동일 훅을 태운다."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=680602)
            await _seed_link(s, org, story, pr_number=602)
            story_id = story.id

            from app.models.project import OrgMember
            from app.models.project_access import ProjectAccess
            from app.models.user import User

            caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(caller)
            await s.commit()
            caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
            s.add(caller_om)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
                permission="granted", role="member",
            ))
            await s.commit()

            from app.models.participation import ParticipationRole
            role = (
                await s.execute(
                    select(ParticipationRole).where(ParticipationRole.org_id == org.id, ParticipationRole.is_default.is_(True))
                )
            ).scalar_one()
            role_id = role.id
            caller_id = caller.id

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(caller_id), email="caller@test", claims={"app_metadata": {}})

        async def _org():
            return org.id

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            p1, p2, p3 = _live_pr_patches(head_sha="sha-late-2", ci_result="success")
            with p1, p2, p3:
                resp = await client.post(
                    "/api/v2/participation",
                    json={"story_id": str(story_id), "member_id": str(uuid.uuid4()), "role_id": str(role_id)},
                )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1, "add_participation 라우터도 게이트 생성 훅을 태워야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_participation_hook_noop_when_no_pr_linked():
    """링크된 PR이 없으면(board-preflight 전용 story 등) 조용히 no-op — 크래시도, 지어낸
    게이트도 없어야 한다."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            story_id = story.id

        async with Session() as s:
            ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
            await s.commit()
        assert ok is True

        async with Session() as s:
            assert len(await _gates_for_story(s, story_id)) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_participation_hook_noop_when_gate_already_exists():
    """게이트가 이미 있으면(1차 트리거가 이미 만들어 둔 정상 케이스) 참여가 나중에 추가돼도
    중복 행을 만들면 안 된다."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=680603)
            await _seed_link(s, org, story, pr_number=603)
            story_id = story.id

            # 1차 트리거가 이미 만들어 둔 상태를 직접 시드(참여가 처음부터 있었던 정상 경로 모사).
            from app.models.gate import Gate
            from app.services.merge_verdict_gate import MERGE_GATE_TYPE

            s.add(Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story_id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending", pr_number=603,
            ))
            await s.commit()

        async with Session() as s:
            ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
            await s.commit()
        assert ok is True

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1, "이미 있던 게이트를 중복 생성하면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_one_pr_failure_does_not_block_other_pr_gate_creation():
    """카디르 QA②-①(PR#3357 재재verdict) — link별 예외 격리. 같은 스토리에 링크된 PR 2개
    중 하나(701) 처리가 실패해도, 다른 하나(702)는 정상적으로 게이트를 받아야 한다(예전엔
    전체를 감싼 단일 try가 첫 실패에서 나머지 링크 처리를 통째로 건너뛰었다)."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=680701)
            await _seed_link(s, org, story, pr_number=701)
            await _seed_link(s, org, story, pr_number=702)
            story_id = story.id

        async def _get_pr_fails_for_701(installation_id, repo_full_name, pr_number):
            if pr_number == 701:
                raise RuntimeError("simulated GitHub fetch failure for PR 701")
            return {"head": {"sha": "sha-702"}, "merged": False}

        async with Session() as s:
            with (
                patch("app.services.github_app.get_installation_token", AsyncMock(return_value="inst-tok")),
                patch("app.services.github_app.get_pull_request", new=_get_pr_fails_for_701),
                patch(
                    "app.services.verdict_capture.fetch_status_check_rollup",
                    AsyncMock(return_value=("success", None)),
                ),
            ):
                ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
                await s.commit()
        assert ok is True

        async with Session() as s:
            gates = {g.pr_number: g for g in await _gates_for_story(s, story_id)}
            assert 702 in gates, "701 처리가 실패해도 702는 정상적으로 게이트를 받아야 함(link별 격리)"
            assert 701 not in gates, "701 자체는 실패했으니 게이트가 없어야 함(지어내지 않음)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_link_failure_does_not_poison_session_participation_still_commits():
    """카디르 QA②-②(PR#3357 재재verdict) — 세션 오염 차단. 훅 내부에서 **실 DB 레벨 에러**
    (Postgres division_by_zero — mock이 아니라 진짜 DBAPI 에러라야 세션이 실제로 오염된다)가
    나도 호출자 세션이 오염되면 안 된다 — SAVEPOINT 격리 덕에 참여 등록 자체(호출자의
    flush·commit)는 여전히 성공해야 한다는 것을 직접 증명한다."""
    from app.services.participation_helpers import ensure_implementation_participation

    async def _evaluate_merge_gate_with_real_db_error(session, org_id, story_id, **kwargs):
        from sqlalchemy import text
        await session.execute(text("SELECT 1/0"))  # 실 Postgres division_by_zero — 진짜 세션 오염.

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=680703)
            await _seed_link(s, org, story, pr_number=703)
            story_id = story.id

        member_id = uuid.uuid4()
        p1, p2 = _live_pr_patches(head_sha="sha-703", ci_result="success")[:2]
        async with Session() as s:
            with (
                p1, p2,
                patch(
                    "app.services.merge_verdict_gate.evaluate_merge_gate",
                    new=_evaluate_merge_gate_with_real_db_error,
                ),
            ):
                ok = await ensure_implementation_participation(s, org.id, story_id, member_id)
                # 핵심 단언: 훅이 실 DB 에러를 만났어도, 이 commit 자체가 안 죽어야 한다
                # (PendingRollbackError 등으로 여기서 raise되면 세션이 오염됐다는 뜻).
                await s.commit()
            assert ok is True

        async with Session() as s:
            from app.models.participation import Participation

            rows = (
                await s.execute(select(Participation).where(Participation.story_id == story_id))
            ).scalars().all()
            assert len(rows) == 1 and rows[0].member_id == member_id, (
                "참여 행이 실제로 커밋돼 있어야 함(세션 오염이 없었다는 최종 증거)"
            )
            assert len(await _gates_for_story(s, story_id)) == 0, "실패한 evaluate_merge_gate가 게이트를 만들면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_soft_deleted_link_is_not_revived_by_late_participation():
    """카디르 QA②-③(PR#3357 재재verdict) — soft-delete 필터. 사용자가 명시로 끊은 연결
    (deleted_at 有)은 참여등록이 늦게 와도 되살아나면 안 된다."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=680704)
            story_id = story.id

            from datetime import datetime, timezone

            from app.models.pull_request_story_link import PullRequestStoryLink

            s.add(PullRequestStoryLink(
                id=uuid.uuid4(), org_id=org.id, story_id=story_id,
                repo_full_name="moonklabs/sprintable", pr_number=704,
                link_source="explicit", confidence="high",
                deleted_at=datetime.now(timezone.utc),
            ))
            await s.commit()

        p1, p2, p3 = _live_pr_patches(head_sha="sha-704", ci_result="success")
        async with Session() as s:
            with p1, p2, p3:
                ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
                await s.commit()
        assert ok is True

        async with Session() as s:
            assert len(await _gates_for_story(s, story_id)) == 0, "soft-delete된 링크는 부활하면 안 됨"
    finally:
        await engine.dispose()

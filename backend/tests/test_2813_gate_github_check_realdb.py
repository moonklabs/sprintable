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


async def _seed(
    session, *, gate_status="pending", approved_head_sha=None,
    github_check_run_id=None, github_check_run_sha=None,
):
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
        github_check_run_sha=github_check_run_sha,
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
            # github_check_run_sha를 발행 대상 head_sha와 동일하게 시드해야(카디르 QA③-c 이후)
            # PATCH(update_check_run) 경로를 탄다 — 다르면 새 run 생성 경로로 바뀐다(정상 동작,
            # test_publish_gate_check_creates_new_run_for_different_sha_realdb가 그 축을 커버).
            # approved_head_sha도 같은 값으로 시드해야(카디르 R2 CRITICAL 이후) anchor 검증을
            # 통과한다 — 인자 head_sha만으론 더 이상 안 통과.
            seeded = await _seed(
                s, gate_status="approved", approved_head_sha="sha-approved-1",
                github_check_run_id=9001, github_check_run_sha="sha-approved-1",
            )

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

            # PO 지시(2026-08-19) — 원장 3축(published/re_pending/resolved) 완충족의 마지막
            # 조각. resolved는 gh_status=="completed"일 때만 찍힌다(_process_webhook_event와
            # 무관 — publish_gate_check 자체 로직).
            from app.models.gate_github_check_event import GateGithubCheckEvent

            events = (
                await s.execute(
                    select(GateGithubCheckEvent).where(GateGithubCheckEvent.gate_id == gate.id)
                )
            ).scalars().all()
            assert len(events) == 1
            assert events[0].event_type == "resolved"
            assert events[0].check_conclusion == "success"
            assert events[0].head_sha == "sha-approved-1"
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
            # anchor를 head_sha와 동일하게 시드(카디르 R2 이후) — anchor-missing-skip이 아니라
            # "GitHub 호출 자체가 실패"하는 이 테스트 본연의 시나리오를 타야 한다.
            seeded = await _seed(s, gate_status="approved", approved_head_sha="sha-fail-1")

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value=None),
        ), patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-fail-1", repo_full_name="acme/repo", pr_number=7,
            )

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.approved_head_sha == "sha-fail-1"  # 시드값 그대로 — 새로 오염 안 됨.
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
            # anchor를 head_sha와 동일하게 시드(카디르 R2 이후) — 예외를 실제로 일으키는
            # create_check_run 호출까지 도달해야 이 테스트가 뭘 검증하는지 의미가 있다.
            seeded = await _seed(s, gate_status="approved", approved_head_sha="sha-x")

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
async def test_publish_gate_check_skips_success_when_approved_but_anchor_missing_realdb():
    """카디르 QA③-a — approved인데 anchor(approved_head_sha)가 없으면 link.evidence로
    폴백해서 success를 발행하면 안 된다(anchor bypass). create_check_run이 아예 안 불려야 함."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.gate_github_check_event import GateGithubCheckEvent
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved", approved_head_sha=None)
            # link.evidence에 다른 SHA가 있어도(레이스로 오염된 상황 재현) 이걸 못 쓰게 막는 것이 핵심.
            from app.models.pull_request_story_link import PullRequestStoryLink

            link = (
                await s.execute(
                    select(PullRequestStoryLink).where(PullRequestStoryLink.story_id == seeded["story_id"])
                )
            ).scalar_one()
            link.evidence = {"head_sha": "sha-from-link-should-not-be-used"}
            await s.commit()

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 1}),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(seeded["org_id"], seeded["gate_id"])  # head_sha 인자 없음.

        create_mock.assert_not_awaited()

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.github_check_run_id is None
            events = (
                await s.execute(select(GateGithubCheckEvent).where(GateGithubCheckEvent.gate_id == gate.id))
            ).scalars().all()
            assert events == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_creates_new_run_for_different_sha_realdb():
    """카디르 QA③-c — 기존 check-run이 다른 SHA(github_check_run_sha)에 대한 것이면 PATCH가
    아니라 새 run을 만든다(같은 run을 다른 SHA로 옮기면 required check가 그 SHA에서 영영 안 생김)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(
                s, gate_status="pending",
                github_check_run_id=9001, github_check_run_sha="sha-old",
            )

        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 9002}),
        ) as create_mock, patch(
            "app.services.gate_github_check.update_check_run", AsyncMock(),
        ) as update_mock, patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-new", repo_full_name="acme/repo", pr_number=7,
            )

        create_mock.assert_awaited_once()  # 새 run 생성 — PATCH 아님.
        update_mock.assert_not_awaited()

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.github_check_run_id == 9002
            assert gate.github_check_run_sha == "sha-new"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_updates_existing_run_for_same_sha_realdb():
    """양성대조 — 같은 SHA면 여전히 PATCH(새 run 남발 안 함)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(
                s, gate_status="pending",
                github_check_run_id=9001, github_check_run_sha="sha-same",
            )

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(),
        ) as create_mock, patch(
            "app.services.gate_github_check.update_check_run",
            AsyncMock(return_value={"id": 9001}),
        ) as update_mock, patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-same", repo_full_name="acme/repo", pr_number=7,
            )

        update_mock.assert_awaited_once()
        create_mock.assert_not_awaited()

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.github_check_run_id == 9001
            assert gate.github_check_run_sha == "sha-same"
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
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "new-sha", repo_full_name="acme/repo", pr_number=7)
            await s.commit()

        assert flipped is True

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            assert gate.status == "pending"
            assert gate.approved_head_sha is None
            assert gate.github_check_run_id is None  # 새 SHA는 새 check-run(§2-2).
            assert gate.github_check_run_sha is None

        # 미르코군 그라운딩(doc gate-github-check-fe-grounding-2814 §3) 적출 — re_pending 원장
        # 행이 실제로 남는지(구 코드는 상태만 리셋하고 원장은 전혀 안 씀).
        async with Session() as s:
            from sqlalchemy import select

            from app.models.gate_github_check_event import GateGithubCheckEvent

            events = (
                await s.execute(
                    select(GateGithubCheckEvent).where(GateGithubCheckEvent.gate_id == seeded["gate_id"])
                )
            ).scalars().all()
            assert len(events) == 1
            assert events[0].event_type == "re_pending"
            assert events[0].head_sha == "new-sha"
            assert events[0].check_conclusion is None
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
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "same-sha", repo_full_name="acme/repo", pr_number=7)

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
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "any-sha", repo_full_name="acme/repo", pr_number=7)

        assert flipped is False
    finally:
        await engine.dispose()


# ── 카디르 QA(PR#3243, 2026-08-19) 레이스 회귀 — 실 재현 시나리오 ──────────────────────
#
# ①사람 승인(SHA A) 커밋 ②publish 태스크 실행 前 새 커밋(B)의 synchronize 도착
# ③(구 코드) anchor가 아직 None이라 reopen 스킵 ④웹훅이 link.evidence.head_sha를 B로 갱신
# ⑤뒤늦은 승인-publish가 B를 읽어 success 발행 — "A 승인이 B를 축복"하는 사고.
# fix①(gates.py, 승인 트랜잭션에서 anchor 즉시 기록)+fix②(reopen이 anchor 없어도 재-pending)로
# 막힌다 — 아래 두 테스트가 그 닫힘을 실측한다.


@pytest.mark.anyio
async def test_race_approval_background_task_uses_anchor_not_stale_link_evidence_realdb():
    """fix① 실측 — gates.py가 승인 트랜잭션에서 이미 `approved_head_sha=A`를 박아둔 상태를
    시뮬레이션(라우터 레벨 재현은 무거워 서비스 레벨에서 그 결과 상태로 시작). 그 사이 synchronize
    가 link.evidence.head_sha를 B로 먼저 덮어써도(레이스 그대로 재현), 뒤늦게 도는 승인-publish
    (head_sha 인자 없음 — gates.py 배경 태스크 호출 시그니처와 동일)는 **anchor(A)를 그대로 써야
    한다** — B를 읽어 success를 발행하면(구 버그) 이 테스트가 실패한다."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.pull_request_story_link import PullRequestStoryLink
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            # fix①이 승인 트랜잭션에서 이미 확정했다고 가정하는 상태 그대로 시드.
            seeded = await _seed(s, gate_status="approved", approved_head_sha="sha-A")

        # 레이스 재현: synchronize 웹훅이 승인-publish보다 먼저 link.evidence를 B로 덮어씀.
        async with Session() as s:
            link = (
                await s.execute(
                    select(PullRequestStoryLink).where(PullRequestStoryLink.story_id == seeded["story_id"])
                )
            ).scalar_one()
            link.evidence = {"head_sha": "sha-B"}
            await s.commit()

        # 뒤늦게 도는 승인-publish(gates.py 배경 태스크 — head_sha 인자 없이 호출).
        with patch(
            "app.services.gate_github_check.create_check_run",
            AsyncMock(return_value={"id": 7001}),
        ) as create_mock, patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(seeded["org_id"], seeded["gate_id"])

        # ⭐핵심 단언 — B가 아니라 A에 success가 발행돼야 한다.
        assert create_mock.call_args.args[1:3] == ("acme/repo", "sha-A")

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            assert gate.approved_head_sha == "sha-A"  # B로 오염 안 됨.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_race_reopen_fail_closed_when_anchor_missing_despite_approved_realdb():
    """fix② 실측 — anchor(approved_head_sha)가 비어있는데 status=approved인 legacy/이상 상태에서
    synchronize가 오면, 구 코드(`if not gate.approved_head_sha: return False`)는 침묵 스킵했지만
    fix 後엔 **재-pending 쪽으로**(fail-closed) 판정해야 한다."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved", approved_head_sha=None)

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            flipped = await reopen_gate_if_new_sha(s, seeded["org_id"], gate, "sha-new", repo_full_name="acme/repo", pr_number=7)
            await s.commit()

        assert flipped is True  # 구 코드라면 False(침묵 스킵)였을 것.

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            assert gate.status == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_r2_critical_webhook_explicit_head_sha_mismatch_never_bypasses_anchor_realdb():
    """카디르 R2 CRITICAL(2026-08-19, 코드 추적 재확認) — 이전 fix는 anchor 우선을
    "head_sha 인자가 None일 때만" 적용해서, **항상 head_sha를 명시 전달하는 웹훅 경로**
    (verdict_capture.py의 gate_check_publish outparam)가 그 검증을 통째로 우회했다. 이 테스트가
    바로 그 경로를 재현한다 — 웹훅이 anchor(A)와 다른 head_sha(B)를 명시로 넘겨도 success가
    발행되면 안 된다(그 상황은 재-pending 영역)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.gate_github_check_event import GateGithubCheckEvent
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="approved", approved_head_sha="sha-A")

        with patch(
            "app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 1}),
        ) as create_mock, patch(
            "app.services.gate_github_check.update_check_run", AsyncMock(),
        ) as update_mock, patch("app.core.database.async_session_factory", Session):
            # 웹훅 경로와 동일한 호출 형태 — head_sha를 **명시로** 넘긴다(다른 SHA).
            await publish_gate_check(
                seeded["org_id"], seeded["gate_id"],
                head_sha="sha-B", repo_full_name="acme/repo", pr_number=7,
            )

        # ⭐핵심 단언 — 구 코드였다면 head_sha="sha-B"가 인자로 왔으므로 anchor 검증 자체가
        # 안 돌아 create_check_run(status=completed, conclusion=success)이 그대로 호출됐을 것.
        create_mock.assert_not_awaited()
        update_mock.assert_not_awaited()

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.approved_head_sha == "sha-A"  # B로 오염 안 됨.
            events = (
                await s.execute(select(GateGithubCheckEvent).where(GateGithubCheckEvent.gate_id == gate.id))
            ).scalars().all()
            assert events == []  # 발행 자체가 안 일어났으므로 원장도 0건.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reopen_gate_if_new_sha_treats_auto_passed_same_as_approved_realdb():
    """카디르 R2 fix② — auto_passed도 approved와 동일하게 재-pending 대상이어야 한다(구 코드는
    `gate.status != "approved"`로 auto_passed를 완전히 건너뛰었다)."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, gate_status="auto_passed", approved_head_sha="sha-old")

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            flipped = await reopen_gate_if_new_sha(
                s, seeded["org_id"], gate, "sha-new", repo_full_name="acme/repo", pr_number=7,
            )
            await s.commit()

        assert flipped is True  # 구 코드라면 gate_type만 보고 status 체크에서 False였을 것.

        async with Session() as s:
            gate = await s.get(Gate, seeded["gate_id"])
            assert gate.status == "pending"
            assert gate.approved_head_sha is None
    finally:
        await engine.dispose()


# ── 카디르 R2 fix②-a — auto_passed 판정 시점 anchor 즉시 확定(merge_verdict_gate.evaluate_
# merge_gate) — test_2156_merge_gate_evidence_realdb.py의 _seed_story_with_participation/
# _gate_row 패턴을 그대로 재사용(발명 0, 이 파일 self-contained 유지 위해 로컬 복제). ──────────


async def _seed_story_with_participation(session):
    from app.models.organization import Organization
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="anchor stamp target")
    session.add(story)
    await session.commit()

    role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="dev", label="Dev", is_default=True)
    session.add(role)
    await session.commit()

    member_id = uuid.uuid4()
    participation = Participation(
        id=uuid.uuid4(), org_id=org.id, story_id=story.id, role_id=role.id, member_id=member_id,
    )
    session.add(participation)
    await session.commit()

    return {"org_id": org.id, "story_id": story.id, "member_id": member_id}


async def _gate_row_by_story(session, story_id):
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    result = await session.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == MERGE_GATE_TYPE)
    )
    return result.scalar_one_or_none()


@pytest.mark.anyio
async def test_evaluate_merge_gate_stamps_anchor_when_auto_passed_realdb():
    """카디르 R2 fix②-a — 정책이 allow_auto로 판정하면(status=auto_passed) 그 결정 트랜잭션
    에서 즉시 `approved_head_sha`가 head_sha로 확定돼야 한다(사람 승인과 동일 불변식)."""
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("allow_auto", "org_policy")),
            ):
                await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=99, repo="acme/repo", ci_result="pass", pr_result="pass",
                    head_sha="sha-auto-1",
                )
                await s.commit()

            gate = await _gate_row_by_story(s, seeded["story_id"])
            assert gate.status == "auto_passed"
            assert gate.approved_head_sha == "sha-auto-1"  # ⭐핵심 단언.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evaluate_merge_gate_no_anchor_when_head_sha_unknown_realdb():
    """양성대조 — head_sha를 모르는 호출자(board preflight류)는 anchor를 못 남긴다(발명 금지,
    None 그대로) — publish_gate_check가 그 경우 success 발행을 skip하는 것과 짝을 이룬다."""
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("allow_auto", "org_policy")),
            ):
                await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=99, repo="acme/repo", ci_result="pass", pr_result="pass",
                    # head_sha 인자 생략 — None 기본값.
                )
                await s.commit()

            gate = await _gate_row_by_story(s, seeded["story_id"])
            assert gate.status == "auto_passed"
            assert gate.approved_head_sha is None
    finally:
        await engine.dispose()

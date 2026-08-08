"""story #2156(critical) — 결재 게이트가 실사용에서 아무것도 막지 않고 열 수도 없는 문제.

그라운딩(디디, 2026-08-07):
  AC1(왜 안 막혔나) — dev live env H1_MERGE_GATE_ADVISORY=true(선생님/PO 판단 축, 이 PR 스코프 밖).
  AC2(evidence 20건 전원 insufficient) — `_preflight_merge_gate`(board PATCH→done, 팀이 실제로
    쓰는 유일한 done 경로)가 `evaluate_merge_gate(ci_result=None, pr_result=None)`을 하드코딩으로
    부른다. GitHub 웹훅은 실제로 살아 있고(dev 38,410건 전체·118 verdict 정확 기록) SID/#번호
    해소도 이미 완결(#2327, 2026-07-30)인데, `resolve_gate_from_verdict`의 `_SOURCE_TO_GATE_TYPE`
    에 ci/pr→pr_review 매핑만 있고 **merge 매핑이 없어** 그 실 증거가 merge-type 게이트엔 한 번도
    안 닿았다. 이 PR은 그 매핑 갭을 새 판정 로직 없이 `evaluate_merge_gate` 재호출로 메운다.
  AC3(축 없음 4건) — `create_gate`가 `gate.requires_human`을 애초에 대입 안 해(merge-type만
    evaluate_merge_gate가 사후에 채움) DB 컬럼 기본값 False가 non-merge gate_type에 그대로
    남았다. status는 disposition대로 정확한데 requires_human만 틀려 인박스에 안 뜬 것.
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
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


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

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Merge gate target")
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


async def _gate_row(session, story_id):
    from sqlalchemy import select

    from app.models.gate import Gate

    result = await session.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "merge")
    )
    return result.scalar_one_or_none()


@pytest.mark.anyio
async def test_board_preflight_style_call_creates_insufficient_evidence_gate_realdb():
    """근본 재현 — `_preflight_merge_gate`가 실제로 하는 그 호출(ci=None·pr_number=0)을 그대로
    재현하면 decision_basis가 정확히 "CI unknown (self-report only)"로 고정됨을 먼저 고정한다."""
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            with (
                patch(
                    "app.services.merge_verdict_gate.resolve_disposition",
                    AsyncMock(return_value=("ask", "org_policy")),
                ),
                patch(
                    "app.services.merge_verdict_gate._is_meaningfully_explicit_ask",
                    AsyncMock(return_value=True),
                ),
            ):
                decision = await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=0, repo="", ci_result=None, pr_result=None,
                )
            await s.commit()

            assert decision.reason == "CI unknown (self-report only)"
            gate = await _gate_row(s, seeded["story_id"])
            assert gate is not None
            assert gate.status == "pending"
            assert gate.evidence_status == "insufficient"
            assert gate.decision_basis == "CI unknown (self-report only)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_capture_pr_ci_verdict_alone_does_not_touch_merge_gate_confirms_root_cause_realdb():
    """⭐근본 확認(양성대조 대응) — 이 PR의 새 배선 없이(capture_pr_ci_verdict만) 실 증거를
    기록해도 merge-type 게이트는 전혀 안 바뀐다(그것이 애초에 이 스토리의 근본이었다).
    `_SOURCE_TO_GATE_TYPE`에 merge 매핑이 없다는 코드 사실을 실측으로 고정."""
    from app.services.merge_verdict_gate import evaluate_merge_gate
    from app.services.verdict_capture import capture_pr_ci_verdict

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            with (
                patch(
                    "app.services.merge_verdict_gate.resolve_disposition",
                    AsyncMock(return_value=("ask", "org_policy")),
                ),
                patch(
                    "app.services.merge_verdict_gate._is_meaningfully_explicit_ask",
                    AsyncMock(return_value=True),
                ),
            ):
                await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=0, repo="", ci_result=None, pr_result=None,
                )
            await s.commit()

            # 이 PR이 고치는 배선(reconcile_merge_gate_with_real_evidence) 없이, 실 웹훅이 매번
            # 부르던 그 함수(capture_pr_ci_verdict) 하나만으로 실 증거를 기록.
            await capture_pr_ci_verdict(
                s, org_id=seeded["org_id"], story_id=seeded["story_id"],
                pr_number=42, repo="moonklabs/sprintable", merged=True, ci_result="pass",
            )
            await s.commit()

            gate = await _gate_row(s, seeded["story_id"])
            assert gate.decision_basis == "CI unknown (self-report only)", (
                "capture_pr_ci_verdict만으로 merge 게이트가 바뀌면 안 된다 — "
                "_SOURCE_TO_GATE_TYPE에 merge 매핑이 없다는 게 이 스토리의 근본이다."
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_updates_pending_merge_gate_with_real_evidence_realdb():
    """⭐핵심 — reconcile_merge_gate_with_real_evidence가 실 ci/pr 증거로 pending merge 게이트를
    재평가한다. cold-start(outcome 표본 0<3)라 최종 decision은 여전히 ask_human이지만, 그
    reason이 "CI unknown"에서 "outcome sample insufficient"로 바뀐다 — 실 증거가 게이트에
    도달했다는 관측 가능한 증거."""
    from app.services.merge_verdict_gate import evaluate_merge_gate, reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            with (
                patch(
                    "app.services.merge_verdict_gate.resolve_disposition",
                    AsyncMock(return_value=("ask", "org_policy")),
                ),
                patch(
                    "app.services.merge_verdict_gate._is_meaningfully_explicit_ask",
                    AsyncMock(return_value=True),
                ),
            ):
                await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=0, repo="", ci_result=None, pr_result=None,
                )
                await s.commit()

                decision = await reconcile_merge_gate_with_real_evidence(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=42, repo="moonklabs/sprintable", ci_result="pass", merged=True,
                )
            await s.commit()

            assert decision is not None
            assert "CI unknown" not in decision.reason
            assert "outcome sample insufficient" in decision.reason

            # neutral_facts는 create_gate의 멱등 분기(기존 gate 재사용)가 새 값으로 안 덮는다
            # (별건 — 이 PR 스코프 밖). decision_basis/evidence_status는 evaluate_merge_gate가
            # 재평가마다 gate 객체에 직접 대입하므로 여기서 확実히 갱신된다(이게 이 fix의 계약).
            gate = await _gate_row(s, seeded["story_id"])
            assert gate.decision_basis != "CI unknown (self-report only)"
            assert gate.decision_basis == decision.reason
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_is_noop_when_no_pending_merge_gate_exists_realdb():
    """게이트가 없으면(또는 이미 terminal이면) 새로 만들지 않는다 — reconcile은 «반영»이지
    「생성」이 아니다."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            decision = await reconcile_merge_gate_with_real_evidence(
                s, seeded["org_id"], seeded["story_id"],
                pr_number=42, repo="moonklabs/sprintable", ci_result="pass", merged=True,
            )
            await s.commit()

            assert decision is None
            rows = (
                await s.execute(select(Gate).where(Gate.work_item_id == seeded["story_id"]))
            ).scalars().all()
            assert len(rows) == 0, "pending gate가 없는데 reconcile이 새 게이트를 만들었다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_gate_sets_requires_human_true_for_pending_non_merge_gate_realdb():
    """AC3 핵심 — qa/pr_review 등 merge 아닌 gate_type도 status=pending이면 requires_human=True
    가 생성 시점에 채워진다(전엔 DB 기본값 False가 그대로 남아 인박스에 안 떴다)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("ask", "org_policy")),
            ):
                gate = await create_gate(
                    s, seeded["org_id"], seeded["story_id"], "story", "qa",
                    seeded["member_id"], uuid.uuid4(),
                )
            await s.commit()

            assert gate.status == "pending"
            assert gate.requires_human is True, (
                "status=pending인데 requires_human=False — 인박스에 결재 필요로 안 뜬다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_picks_up_auto_passed_gate_with_requires_human_true_realdb():
    """⭐카디르 QA(PR#2902, 2026-08-07)② — status="pending"만 보면 "정책은 allow_auto(status=
    auto_passed)였는데 이후 self-report 재평가가 requires_human=True를 남긴" 게이트를
    reconcile이 놓친다. 이 케이스를 실제로 재현(disposition=allow_auto+pr_number>0으로
    status=auto_passed 게이트 생성 → ci=None 재평가로 requires_human=True만 남음)하고,
    reconcile이 그런 게이트도 실 증거로 갱신함을 고정한다."""
    from app.services.merge_verdict_gate import evaluate_merge_gate, reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("allow_auto", "org_policy")),
            ):
                # pr_number>0(no-substance 단축 회피) + ci=None → status=auto_passed로
                # 생성되지만 _decide()는 ci=None이라 무조건 ASK_HUMAN → requires_human=True.
                # ⚠️patch 대상은 create_gate가 실제로 부르는 gate_service.py의 자기 바인딩
                # (merge_verdict_gate.py의 no-substance 체크용 바인딩과 다르다 — pr_number>0
                # 이라 그 체크는 안 거친다).
                await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=99, repo="moonklabs/sprintable", ci_result=None, pr_result=None,
                )
                await s.commit()

                gate = await _gate_row(s, seeded["story_id"])
                assert gate.status == "auto_passed"
                assert gate.requires_human is True, "카디르가 짚은 그 불일치 상태 재현 실패"

                decision = await reconcile_merge_gate_with_real_evidence(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=99, repo="moonklabs/sprintable", ci_result="pass", merged=True,
                )
            await s.commit()

            assert decision is not None, (
                "status=='pending'만 보면 auto_passed+requires_human=True 게이트를 놓친다"
            )
            gate = await _gate_row(s, seeded["story_id"])
            assert gate.decision_basis != "CI unknown (self-report only)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_process_webhook_event_does_not_swallow_reconcile_exception():
    """⭐카디르 QA(PR#2902, 2026-08-07)③ — reconcile 실패를 이 함수 안에서 삼키면 일시 DB
    오류가 그 배달을 "processed"로 영구 커밋시켜 GitHub 재시도를 못 받는다. github_webhook
    (바깥 핸들러)이 이미 예외를 rollback+500으로 처리해 GitHub가 재시도하므로, 여기선 그대로
    올려야 한다."""
    from app.models.github_installation import GithubInstallation, GithubWebhookDelivery
    from app.routers.verdict_capture import _process_webhook_event
    from app.services.pr_story_link import ResolvedLink

    story_id = uuid.uuid4()
    org_id = uuid.uuid4()
    installation = GithubInstallation(
        id=uuid.uuid4(), installation_id=123, org_id=org_id, account_login="moonklabs",
    )
    delivery = GithubWebhookDelivery(
        id=uuid.uuid4(), source="app", delivery_id="d1", event="pull_request", status="received",
    )
    payload = {
        "repository": {"full_name": "moonklabs/sprintable"},
        "pull_request": {
            "number": 42, "merged": True, "title": "fix(#1): x",
            "head": {"ref": "fix/1-x", "sha": "abc"},
        },
        "action": "closed",
        "installation": {"id": 123},
    }

    session = AsyncMock()
    exec_result = AsyncMock()
    exec_result.scalar_one_or_none = lambda: installation
    session.execute = AsyncMock(return_value=exec_result)

    with (
        patch(
            "app.routers.verdict_capture.resolve_story_for_pr",
            AsyncMock(return_value=ResolvedLink(story_id, org_id, "sid", "high", True, "sid_exact")),
        ),
        patch(
            "app.routers.verdict_capture.capture_pr_ci_verdict",
            AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None}),
        ),
        patch("app.routers.verdict_capture.merge_link_evidence", AsyncMock()),
        patch("app.routers.verdict_capture.get_installation_token", AsyncMock(return_value=None)),
        patch(
            "app.routers.verdict_capture.reconcile_merge_gate_with_real_evidence",
            AsyncMock(side_effect=RuntimeError("transient db error")),
        ),
    ):
        with pytest.raises(RuntimeError, match="transient db error"):
            await _process_webhook_event(session, "app", "pull_request", payload, 123, delivery)


@pytest.mark.anyio
async def test_create_gate_sets_requires_human_false_for_auto_passed_gate_realdb():
    """회귀 0 — disposition=allow_auto(status=auto_passed)면 requires_human=False가 여전히
    맞다(사람이 볼 필요 없는 게 사실)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            with patch(
                "app.services.gate_service.resolve_disposition",
                AsyncMock(return_value=("allow_auto", "org_policy")),
            ):
                gate = await create_gate(
                    s, seeded["org_id"], seeded["story_id"], "story", "qa",
                    seeded["member_id"], uuid.uuid4(),
                )
            await s.commit()

            assert gate.status == "auto_passed"
            assert gate.requires_human is False
    finally:
        await engine.dispose()

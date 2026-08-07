"""story #2520([결재게이트·후속], high) — workflow_line merge-gate 경로도 웹훅 evidence
reconcile을 안 거치던 결함(#2156과 같은 근본의 라인 게이트판).

그라운딩(디디, 2026-08-08): `workflow_line_engine._merge_gate_wrapper`는 H1과 완전히 별개인
`line_merge_gate_active()`(runtime_mode+published_config rollout_mode+step 매칭)로 활성
판정하지만, `evaluate_merge_gate()`를 그대로 호출해 **동일한** `gate_type="merge"` Gate row를
만든다(evaluate_merge_gate가 H1/라인 두 트리거의 단일 chokepoint, merge_verdict_gate.py 주석
"3 트리거(board preflight·report-done·line-engine) 모두 이 단일 chokepoint를 거쳐 일관 적용"
그대로). 그런데 웹훅 핸들러(`_process_webhook_event`)는 `reconcile_merge_gate_with_real_
evidence` 호출을 `merge_gate_active(org_id)`(H1_MERGE_GATE_ENABLED 플래그+allowlist)로
게이팅했다 — H1이 꺼진(라인 게이트만 쓰는) org는 실제 merge Gate row가 있어도 이 reconcile이
영원히 스킵됐다(#2156이 고치려던 "증거 기록됐는데 게이트에 CI unknown" 증상의 라인판).

수정: 그 바깥 `merge_gate_active(org_id)` 가드를 제거 — reconcile 자신의 쿼리(Gate row:
org_id+story_id+gate_type="merge"+status pending/auto_passed 존재 여부)가 이미 "이 story에
반영할 게이트가 있는가"를 정확히 판별하므로(없으면 즉시 None, 저렴한 단건 조회) 바깥에서
org-level 활성판정으로 다시 게이팅할 필요가 없었다 — H1도 라인도 「Gate row 존재」라는 같은
사실로 자연히 커버된다(AC "두 활성판정을 통합" = 이 바깥 게이트가 애초에 불필요했다는 것).
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

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Line merge gate target")
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
async def test_process_webhook_event_reconciles_even_when_h1_merge_gate_disabled():
    """⭐본체 — H1_MERGE_GATE_ENABLED=False(라인 merge-gate만 쓰는 org의 정상 상태)여도
    `_process_webhook_event`가 reconcile_merge_gate_with_real_evidence를 호출해야 한다.
    merge-type Gate row는 H1 경로뿐 아니라 workflow_line_engine._merge_gate_wrapper에서도
    생기므로(evaluate_merge_gate→create_gate, gate_type="merge" 공유), org-level H1 플래그로
    reconcile을 게이팅하면 라인전용 org의 실 CI/PR 증거가 영원히 그 게이트에 안 닿는다."""
    from app.core.config import settings
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
        # ⭐라인전용 org의 정상 상태 — H1 레거시 플래그는 꺼짐. 옛 코드는 이 값으로
        # merge_gate_active(org_id)를 계산해 reconcile 호출 자체를 건너뛰었다.
        patch.object(settings, "h1_merge_gate_enabled", False),
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
            "app.routers.verdict_capture.reconcile_merge_gate_with_real_evidence", AsyncMock(return_value=None),
        ) as reconcile_spy,
    ):
        await _process_webhook_event(session, "app", "pull_request", payload, 123, delivery)

    reconcile_spy.assert_awaited_once(), "H1 꺼진 org라고 reconcile이 스킵되면 라인 게이트 증거가 영원히 안 닿는다 — #2520 미수복"


@pytest.mark.anyio
async def test_reconcile_updates_line_style_gate_regardless_of_h1_flag_realdb():
    """⭐실PG 대응 — reconcile_merge_gate_with_real_evidence 자신은 H1 플래그를 아예 참조하지
    않는다(쿼리 조건이 org_id+story_id+gate_type="merge"+status뿐). H1_MERGE_GATE_ENABLED=False
    로 명시해도(라인전용 org 재현) 라인 wrapper가 만드는 것과 동일한 모양의 pending merge
    게이트가 실 CI 증거로 정확히 갱신됨을 실PG로 고정 — "line gate만 있는(H1=False) org에서
    CI verdict가 그 gate에 실제 반영되는지"(AC) 그 자체."""
    from app.core.config import settings
    from app.services.merge_verdict_gate import evaluate_merge_gate, reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            with (
                patch.object(settings, "h1_merge_gate_enabled", False),
                patch(
                    "app.services.merge_verdict_gate.resolve_disposition",
                    AsyncMock(return_value=("ask", "org_policy")),
                ),
                patch(
                    "app.services.merge_verdict_gate._is_meaningfully_explicit_ask",
                    AsyncMock(return_value=True),
                ),
            ):
                # 라인 wrapper가 만드는 것과 동형(ci=None·pr_number=0 self-report shell).
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

            assert decision is not None, "H1=False라고 reconcile 자신이 no-op되면 안 된다"
            assert decision.reason != "CI unknown (self-report only)", (
                "실 CI 증거가 게이트에 반영 안 됨 — #2520(라인 게이트판) 미수복"
            )
            gate = await _gate_row(s, seeded["story_id"])
            assert gate.decision_basis != "CI unknown (self-report only)"
    finally:
        await engine.dispose()

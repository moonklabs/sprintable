"""story #3035(2026-08-24, 카디르+codex QA #3456 부수발견, PO 판정) — `evaluate_merge_gate`
호출부 2곳이 `pr_result`를 생략해 함수 기본값 `"pass"`가 그대로 게이트 생성 시점(neutral_facts
스냅샷)에 낙관적으로 확定됐다. #3033(SHA 폴백)이 세운 규율과 동일: 모름/아직-아님을 "pass"로
위조하지 않는다.

①`merge_verdict_gate.py::trigger_gate_creation_for_late_participation` — GitHub REST로 PR의
실 `merged` 상태를 이미 받아왔는데(head_sha 추출에만 쓰고) `evaluate_merge_gate` 호출엔 안
넘겨 이미 아는 사실을 던져버리던 landmine(#3033 QA가 원 지목한 verdict_capture.py:541과
형제 결함, 이 파일 작업 중 발견 즉시 동반수정 — feedback_fix_on_sight 팀 관례).
②`verdict_capture.py::_process_webhook_event`의 late-gate-creation else 분기(#2826 처방) —
이 분기 자체가 `pull_request` 라이프사이클 이벤트(opened/reopened/ready_for_review/
synchronize) 전용이라 PR은 **구조적으로 아직 안 머지된 상태**인데 기본값이 "머지됨"을
지어냈다(가장 명백한 인스턴스 — #3033보다 원인이 더 뚜렷하다).

둘 다 `evaluate_merge_gate`를 모킹해 **호출 인자**를 직접 대조한다(#3033과 동일 방법론 —
`neutral_facts`가 생성 시점 1회만 채워지는 실측 함정을 재확認할 필요 없이, "무엇을 넘기는지"가
이 fix의 전부)."""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_2893_gate_pr_scoped_isolation_realdb import (
    _post_app,
    _seed_installation,
    _seed_link,
    _session_factory,
)
from tests.test_2893_pr4_late_participation_gate_creation_realdb import (
    _seed_org_project_story_no_role,
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


@pytest.mark.anyio
async def test_late_participation_hook_passes_pass_when_github_confirms_merged_realdb():
    """실 merged=True를 GitHub REST가 확認하면 그대로 "pass"를 넘긴다(모름이 아니라 진짜
    아는 경우 — 이 fix가 "항상 None"이 아니라 "아는 값을 정직하게" 전달함을 증명하는 양성대조)."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=690801)
            await _seed_link(s, org, story, pr_number=801)
            story_id = story.id

        captured: list[dict] = []

        async def _spy_evaluate(session_arg, org_id_arg, work_item_id_arg, **kwargs):
            captured.append(kwargs)
            return SimpleNamespace(gate_id=uuid.uuid4())

        async with Session() as s:
            with (
                patch("app.services.github_app.get_installation_token", AsyncMock(return_value="inst-tok")),
                patch(
                    "app.services.github_app.get_pull_request",
                    AsyncMock(return_value={"head": {"sha": "sha-801"}, "merged": True}),
                ),
                patch(
                    "app.services.verdict_capture.fetch_status_check_rollup",
                    AsyncMock(return_value=("success", None)),
                ),
                patch("app.services.merge_verdict_gate.evaluate_merge_gate", _spy_evaluate),
            ):
                ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
                await s.commit()
        assert ok is True

        assert len(captured) == 1
        assert captured[0]["pr_result"] == "pass", "GitHub이 merged=True로 확認했으면 그대로 pass를 넘겨야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_late_participation_hook_never_claims_pass_when_not_merged_realdb():
    """⭐핵심 — GitHub REST가 merged=False(아직 열려 있음)를 확認했는데도, 최초 버전은 그
    사실을 던져버리고 `evaluate_merge_gate` 기본값 "pass"를 그대로 썼다. 명시로 None을
    넘겨야 한다(merged=False는 "실패"도 아니다 — 중립)."""
    from app.services.participation_helpers import ensure_implementation_participation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=690802)
            await _seed_link(s, org, story, pr_number=802)
            story_id = story.id

        captured: list[dict] = []

        async def _spy_evaluate(session_arg, org_id_arg, work_item_id_arg, **kwargs):
            captured.append(kwargs)
            return SimpleNamespace(gate_id=uuid.uuid4())

        async with Session() as s:
            with (
                patch("app.services.github_app.get_installation_token", AsyncMock(return_value="inst-tok")),
                patch(
                    "app.services.github_app.get_pull_request",
                    AsyncMock(return_value={"head": {"sha": "sha-802"}, "merged": False}),
                ),
                patch(
                    "app.services.verdict_capture.fetch_status_check_rollup",
                    AsyncMock(return_value=("success", None)),
                ),
                patch("app.services.merge_verdict_gate.evaluate_merge_gate", _spy_evaluate),
            ):
                ok = await ensure_implementation_participation(s, org.id, story_id, uuid.uuid4())
                await s.commit()
        assert ok is True

        assert len(captured) == 1
        assert captured[0]["pr_result"] is None, (
            "merged=False(아직 안 머지됨)를 pass로 위조하면 안 됨 — 근거없는 낙관 확定 landmine"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_webhook_lifecycle_late_gate_creation_never_claims_pass_realdb():
    """⭐verdict_capture.py:541 원 지목 지점 — `pull_request.opened`(구조적으로 아직 안
    머지된 라이프사이클 이벤트)가 late-gate-creation(#2826 처방, else 분기)을 태울 때
    `evaluate_merge_gate`에 pr_result를 명시로 None 전달해야 한다(과거엔 생략→기본값
    "pass")."""
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story_no_role(s)
            await _seed_installation(s, org, installation_id=690803)
            story_id = story.id

            # 이 분기(#2826 처방)는 "story 링크는 해소됐는데 게이트가 아직 없다"가 전제 —
            # PullRequestStoryLink를 먼저 심어 opened 웹훅의 resolver가 story를 찾게 한다.
            await _seed_link(s, org, story, pr_number=803)

            # implementation participation도 필요(없으면 evaluate_merge_gate가 그 전에
            # "no implementation participation"으로 조기반환 — pr_result를 볼 일도 없음).
            from app.models.participation import Participation, ParticipationRole
            from sqlalchemy import select

            role = (
                await s.execute(
                    select(ParticipationRole).where(
                        ParticipationRole.org_id == org.id, ParticipationRole.is_default.is_(True),
                    )
                )
            ).scalar_one()
            s.add(Participation(
                id=uuid.uuid4(), org_id=org.id, story_id=story_id, role_id=role.id, member_id=uuid.uuid4(),
            ))
            await s.commit()

        captured: list[dict] = []

        async def _spy_evaluate(session_arg, org_id_arg, work_item_id_arg, **kwargs):
            captured.append(kwargs)
            return SimpleNamespace(gate_id=uuid.uuid4())

        payload = {
            "action": "opened",
            "repository": {"full_name": "moonklabs/sprintable"},
            "installation": {"id": 690803},
            "pull_request": {
                "number": 803, "title": "chore: unrelated", "body": "", "merged": False,
                "head": {"sha": "sha-803", "ref": "feat-branch-803"},
                "labels": [],
            },
        }
        async with Session() as s:
            with (
                patch("app.services.merge_verdict_gate.evaluate_merge_gate", _spy_evaluate),
                patch("app.core.database.async_session_factory", Session),
            ):
                await _post_app(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")

        assert len(captured) == 1, f"late-gate-creation 분기의 evaluate_merge_gate가 정확히 1회 불려야 함(실제: {captured})"
        assert captured[0]["pr_result"] is None, (
            "opened(구조적으로 미머지) 이벤트가 pr_result를 생략해 기본값 pass를 쓰면 안 됨"
        )
    finally:
        await engine.dispose()

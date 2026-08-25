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
    도달했다는 관측 가능한 증거.

    story #2893(§2 A1, 0271) 갱신 — 멱등 키가 pr_number를 포함한다. 두 호출을 **같은 PR
    번호(42)**로 통일 — 이게 실제 프로덕션 체인과도 정합된다(reconcile은 verdict_capture.py
    웹훅 핸들러에서만 불리고, 그 핸들러는 실 PR 이벤트에서만 pr_number를 뽑아 항상 >0이다
    — pr_number=0인 reconcile 호출은 애초에 실사용 경로가 아니다). 다른 PR 번호로 만든
    게이트에 이 증거가 새면 안 된다는 게 정확히 이 스토리의 요지 — 그 회귀가드는
    test_2893_gate_pr_scoped_isolation_realdb가 전담한다."""
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
                # story #2932(HIGH1) — repo도 이제 멱등 키 일부다. 두 호출을 같은 repo로
                # 통일(실제 프로덕션 체인과도 정합 — pr_number=42는 항상 실 repo와 짝으로
                # 옴, repo=""는 pr_number<=0 no-substance 전용 관례값이지 이 케이스가 아님).
                await evaluate_merge_gate(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=42, repo="moonklabs/sprintable", ci_result=None, pr_result=None,
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


# ─── story #2912(2899 그라운딩 갈래D 처방③, BE 레이어) ──────────────────────
# pull_request.edited가 base retarget(새 커밋 없이 base branch만 바뀜, #3317 실사고)에도
# 뜨는데, 이 웹훅 핸들러의 두 체크런 재발행 분기(ungated_check_publish·gate_check_publish)
# 는 edited를 아예 안 들었다 — GHA 레이어(PR①/#3326)와 독립적으로 같은 갭. changes.base
# 유무로 순수 title/body 편집과 base 변경을 가른다(GitHub이 base가 실제로 바뀐 edited
# 이벤트에만 payload.changes.base를 채워 보낸다).

def _base_retarget_payload(*, pr_number=42, changes_base=True):
    payload = {
        "repository": {"full_name": "moonklabs/sprintable"},
        "pull_request": {
            "number": pr_number, "merged": False, "title": "fix(#1): x",
            "head": {"ref": "fix/1-x", "sha": "newsha123"},
        },
        "action": "edited",
        "installation": {"id": 123},
    }
    if changes_base:
        payload["changes"] = {"base": {"ref": {"from": "main"}, "sha": {"from": "oldbasesha"}}}
    else:
        payload["changes"] = {"title": {"from": "old title"}}  # 순수 제목편집, base 무변화
    return payload


def test_is_base_retarget_edit_computation_pure():
    """is_base_retarget_edit 계산 자체(순수 함수적 조각) — edited+changes.base 有일 때만
    True, 그 외(edited인데 base없음·edited아닌 다른 action)는 전부 False."""
    def _compute(pr_action, payload):
        return pr_action == "edited" and bool((payload.get("changes") or {}).get("base"))

    assert _compute("edited", {"changes": {"base": {"ref": {"from": "main"}}}}) is True
    assert _compute("edited", {"changes": {"title": {"from": "old"}}}) is False
    assert _compute("edited", {}) is False
    assert _compute("edited", {"changes": None}) is False
    assert _compute("synchronize", {"changes": {"base": {"ref": {"from": "main"}}}}) is False
    assert _compute(None, {}) is False


@pytest.mark.anyio
async def test_ungated_check_publish_fires_on_base_retarget_edit_but_not_pure_title_edit():
    """unlinked story(rl.story_id=None) 경로 — base retarget edited는 ungated_check_publish에
    (installation_id 등) append돼야 하고, 순수 title 편집(changes.base 없음)은 append 안 돼야
    한다(낭비 재발행 방지 — GHA required 잡과 달리 skip 상태 landmine은 없는 자리)."""
    from app.models.github_installation import GithubInstallation, GithubWebhookDelivery
    from app.routers.verdict_capture import _process_webhook_event
    from app.services.pr_story_link import ResolvedLink

    org_id = uuid.uuid4()
    installation = GithubInstallation(
        id=uuid.uuid4(), installation_id=123, org_id=org_id, account_login="moonklabs",
    )

    async def _run(payload):
        delivery = GithubWebhookDelivery(
            id=uuid.uuid4(), source="app", delivery_id=f"d-{uuid.uuid4()}",
            event="pull_request", status="received",
        )
        session = AsyncMock()
        exec_result = AsyncMock()
        exec_result.scalar_one_or_none = lambda: installation
        session.execute = AsyncMock(return_value=exec_result)
        ungated: list[dict] = []
        with (
            patch(
                "app.routers.verdict_capture.resolve_story_for_pr",
                AsyncMock(return_value=ResolvedLink(None, None, None, None, False, "no_match")),
            ),
            patch("app.services.gate_github_check.is_repo_check_enforced", AsyncMock(return_value=True)),
        ):
            await _process_webhook_event(
                session, "app", "pull_request", payload, 123, delivery,
                gate_check_publish=[], ungated_check_publish=ungated,
            )
        return ungated

    base_retarget = await _run(_base_retarget_payload(changes_base=True))
    assert len(base_retarget) == 1, "base retarget edited는 ungated_check_publish에 정확히 1건 append돼야 함"
    assert base_retarget[0]["installation_id"] == 123

    title_only = await _run(_base_retarget_payload(changes_base=False))
    assert title_only == [], "순수 title 편집(changes.base 없음)은 append 0건이어야 함(낭비 재발행 방지)"


def test_missing_changes_key_entirely_is_false_without_exception():
    """codex 독립 QA(#3332) 항목⑥ — payload에 changes 키 자체가 없는(None이 아니라 부재)
    malformed/구 replay payload에도 is_base_retarget_edit 계산이 예외 없이 False로 떨어져야
    한다(`.get("changes")`가 None을 반환하는 경로와 동치지만 명시적으로 고정)."""
    payload = {
        "repository": {"full_name": "moonklabs/sprintable"},
        "pull_request": {"number": 42, "merged": False, "head": {"ref": "x", "sha": "s"}},
        "action": "edited",
        # changes 키 자체가 없음(테스트 파일 상단 헬퍼는 항상 넣어주므로 여기선 직접 구성).
    }
    assert "changes" not in payload
    is_base_retarget_edit = payload.get("action") == "edited" and bool(
        (payload.get("changes") or {}).get("base")
    )
    assert is_base_retarget_edit is False


@pytest.mark.anyio
async def test_gate_check_publish_fires_on_base_retarget_edit_when_story_linked():
    """codex 독립 QA(#3332) 항목⑤ — `ungated_check_publish` 경로(story 미해소)만 카디르가
    직접 실호출로 확認했었다. story가 **해소된**(rl.story_id 有) 경로의 `gate_check_publish`
    분기(기존 Gate 없음→evaluate_merge_gate로 신규 평가)도 base retarget edited로 실제
    호출해 정확히 append되는지 직접 고정한다(codex가 임시로 증명한 시나리오를 영구 회귀로
    저장 — codex 자신의 권고③)."""
    from types import SimpleNamespace

    from app.models.github_installation import GithubInstallation, GithubWebhookDelivery
    from app.routers.verdict_capture import _process_webhook_event
    from app.services.pr_story_link import ResolvedLink

    org_id, story_id, gate_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    installation = GithubInstallation(
        id=uuid.uuid4(), installation_id=123, org_id=org_id, account_login="moonklabs",
    )
    delivery = GithubWebhookDelivery(
        id=uuid.uuid4(), source="app", delivery_id="d-gate-linked",
        event="pull_request", status="received",
    )
    session = AsyncMock()
    installation_result = AsyncMock()
    installation_result.scalar_one_or_none = lambda: installation
    no_gate_result = AsyncMock()
    no_gate_result.scalar_one_or_none = lambda: None  # 기존 merge Gate row 없음 → evaluate 분기.
    # story #2893/#2932 후속(카디르 QA) — find_gate_slot_with_pr_fallback가 정확매치(없음)→
    # repo-unknown 슬롯(없음, story #2932 HIGH1 잔여)→NULL-슬롯 폴백까지 조회한다(3 SELECT).
    # 이 테스트는 전부 "없음"인 시나리오(진짜 신규)라 매 자리 no_gate_result 재사용으로 충분.
    # story #3039 — resolve_story_for_pr가 sid(비-stored) 경로로 해소되면 upsert_link()가
    # 그 자리서 링크를 영속화한다(기존 PullRequestStoryLink 존재여부 확인 SELECT 1건 추가).
    session.execute = AsyncMock(
        side_effect=[installation_result, no_gate_result, no_gate_result, no_gate_result, no_gate_result]
    )
    evaluate = AsyncMock(return_value=SimpleNamespace(gate_id=gate_id))
    gate_check_publish: list[dict] = []

    with (
        patch(
            "app.routers.verdict_capture.resolve_story_for_pr",
            AsyncMock(return_value=ResolvedLink(story_id, org_id, "sid", "high", True, "sid_exact")),
        ),
        patch("app.services.merge_verdict_gate.evaluate_merge_gate", evaluate),
    ):
        result, status = await _process_webhook_event(
            session, "app", "pull_request", _base_retarget_payload(changes_base=True), 123, delivery,
            gate_check_publish=gate_check_publish, ungated_check_publish=[],
        )

    # story #3035(2026-08-24) — 이 late-gate-creation 분기가 pr_result를 명시로 None
    # 넘기도록 정정됐다(과거엔 생략→evaluate_merge_gate 기본값 "pass"가 낙관적으로 확定).
    evaluate.assert_awaited_once_with(
        session, org_id, story_id, pr_number=42, repo="moonklabs/sprintable",
        ci_result=None, pr_result=None, head_sha="newsha123",
    )
    assert gate_check_publish == [{
        "org_id": org_id, "gate_id": gate_id, "head_sha": "newsha123",
        "repo_full_name": "moonklabs/sprintable", "pr_number": 42,
    }]
    # 이 시나리오는 merged=False·ci_conclusion=None(non-actionable)이라 verdict capture
    # 자체는 no-op으로 정직하게 skip된다 — gate_check_publish append는 그 skip과 독립적으로
    # 이미 큐잉됐음을 위에서 확認했다.
    assert result == {"skipped_reason": "no_actionable_signal", "recorded": []}
    assert status == "ignored"

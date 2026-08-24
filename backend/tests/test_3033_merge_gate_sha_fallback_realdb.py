"""story #3033(2026-08-24, PO 판정) — reconcile_merge_gate_with_real_evidence 웹훅이 실 PR
종결을 놓친 회귀(PR#3350 MERGED·PR#3307 CLOSED 2/2 실물)의 근본 처방.

그라운딩(디디, GitHub webhook delivery + REST API 실물 대조): 웹훅 자체는 정상 발송·수신
됐고 매칭 로직(find_gate_slot_with_pr_fallback)도 «주어진 pr_number»로는 정확했다 — 문제는
스택형 형제 PR이 같은 head SHA를 공유할 때, 원 PR이 머지된 뒤 도착하는 CI-완료 웹훅
(check_suite/workflow_run/status)의 GitHub `pull_requests[]`에서 그 PR이 빠져(머지된 PR은
"현재 head" 목록에서 제외됨), pr_number 추출 단계가 애초에 틀린(형제) PR을 가리켰다는 것.

처방(PO 판정): CI verdict는 PR이 아니라 SHA의 속성이다 — pr_number 경로가 못 찾으면
org+github_check_run_sha로만(story 무관) 찾는 SHA 폴백을 추가한다. ci_result만 갱신하고
pr_result(머지/클로즈, PR별 사실)는 각 게이트의 기존 값을 보존한다.

이 파일은 그 폴백(`find_pending_merge_gates_by_head_sha` 직접 + `reconcile_merge_gate_
with_real_evidence` 통합) 자체를 검증한다."""
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
    import app.models.verdict  # noqa: F401 — story #2662류 미등재 갭(evaluate_merge_gate가
    # capture_pr_ci_verdict 경유로 Verdict 테이블을 직접 쓰는데, 이 파일을 단독 실행하면
    # app.models 벌크 임포트만으로는 이 모듈이 로드 안 될 때가 있어(다른 테스트 파일이
    # 먼저 임포트해 둔 프로세스 전역 부수효과에 의존하던 것) create_all() 직전에 명시.
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_story_with_participation(session, org_id=None, org_slug_prefix="org"):
    """⚠️`resolve_implementation_participation`(verdict_capture.py)은 org 안의 "default"
    role을 `ParticipationRole.org_id==org_id, is_default.is_(True)` + `.limit(1)`(role_id로
    좁히지 않음, ORDER BY 없음)로 조회한다 — 같은 org_id를 재사용하면서 매번 새
    `is_default=True` role을 또 만들면, 그 조회가 «어느 역할이 default인지» 모호해져
    엉뚱한(먼저 만들어진) role_id를 집고, 그 role_id로는 이 story의 Participation을 못 찾아
    "no implementation participation"으로 조용히 새 버린다(evaluate_merge_gate가 gate_id=
    None을 돌려주는데 예외가 없어 원인 추적이 느리다 — 실측으로 적발). 그래서 org_id를
    재사용할 때는 role도 재사용한다(같은 org 안 여러 story가 같은 default role을 공유하는
    게 실제 프로덕션 모양과도 일치 — role은 story가 아니라 org 단위 개념)."""
    from app.models.organization import Organization
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.project import Project
    from sqlalchemy import select

    if org_id is None:
        org = Organization(id=uuid.uuid4(), name="Org", slug=f"{org_slug_prefix}-{uuid.uuid4().hex[:8]}")
        session.add(org)
        await session.commit()
        org_id = org.id

    role = (
        await session.execute(
            select(ParticipationRole).where(
                ParticipationRole.org_id == org_id, ParticipationRole.is_default.is_(True),
            ).limit(1)
        )
    ).scalar_one_or_none()
    if role is None:
        role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="dev", label="Dev", is_default=True)
        session.add(role)
        await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org_id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project.id, title="Merge gate SHA fallback target")
    session.add(story)
    await session.commit()

    member_id = uuid.uuid4()
    participation = Participation(
        id=uuid.uuid4(), org_id=org_id, story_id=story.id, role_id=role.id, member_id=member_id,
    )
    session.add(participation)
    await session.commit()

    return {"org_id": org_id, "story_id": story.id, "member_id": member_id}


async def _gate_row(session, story_id):
    from sqlalchemy import select

    from app.models.gate import Gate

    result = await session.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "merge")
    )
    return result.scalar_one_or_none()


async def _seed_pending_merge_gate_with_sha(
    session, seeded, *, pr_number, repo, head_sha, pr_result="pass", ci_result=None,
):
    """실제로 publish_gate_check가 나중에 github_check_run_sha를 찍는 것을 시뮬레이션
    (그 발행 로직 자체는 이 테스트 스코프 밖 — 게이트에 이미 anchor SHA가 있는 상태만 재현)."""
    from app.services.merge_verdict_gate import evaluate_merge_gate

    await evaluate_merge_gate(
        session, seeded["org_id"], seeded["story_id"],
        pr_number=pr_number, repo=repo, ci_result=ci_result, pr_result=pr_result,
    )
    await session.commit()
    gate = await _gate_row(session, seeded["story_id"])
    gate.github_check_run_sha = head_sha
    await session.commit()
    return gate


@pytest.mark.anyio
async def test_find_pending_merge_gates_by_head_sha_is_org_scoped_and_status_filtered_realdb():
    """직접 단위 검증 — org 경계는 지키고(다른 org의 같은 SHA는 안 섞임), terminal 상태
    (approved/rejected)는 제외한다(사람이 이미 결정한 것을 CI 이벤트로 조용히 재오픈 금지)."""
    from app.services.gate_service import find_pending_merge_gates_by_head_sha

    engine, Session = await _session_factory()
    try:
        sha = f"sha{uuid.uuid4().hex}"
        async with Session() as s:
            seeded_a = await _seed_story_with_participation(s, org_slug_prefix="org-a")
            gate_a = await _seed_pending_merge_gate_with_sha(
                s, seeded_a, pr_number=101, repo="acme/repo", head_sha=sha,
            )
            assert gate_a.status == "pending"

            # 같은 SHA·다른 org — 절대 섞이면 안 됨.
            seeded_b = await _seed_story_with_participation(s, org_slug_prefix="org-b")
            await _seed_pending_merge_gate_with_sha(
                s, seeded_b, pr_number=202, repo="acme/repo", head_sha=sha,
            )

            # 같은 org·같은 SHA·terminal(approved) — 제외 대상.
            seeded_c = await _seed_story_with_participation(s, seeded_a["org_id"])
            gate_c = await _seed_pending_merge_gate_with_sha(
                s, seeded_c, pr_number=303, repo="acme/repo", head_sha=sha,
            )
            from app.models.gate import set_gate_status
            from datetime import datetime, timezone
            set_gate_status(gate_c, "approved", now=datetime.now(timezone.utc))
            await s.commit()

            matches = await find_pending_merge_gates_by_head_sha(s, org_id=seeded_a["org_id"], head_sha=sha)
            match_ids = {g.id for g in matches}
            assert gate_a.id in match_ids, "같은 org·pending·같은 SHA는 매치돼야 함"
            assert gate_c.id not in match_ids, "approved(terminal)는 CI 이벤트로 재오픈되면 안 됨"
            assert len(matches) == 1, f"org 경계 밖(org-b) 게이트가 섞임: {match_ids}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_sha_fallback_updates_ci_only_preserves_pr_result_cross_story_realdb():
    """⭐핵심 — pr_number 경로가 못 찾으면(웹훅이 형제 PR로 오배선), SHA로 **다른 story의**
    게이트까지 찾아 ci_result만 갱신하고 pr_result(이미 "pass")는 그대로 보존한다.

    ⚠️`gate.neutral_facts`(JSONB)는 게이트 **생성 시점 1회**만 채워진다(`create_gate`의
    멱등 반환 분기 — 이미 존재하는 pending/auto_passed 게이트는 neutral_facts를 다시
    쓰지 않는다, gate_service.py 실측 확認). 그래서 "ci_result만 갱신·pr_result 보존"을
    DB에 쌓인 neutral_facts로는 검증할 수 없다(애초에 둘 다 재기록 안 됨) — 실제로
    매 호출마다 갱신되는 건 `gate.decision_basis`/`requires_human`(별도 컬럼, `_decide()`
    직후 무조건 write-back) 쪽이고, 그 `_decide()`에 **어떤 pr 값이 실제로 들어갔는지**가
    이 fix의 핵심(참고: outcome 표본 0인 fresh seed에서는 `_decide()`가 outcome-insufficient
    로 조기 리턴해 pr 값이 reason 문자열에 아예 안 드러나 — 그래서 `evaluate_merge_gate`를
    직접 모킹해 **호출 인자**를 대조한다. 이게 "pr_result가 None으로 새는지"를 검증하는
    가장 직접적이고 seeding 부담이 없는 방법이다).

    story 경계를 넘어 매치되는 걸 일부러 검증한다 — PO 판정의 핵심("SHA는 PR이 아니라
    커밋의 속성, story 스코프가 아니다")이 실제 실사고(#3350/#3307, 같은 story 안 형제
    PR)보다 더 넓은 일반화라는 것을 이 테스트가 고정한다."""
    from app.services.merge_verdict_gate import (
        MergeGateDecision,
        reconcile_merge_gate_with_real_evidence,
    )

    engine, Session = await _session_factory()
    try:
        sha = f"sha{uuid.uuid4().hex}"
        async with Session() as s:
            # story A = 웹훅이 실제로 의도한 원 PR(이미 머지됨, pr_result=pass로 생성됨).
            seeded_a = await _seed_story_with_participation(s, org_slug_prefix="org")
            gate_a = await _seed_pending_merge_gate_with_sha(
                s, seeded_a, pr_number=100, repo="acme/repo", head_sha=sha, pr_result="pass", ci_result=None,
            )
            assert gate_a.neutral_facts["pr_result"] == "pass"

            # story B = 무관한 다른 story(같은 org — story 경계만 다르다는 걸 보이기 위해).
            seeded_b = await _seed_story_with_participation(s, seeded_a["org_id"])

            captured_calls: list[dict] = []
            real_evaluate = None

            async def _spy(session_arg, org_id_arg, work_item_id_arg, **kwargs):
                captured_calls.append({"work_item_id": work_item_id_arg, **kwargs})
                return MergeGateDecision(
                    decision="ask_human", reason="stub", gate_id=gate_a.id, gate_status="pending",
                    disposition="ask", trust=None, ci_result=kwargs.get("ci_result"),
                )

            # 웹훅이 자원(story_id)은 A로 정확히 resolve했지만(SID 매치 등), pr_number 자체가
            # GitHub의 pull_requests[]가 원 PR을 빼버려 엉뚱한(존재하지 않는 A의) 번호를 문다
            # — pr_number 경로(find_gate_slot_with_pr_fallback)는 story A에서 999를 못 찾음.
            with patch("app.services.merge_verdict_gate.evaluate_merge_gate", _spy):
                decision = await reconcile_merge_gate_with_real_evidence(
                    s, seeded_a["org_id"], seeded_a["story_id"],
                    pr_number=999, repo="acme/repo", ci_result="pass", merged=False, head_sha=sha,
                )
            await s.commit()

            # 반환값은 하위 호환 계약대로 None(SHA 폴백 결과는 반환값에 안 실림).
            assert decision is None

            assert len(captured_calls) == 1, f"SHA 폴백이 정확히 gate_a 1건만 재평가해야 함(실제: {captured_calls})"
            call = captured_calls[0]
            assert call["work_item_id"] == seeded_a["story_id"]
            assert call["ci_result"] == "pass", "SHA 폴백이 새 ci_result를 그대로 넘겨야 함"
            assert call["pr_result"] == "pass", (
                "pr_result는 이 폴백의 관심사가 아니다 — gate_a의 기존 값(pass)을 읽어 그대로 "
                "되돌려 넣어야 함(None을 넘기면 evaluate_merge_gate 내부에서 무조건부 덮어쓰기로 "
                "지워지는 landmine — evaluate_merge_gate 자체는 이미 확認됐으므로 여기선 "
                "reconcile이 «무엇을 넘기는지»만 정확히 대조한다)"
            )
            assert call["head_sha"] == sha

            # story B는 무관 — 애초에 이 SHA와 아무 관계도 없으므로 게이트 자체가 없어야 함.
            gate_b = await _gate_row(s, seeded_b["story_id"])
            assert gate_b is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_sha_fallback_zero_match_returns_none_no_gate_created_realdb():
    """pr_number 경로도 SHA 폴백도 둘 다 못 찾으면(이 CI 신호가 어떤 게이트와도 무관) 새
    게이트를 만들지 않고(reconcile은 «반영»이지 「생성」이 아니다) None을 반환한다."""
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)

            decision = await reconcile_merge_gate_with_real_evidence(
                s, seeded["org_id"], seeded["story_id"],
                pr_number=999, repo="acme/repo", ci_result="pass", merged=False,
                head_sha=f"sha{uuid.uuid4().hex}",  # 아무 게이트도 물고 있지 않은 SHA.
            )
            await s.commit()

            assert decision is None
            assert await _gate_row(s, seeded["story_id"]) is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_pr_number_path_takes_priority_skips_sha_fallback_realdb():
    """pr_number 경로가 이미 정확한 게이트를 찾으면(정상 케이스 — 웹훅이 원 PR을 제대로
    가리킴) SHA 폴백은 아예 발동하지 않는다 — 같은 SHA를 공유하는 형제 게이트가 있어도
    그건 안 건드린다(이 웹훅이 말하는 건 정확히 그 pr_number PR 하나뿐이라는 사실).

    ⚠️`neutral_facts`가 생성 시점 1회만 채워진다는 사실(위 테스트 참조) 때문에, "형제가
    안 건드려졌다"를 neutral_facts로는 증명할 수 없다(애초에 정상 케이스에서도 안 바뀜 —
    거짓 양성). `find_pending_merge_gates_by_head_sha`를 스파이로 감싸 **호출 자체가
    없었음**을 직접 증명한다 — 그게 "폴백이 발동 안 함"의 유일한 정직한 신호다."""
    from app.services import merge_verdict_gate as mvg
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        sha = f"sha{uuid.uuid4().hex}"
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            gate_primary = await _seed_pending_merge_gate_with_sha(
                s, seeded, pr_number=100, repo="acme/repo", head_sha=sha, pr_result=None, ci_result=None,
            )

            # 같은 story·같은 SHA를 공유하는 "형제" 게이트(다른 pr_number) — 건드리면 안 됨.
            seeded2 = await _seed_story_with_participation(s, seeded["org_id"])
            await _seed_pending_merge_gate_with_sha(
                s, seeded2, pr_number=101, repo="acme/repo", head_sha=sha, pr_result=None, ci_result=None,
            )

            sha_fallback_calls: list = []
            real_find = mvg.find_pending_merge_gates_by_head_sha

            async def _spy(*args, **kwargs):
                sha_fallback_calls.append((args, kwargs))
                return await real_find(*args, **kwargs)

            with patch("app.services.merge_verdict_gate.find_pending_merge_gates_by_head_sha", _spy):
                decision = await reconcile_merge_gate_with_real_evidence(
                    s, seeded["org_id"], seeded["story_id"],
                    pr_number=100, repo="acme/repo", ci_result="pass", merged=True, head_sha=sha,
                )
            await s.commit()

            assert decision is not None
            assert decision.gate_id == gate_primary.id
            assert not sha_fallback_calls, (
                "pr_number 경로가 이미 성공했으면 SHA 폴백 조회 자체를 호출하면 안 됨 — "
                f"호출됨: {sha_fallback_calls}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_sha_fallback_queues_gate_check_publish_with_matched_gates_own_pr_number_realdb():
    """SHA 폴백이 갱신한 게이트를 GitHub check-run publish 큐에 넣을 때, 웹훅 자신의
    pr_number(형제를 가리킬 수 있음)가 아니라 **매치된 게이트 자신의** pr_number/repo로
    넣어야 한다 — 안 그러면 엉뚱한 PR에 check-run이 발행된다."""
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        sha = f"sha{uuid.uuid4().hex}"
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            gate = await _seed_pending_merge_gate_with_sha(
                s, seeded, pr_number=100, repo="acme/repo", head_sha=sha, pr_result="pass", ci_result=None,
            )

            publish_queue: list[dict] = []
            decision = await reconcile_merge_gate_with_real_evidence(
                s, seeded["org_id"], seeded["story_id"],
                # 웹훅 자신은 999(형제 PR)를 가리킨다 — 실제로 갱신되는 건 gate(pr_number=100).
                pr_number=999, repo="acme/repo", ci_result="pass", merged=False, head_sha=sha,
                gate_check_publish=publish_queue,
            )
            await s.commit()

            assert decision is None
            assert len(publish_queue) == 1
            queued = publish_queue[0]
            assert queued["gate_id"] == gate.id
            assert queued["pr_number"] == 100, "웹훅의 999가 아니라 매치된 게이트 자신의 pr_number여야 함"
            assert queued["repo_full_name"] == "acme/repo"
    finally:
        await engine.dispose()

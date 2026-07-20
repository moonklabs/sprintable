"""E-LOOP-LEDGER S19(story 6208de76): manual outcome path — hypothesis 수동 해소가 GA4/
internal_ops와 동일한 다운스트림(HO-S4 verdict + S7 loop 귀속)을 타는지 검증.

핵심 증명: source='manual'(GA4/광고 통합 0개) 가설도 사람이 직접 transition_hypothesis로
verified/falsified 전이시키면 연결 loop이 실제로 closed된다 — "통합=자동화 업그레이드지
loop 완결의 전제조건 아님"을 실 DB round-trip으로 증명.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG = uuid.UUID("22000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("22000000-0000-0000-0000-000000000002")


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C22','c22org','free')",
        # violation_level: Project 모델의 default="warn"은 ORM-level(raw SQL은 미경유) — 스키마에
        # NOT NULL 컬럼으로 추가된 뒤 이 raw INSERT가 갱신 안 돼 있었다(발견 즉시 수정, #2038과 무관).
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','warn')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _cleanup(s):
    for sql in [
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_manual_hypothesis(s, status="measuring") -> "object":
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=uuid.uuid4(),
        statement="s", metric_definition={"metric": "revenue", "source": "manual", "target": 1000, "direction": "up"},
        measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), status=status,
    )
    s.add(hyp)
    await s.commit()
    await s.refresh(hyp)
    return hyp


async def _seed_loop(s, hypothesis_id, status="measuring") -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=PROJ, title="L", goal_tags=[], status=status,
        hypothesis_id=hypothesis_id, created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _fetch_loop(s, loop_id):
    from app.models.loop import LoopRun
    return (await s.execute(select(LoopRun).where(LoopRun.id == loop_id))).scalar_one()


def _caller():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(
        id=uuid.uuid4(), user_id=uuid.uuid4(), name="t", type="human", role="member", org_id=ORG,
    )


# ── 핵심: manual source가 GA4/internal_ops 통합 0개로도 loop을 닫는다 ─────────────

@pytest.mark.anyio
async def test_manual_verified_transition_closes_linked_measuring_loop_without_any_integration():
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            # story #2038: verified/falsified는 outcome_result.actual(수치)+reason(근거)를 서버가
            # 강제한다 — actual_revenue는 이 테스트의 관심사(loop 귀속 와이어링)를 위한 부가 필드로
            # 유지하고, 강제 요건인 actual/reason을 함께 싣는다.
            caller = _caller()
            await transition_hypothesis(
                s, ORG, caller, hyp.id,
                HypothesisTransition(
                    status="verified",
                    outcome_result={"actual_revenue": 1500, "actual": 1500, "reason": "매출 목표 달성"},
                ),
            )
            await s.commit()

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_attributed_at is not None
            assert loop.outcome_snapshot["hypothesis_status"] == "verified"
            # story #2036(PO 리뷰 b4e88f34) 계약 갱신: outcome_result 저장 시 서버가 closed_by/
            # closed_by_member_id를 caller로부터 채워 신원 위장을 차단한다(#2036 AC — 클라이언트
            # 자칭 금지) — 그래서 == 완전일치가 이제 성립하지 않는다. 완전일치를 빼거나 in으로
            # 눕히면 "서버가 무엇을 채웠는지"를 아무도 검증 안 하게 되므로, 대신 두 축으로
            # 쪼개 더 강하게 검증한다: ⓐ 호출자가 보낸 필드가 손상 없이 보존되는가
            # ⓑ 서버가 채운 신원 필드가 하드코딩 문자열이 아니라 이 테스트가 실제로 만든
            # caller와 정확히 일치하는가. loop_outcome_attribution.attribute_loop_outcome은
            # 서버 스탬프 완료된 hypothesis.outcome_result를 그대로 스냅샷에 복사하므로(코드
            # 확인) — "누가 닫았는지"가 loop 감사 기록에도 같이 남는 것은 스냅샷의 기존 설계
            # (hypothesis_status처럼 지표 아닌 필드도 이미 담고 있음)와 일관되고, "그때 무엇을
            # 근거로 닫았나"를 되짚는 목적에 오히려 부합한다 — 별도 필터링 불요로 판단.
            stored = loop.outcome_snapshot["outcome_result"]
            assert stored["actual_revenue"] == 1500
            assert stored["actual"] == 1500
            assert stored["reason"] == "매출 목표 달성"
            assert stored["closed_by"] == caller.type
            assert stored["closed_by_member_id"] == str(caller.id)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_manual_falsified_transition_closes_linked_measuring_loop():
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            # story #2038: actual/reason 필수(위 verified 테스트와 동일 사유).
            await transition_hypothesis(
                s, ORG, _caller(), hyp.id,
                HypothesisTransition(
                    status="falsified",
                    outcome_result={"actual_revenue": 100, "actual": 100, "reason": "매출 목표 미달"},
                ),
            )
            await s.commit()

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_snapshot["hypothesis_status"] == "falsified"
    finally:
        await eng.dispose()


# ── 격리: verified/falsified 아닌 target은 다운스트림 무영향 ───────────────────

@pytest.mark.anyio
async def test_transition_to_killed_does_not_touch_linked_loop():
    """killed는 verified/falsified가 아니므로 attribute_loop_outcome이 호출조차 안 되고,
    연결 loop은 measuring 그대로 남아야 한다(다운스트림 무영향 실증)."""
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s, status="active")
            loop_id = await _seed_loop(s, hyp.id)

            await transition_hypothesis(
                s, ORG, _caller(), hyp.id, HypothesisTransition(status="killed", note="scrap"),
            )
            await s.commit()

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "measuring"
            assert loop.outcome_snapshot is None
    finally:
        await eng.dispose()


# ── loop 없어도 회귀 0(다운스트림 skip이 hypothesis 전이 자체를 막지 않음) ───────────

@pytest.mark.anyio
async def test_manual_verified_transition_with_no_linked_loop_still_succeeds():
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s)

            # story #2038: reason 필수 추가(actual은 이미 있었음).
            out = await transition_hypothesis(
                s, ORG, _caller(), hyp.id,
                HypothesisTransition(status="verified", outcome_result={"actual": 1, "reason": "테스트 근거"}),
            )
            await s.commit()
            assert out.status == "verified"
    finally:
        await eng.dispose()


# ── 재-해소 방지: 이미 closed된 loop은 재전이해도 불변 ──────────────────────────

@pytest.mark.anyio
async def test_transition_does_not_corrupt_already_closed_loop_snapshot():
    """S19 wiring이 attribute_loop_outcome의 기존 불변 가드(outcome_attributed_at)를 우회하지
    않는지 — 이미 closed된 loop에 재차 verified 전이(가정상 illegal이지만 서비스 함수 직접
    호출로 attribute_loop_outcome만 재확인)해도 스냅샷이 그대로인지."""
    from app.services.loop_outcome_attribution import attribute_loop_outcome

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s, status="verified")
            loop_id = await _seed_loop(s, hyp.id)

            await attribute_loop_outcome(s, hyp)
            await s.commit()
            loop_v1 = await _fetch_loop(s, loop_id)
            snapshot_v1 = dict(loop_v1.outcome_snapshot)

            # 재호출(예: transition 재시도) — loop이 이미 closed(measuring 아님)라 no-op.
            result2 = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result2 == {"skipped_reason": "no_measuring_loop", "attributed": []}

            loop_v2 = await _fetch_loop(s, loop_id)
            assert dict(loop_v2.outcome_snapshot) == snapshot_v1
    finally:
        await eng.dispose()

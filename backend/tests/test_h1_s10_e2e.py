"""H1-S10: 끝단 E2E — ready→verdict→gate→approve→done (웨지 done 게이트·접는조건).

전 H1 체인(S1-S7) 1발 통합: in-review story + implementation participation → CI pass verdict 캡처 →
merge gate 생성(policy ask→pending) → 사람 approve(S7 verdict 환류) → done. 끝에서 verdict count
증가·trust null 아님·merge gate 정확히 1개를 검증한다.

⚠️ 이 E2E가 green이 아니면 웨지 출시(flag enable) 금지(접는조건).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """story a05da51b — 이 파일은 publish_registry_event/publish_preset_event/
    transition_gate/send_message 중 하나를 호출해 실제로 메시지를 발행하거나 게이트를
    전이시킨다 — `send_message`의 background task(`mark_agent_replied`)가 이 파일의
    throwaway 엔진이 아니라 `app.core.database.async_session_factory`(전역·프로세스
    수명 엔진)를 쓴다. destructive_schema 마커 파일이라 story #3330(PR#3711)이 conftest.py
    에 심은 전역 autouse(non-destructive 전용 스코프)의 적용 대상이 아니다 — 이 파일
    자신의 여러 테스트가 한 pytest 세션 안에서 순차 실행되며 같은 전역 엔진을 반복
    사용하므로, dispose 없이 두면 pytest-anyio의 테스트별 새 이벤트 루프 사이에서 커넥션
    누수/`Event loop is closed`로 이어질 수 있다(story #3330/PR#3711 실사고 — test_3330_
    gate_verdict_notification.py에서 최초 재현). 이 realdb 하네스의 표준 방어 fixture
    재사용(새 로직 0, story a05da51b — scripts/lint_destructive_publish_path_dispose_
    fixture.py 가드 대상)."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_h1_end_to_end_ready_to_done():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — #2631: transition_gate()가 ActivityLog를 씀(#2201 후속 미등재 갭).
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.services.gate_service import transition_gate
    from app.services.merge_verdict_gate import ASK_HUMAN, evaluate_merge_gate
    from app.services.trust_score import compute_member_trust_scores
    from app.services.verdict_capture import capture_pr_ci_verdict

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id, resolver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        # ── 준비: in-review story + impl participation + policy(ask) ──────────────
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="E2E", status="in-review", story_points=5),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                OrgGatePolicy(org_id=org, posture="conservative"),  # → disposition ask.
            ])
            await s.commit()

        with patch("app.services.verdict_capture.fetch_pr_review_rounds", AsyncMock(return_value=0)):
            # ── 1. CI pass verdict 캡처(웹훅 경로 모사) ──────────────────────────
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                cap = await capture_pr_ci_verdict(
                    s, org, story_id, pr_number=42, repo="o/r", merged=True, ci_result="pass"
                )
                await s.commit()
                assert cap["recorded"], "CI/PR verdict가 기록돼야"

            # ── 2. merge gate 평가(policy ask→pending·decision ask_human) ────────
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                decision = await evaluate_merge_gate(
                    s, org, story_id, pr_number=42, repo="o/r", ci_result="pass", pr_result="pass"
                )
                await s.commit()
                assert decision.decision == ASK_HUMAN  # ask posture → 사람 보류.
                assert decision.gate_id is not None and decision.gate_status == "pending"
                gate_id = decision.gate_id

            # ── 3. 사람 approve(S7: merge verdict 환류) ──────────────────────────
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                gate = await transition_gate(s, org, gate_id, "approved", resolver_id=resolver)
                assert gate.status == "approved" and gate.resolver_id == resolver
                # ── 4. done 전이(approve 후) ─────────────────────────────────────
                await s.execute(
                    _text("UPDATE stories SET status='done' WHERE id=:id"), {"id": story_id}
                )
                await s.commit()

        # ── 끝단 검증: verdict 증가·trust non-null·merge gate 정확히 1개 ──────────
        async with Session() as s:
            vcount = (await s.execute(
                _text("SELECT count(*) FROM verdict v JOIN participation p ON p.id=v.participation_id "
                      "WHERE p.story_id=:sid AND v.result IS NOT NULL"), {"sid": story_id}
            )).scalar()
            assert vcount >= 2, f"verdict(pr/ci/merge) 증가해야, got {vcount}"

            # story 18eefc31: HO-S5(#1497, 이 E2E 원작 PR #1487 以後 병합)가 기본 trust
            # source를 hypothesis_outcome_* 로 제한해 이 체인이 캡처하는 CI/pr/merge verdict는
            # 기본 집계에서 제외된다 — include_legacy=True 로 legacy source 합산 명시(product
            # 버그 아닌 API 변경에 뒤처진 테스트 staleness).
            trust = await compute_member_trust_scores(
                s, org, member, role_key="implementation", include_legacy=True
            )
            assert trust["scores"], "trust scores가 비지 않아야(verdict 누적)"
            assert trust["scores"][0]["clean_pass_rate"] is not None, "trust null 아니어야"

            merge_gates = (await s.execute(
                _text("SELECT count(*) FROM gate WHERE work_item_id=:sid AND gate_type='merge'"),
                {"sid": story_id}
            )).scalar()
            assert merge_gates == 1, f"merge gate 정확히 1개여야(멱등), got {merge_gates}"

            # H1-FIX-1: gate row의 S3 evidence 메타가 decision으로 채워져야(영속화·FE S8이 읽음).
            meta = (await s.execute(
                _text("SELECT requires_human, evidence_status, decision_basis, auto_decision_reason "
                      "FROM gate WHERE work_item_id=:sid AND gate_type='merge'"), {"sid": story_id}
            )).one()
            assert meta.requires_human is True, "ask_human 게이트는 requires_human=true여야(액션 노출)"
            assert meta.evidence_status == "insufficient"
            assert meta.decision_basis is not None and meta.auto_decision_reason == "ask_human"

            done_status = (await s.execute(
                _text("SELECT status FROM stories WHERE id=:id"), {"id": story_id}
            )).scalar()
            assert done_status == "done"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()

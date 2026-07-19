"""SPR-34: rejected 게이트 재도전 경로 — reject → 재작업 → 2차 report_done이 게이트를 재개방.

도그푸드 1차(2026-07-19) 실측: 사람이 reject한 게이트가 영구 terminal(void·override 모두
pending 전용)이라 재작업 후 2차 report_done이 409 MERGE_BLOCKED로 막혀 "reject → 재작업 →
재승인" 루프(아하 2)가 닫히지 않았다.

수리 계약 (DB 유니크 제약 uq_gate_work_item_gate_type상 행 신설 불가 → in-place 재개방):
- ``create_gate(..., reopen_after_human_reject=True)``: 기존 게이트가 **사람이 reject**
  (status=rejected AND resolver_id IS NOT NULL)한 것이면 같은 행을 pending으로 재개방한다.
  이전 판정은 neutral_facts.resolution_history 스냅샷(+ 불변 gate.resolved 이벤트)으로 보존,
  attempt 증가.
- 정책 deny 아티팩트(rejected AND resolver_id IS NULL)는 재도전 대상이 아니다 — 하드블록 보존.
  사람-reject여도 현재 정책이 deny면 재개방하지 않는다.
- 플래그 미지정(기존 호출자 전부)은 완전 무변경.
"""
from __future__ import annotations

import contextlib
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# create_all/drop_all로 자체 스키마 직접 관리 — 격리 DB 전용(conftest 가드).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _asyncpg_url() -> str:
    return _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


@contextlib.asynccontextmanager
async def _db():
    """격리 DB에 전 모델 스키마 create_all → 단일 세션 → drop_all.

    fixture가 아니라 테스트 본문 내 컨텍스트 매니저 — asyncpg 커넥션이 테스트와 다른 이벤트 루프에
    붙는 문제(fixture 루프 ≠ 테스트 루프) 회피. 기존 실-DB 테스트(test_merge_verdict_gate.py의
    test_new_contributor_no_self_bootstrap_real_db)와 동일 패턴.
    """
    if not _REAL_DB_URL:
        pytest.skip("PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정")
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 모델 메타데이터 로드
    # __init__이 전 모듈을 로드하지 않아 FK 대상 테이블이 빠질 수 있다 — 명시 로드(기존 실-DB 테스트 동형).
    from app.models import gate, hitl_config, participation, pm, verdict  # noqa: F401

    engine = create_async_engine(_asyncpg_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            yield s
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


async def _seed_role(session, org: uuid.UUID) -> uuid.UUID:
    from app.models.participation import ParticipationRole

    role_id = uuid.uuid4()
    session.add(ParticipationRole(id=role_id, org_id=org, key="implementation",
                                  label="구현", is_default=True))
    await session.flush()
    return role_id


async def _seed_gate(session, org: uuid.UUID, work_item: uuid.UUID, *, status: str,
                     resolver: uuid.UUID | None, facts: dict | None = None):
    """사람-reject/정책-deny 게이트 상태를 직접 시드(사람 판정 이후의 DB 상태 재현)."""
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org, work_item_id=work_item, work_item_type="story",
        gate_type="merge", status=status, resolver_id=resolver,
        resolved_at=datetime.now(timezone.utc) if status != "pending" else None,
        resolution_note="ac 근거 부족 — 재작업" if resolver else None,
        neutral_facts=facts,
    )
    session.add(gate)
    await session.flush()
    return gate


def _patch_ask():
    return patch("app.services.gate_service.resolve_disposition", AsyncMock(return_value="ask"))


@pytest.mark.anyio
async def test_human_rejected_reopen_reopens_same_gate_as_pending():
    """핵심: 사람 reject 게이트 + reopen 플래그 → 같은 행이 pending으로 재개방(2차 시도).

    이전 판정은 resolution_history 스냅샷으로 보존(누가·언제·왜), resolver/노트는 리셋,
    attempt=2, 호출자 neutral_facts 병합.
    """
    from app.services.gate_service import create_gate

    org, story, member, resolver = (uuid.uuid4() for _ in range(4))
    async with _db() as s:
        role_id = await _seed_role(s, org)
        first = await _seed_gate(s, org, story, status="rejected", resolver=resolver)

        with _patch_ask():
            got = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                neutral_facts={"ci_result": "pass"},
                reopen_after_human_reject=True,
            )

        assert got.id == first.id, "유니크 제약상 같은 행을 재개방해야 함"
        assert got.status == "pending"
        assert got.resolver_id is None and got.resolution_note is None
        assert got.resolved_at is None
        assert got.neutral_facts["attempt"] == 2
        assert got.neutral_facts["ci_result"] == "pass", "호출자 neutral_facts 병합"
        hist = got.neutral_facts["resolution_history"]
        assert len(hist) == 1
        assert hist[0]["status"] == "rejected"
        assert hist[0]["resolver_id"] == str(resolver)
        assert hist[0]["resolution_note"] == "ac 근거 부족 — 재작업"
        assert hist[0]["attempt"] == 1


@pytest.mark.anyio
async def test_human_rejected_without_flag_returns_existing():
    """플래그 미지정(기존 호출자) → 기존 rejected 그대로 반환. 완전 무변경."""
    from app.services.gate_service import create_gate

    org, story, member, resolver = (uuid.uuid4() for _ in range(4))
    async with _db() as s:
        role_id = await _seed_role(s, org)
        first = await _seed_gate(s, org, story, status="rejected", resolver=resolver)
        got = await create_gate(s, org, story, "story", "merge", member, role_id)
        assert got.id == first.id and got.status == "rejected"
        assert got.resolver_id == resolver


@pytest.mark.anyio
async def test_policy_deny_artifact_not_reopened():
    """정책 deny 아티팩트(resolver_id 없음) → 플래그가 켜져도 재도전 금지(하드블록 보존)."""
    from app.services.gate_service import create_gate

    org, story, member = (uuid.uuid4() for _ in range(3))
    async with _db() as s:
        role_id = await _seed_role(s, org)
        first = await _seed_gate(s, org, story, status="rejected", resolver=None)
        got = await create_gate(
            s, org, story, "story", "merge", member, role_id,
            reopen_after_human_reject=True,
        )
        assert got.id == first.id and got.status == "rejected"
        assert got.neutral_facts is None, "재개방 안 됐으니 facts 불변"


@pytest.mark.anyio
async def test_human_rejected_under_deny_policy_stays_rejected():
    """사람-reject여도 현재 정책이 deny면 재개방하지 않는다 — 조직 하드블록 의도 우선."""
    from app.services.gate_service import create_gate

    org, story, member, resolver = (uuid.uuid4() for _ in range(4))
    async with _db() as s:
        role_id = await _seed_role(s, org)
        first = await _seed_gate(s, org, story, status="rejected", resolver=resolver)
        with patch("app.services.gate_service.resolve_disposition",
                   AsyncMock(return_value="deny")):
            got = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                reopen_after_human_reject=True,
            )
        assert got.id == first.id and got.status == "rejected"
        assert got.resolver_id == resolver, "판정 기록 불변"


@pytest.mark.anyio
async def test_pending_and_approved_idempotency_unchanged():
    """pending·approved 게이트는 플래그와 무관하게 기존 반환(멱등 불변)."""
    from app.services.gate_service import create_gate

    for status in ("pending", "approved"):
        org, story, member, resolver = (uuid.uuid4() for _ in range(4))
        async with _db() as s:
            role_id = await _seed_role(s, org)
            first = await _seed_gate(
                s, org, story, status=status,
                resolver=resolver if status == "approved" else None,
            )
            got = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                reopen_after_human_reject=True,
            )
            assert got.id == first.id and got.status == status, f"status={status}는 기존 반환이어야"


@pytest.mark.anyio
async def test_reopened_pending_gate_not_reopened_again():
    """재개방 후 재호출(같은 시도 내 재평가) → pending 그대로 반환, attempt 이중 증가 금지."""
    from app.services.gate_service import create_gate

    org, story, member, resolver = (uuid.uuid4() for _ in range(4))
    async with _db() as s:
        role_id = await _seed_role(s, org)
        await _seed_gate(s, org, story, status="rejected", resolver=resolver)
        with _patch_ask():
            reopened = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                reopen_after_human_reject=True,
            )
            again = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                reopen_after_human_reject=True,
            )
        assert again.id == reopened.id
        assert again.status == "pending"
        assert again.neutral_facts["attempt"] == 2, "재평가가 attempt를 또 올리면 안 됨"


@pytest.mark.anyio
async def test_second_reject_reopens_as_third_attempt_with_full_history():
    """2차 시도도 reject되면 3차로 재개방 — attempt 단조 증가, 이력 2건 누적."""
    from app.services.gate_service import create_gate

    org, story, member, resolver = (uuid.uuid4() for _ in range(4))
    async with _db() as s:
        role_id = await _seed_role(s, org)
        await _seed_gate(
            s, org, story, status="rejected", resolver=resolver,
            facts={"attempt": 2, "resolution_history": [
                {"attempt": 1, "status": "rejected", "resolver_id": str(resolver),
                 "resolved_at": None, "resolution_note": "1차 사유"},
            ]},
        )
        with _patch_ask():
            got = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                reopen_after_human_reject=True,
            )
        assert got.status == "pending"
        assert got.neutral_facts["attempt"] == 3
        hist = got.neutral_facts["resolution_history"]
        assert [h["attempt"] for h in hist] == [1, 2]


# ── evaluate_merge_gate 배선: merge 경로만 reopen 플래그를 켠다 ────────────────────

@pytest.mark.anyio
async def test_evaluate_merge_gate_passes_reopen_flag():
    from app.services import merge_verdict_gate as mod
    from app.services.merge_verdict_gate import evaluate_merge_gate

    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())
    gate = SimpleNamespace(id=uuid.uuid4(), status="pending")
    with patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=part)), \
         patch.object(mod, "_role_key", AsyncMock(return_value="implementation")), \
         patch.object(mod, "capture_pr_ci_verdict",
                      AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})), \
         patch.object(mod, "compute_member_trust_scores", AsyncMock(return_value={"scores": []})), \
         patch.object(mod, "resolve_work_item_project_id", AsyncMock(return_value=uuid.uuid4())), \
         patch.object(mod, "create_gate", AsyncMock(return_value=gate)) as create_spy:
        await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=7, repo="o/r", ci_result="pass", pr_result="pass",
        )
    assert create_spy.await_args.kwargs.get("reopen_after_human_reject") is True, (
        "merge 게이트 평가는 사람-reject 재도전 경로를 켜야 한다"
    )


# ── SPR-34 이벤트 원장: 재개방 게이트의 2차 판정도 gate.resolved를 발행해야 한다 ────────

async def _seed_event_deps(s, org, project, recipient):
    """events FK(team_members·projects) 우회 시드 — 기존 실-DB 테스트와 동일하게 replica 모드."""
    from sqlalchemy import text as _text
    await s.execute(_text("SET session_replication_role = replica"))


def _origin(story: uuid.UUID, project: uuid.UUID, recipient: uuid.UUID) -> dict:
    return {
        "schema_version": 1, "story_id": str(story), "project_id": str(project),
        "evidence_id": str(uuid.uuid4()), "recipient_id": str(recipient),
        "claim_hash": "deadbeef",
    }


@pytest.mark.anyio
async def test_second_attempt_resolution_emits_second_event():
    """1차 reject 이벤트가 있어도, 재개방(attempt=2) 후 판정은 **새 gate.resolved를 발행**해야 한다.

    도그푸드 2차 실측(2026-07-19): 멱등 가드가 (gate, recipient) 기준이라 2차 approve 이벤트가
    삼켜져 에이전트가 승인 통보를 못 받았다 — 멱등 키는 시도(attempt)당이어야 한다.
    """
    from sqlalchemy import select as _select

    from app.models.event import Event
    from app.services.gate_service import _emit_advisor_resolution_event

    org, project, story, recipient, resolver = (uuid.uuid4() for _ in range(5))
    async with _db() as s:
        await _seed_event_deps(s, org, project, recipient)
        gate = await _seed_gate(s, org, story, status="rejected", resolver=resolver)
        origin = _origin(story, project, recipient)

        # 1차 판정(reject) 이벤트 발행 — attempt 1.
        await _emit_advisor_resolution_event(s, gate, origin, "rejected", resolver, "1차 사유")

        # 재개방 상태 재현: attempt=2 + 판정 리셋 후 2차 approve.
        gate.status = "approved"
        gate.neutral_facts = {"attempt": 2, "advisor_origin": origin}
        gate.resolved_at = datetime.now(timezone.utc)
        await s.flush()
        await _emit_advisor_resolution_event(s, gate, origin, "approved", resolver, "승인")

        events = (await s.execute(
            _select(Event).where(Event.source_entity_id == gate.id).order_by(Event.created_at)
        )).scalars().all()
        assert len(events) == 2, "시도당 1개 — 2차 판정 이벤트가 삼켜지면 안 됨"
        assert events[0].payload["status"] == "rejected"
        assert events[1].payload["status"] == "approved"
        assert events[1].payload["next_stage"] == "done"
        assert events[1].payload.get("attempt") == 2


@pytest.mark.anyio
async def test_same_attempt_resolution_still_dedupes():
    """같은 시도 내 중복 발행(재시도/replay)은 여전히 1개로 멱등 — 기존 보장 보존."""
    from sqlalchemy import select as _select

    from app.models.event import Event
    from app.services.gate_service import _emit_advisor_resolution_event

    org, project, story, recipient, resolver = (uuid.uuid4() for _ in range(5))
    async with _db() as s:
        await _seed_event_deps(s, org, project, recipient)
        gate = await _seed_gate(s, org, story, status="rejected", resolver=resolver)
        origin = _origin(story, project, recipient)
        await _emit_advisor_resolution_event(s, gate, origin, "rejected", resolver, "사유")
        await _emit_advisor_resolution_event(s, gate, origin, "rejected", resolver, "사유")
        events = (await s.execute(
            _select(Event).where(Event.source_entity_id == gate.id)
        )).scalars().all()
        assert len(events) == 1


# ── SPR-34 리뷰 반영: advisor_origin 캐리포워드 + 컨텍스트의 reject-이력 복원 ─────────

@pytest.mark.anyio
async def test_reopen_carries_forward_advisor_origin_when_no_new_claim():
    """재보고에 새 claim이 없어도 이전 advisor_origin이 이월돼야 한다 — 지워지면 이후 사람
    판정의 gate.resolved 발행이 origin 부재로 생략돼 에이전트가 통보를 못 받는다."""
    from app.services.gate_service import create_gate

    org, story, member, resolver, recipient = (uuid.uuid4() for _ in range(5))
    origin = {"schema_version": 1, "story_id": str(story), "project_id": str(uuid.uuid4()),
              "evidence_id": str(uuid.uuid4()), "recipient_id": str(recipient),
              "claim_hash": "cafebabe"}
    async with _db() as s:
        role_id = await _seed_role(s, org)
        await _seed_gate(s, org, story, status="rejected", resolver=resolver,
                         facts={"advisor_origin": origin})
        with _patch_ask():
            got = await create_gate(
                s, org, story, "story", "merge", member, role_id,
                neutral_facts={"ci_result": "pass"},  # 새 claim 없음
                reopen_after_human_reject=True,
            )
        assert got.status == "pending"
        assert got.neutral_facts["advisor_origin"] == origin, "origin 이월 필수"
        assert got.neutral_facts["ci_result"] == "pass"


@pytest.mark.anyio
async def test_advisor_context_restores_reject_from_resolution_history():
    """재개방으로 status/resolver가 리셋된 게이트의 과거 reject가 advisor 컨텍스트
    prior_decisions에 resolution_history 스냅샷으로 복원돼야 한다(reject-학습 신호 유지)."""
    from sqlalchemy import text as _text

    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.advisor_context import build_context

    org, project, story_id, resolver = (uuid.uuid4() for _ in range(4))
    async with _db() as s:
        await s.execute(_text("SET session_replication_role = replica"))
        story = Story(id=story_id, org_id=org, project_id=project,
                      title="reopen ctx", status="in-progress")
        s.add(story)
        s.add(Gate(
            id=uuid.uuid4(), org_id=org, work_item_id=story_id, work_item_type="story",
            gate_type="merge", status="pending", resolver_id=None,
            neutral_facts={"attempt": 2, "resolution_history": [
                {"attempt": 1, "status": "rejected", "resolver_id": str(resolver),
                 "resolved_at": "2026-07-19T13:00:00+00:00",
                 "resolution_note": "ac 근거 부족 — 재작업"},
            ]},
        ))
        await s.flush()

        ctx = await build_context(s, story, max_prior_decisions=5)
        prior = ctx["data"]["prior_decisions"]
        notes = [d.get("resolution_note") for d in prior]
        assert "ac 근거 부족 — 재작업" in notes, f"history 복원 실패: {prior}"
        statuses = [d.get("status") for d in prior]
        assert "rejected" in statuses

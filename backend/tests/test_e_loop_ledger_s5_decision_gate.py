"""E-LOOP-LEDGER S5(story f07b7a52): POST /api/v2/loops/{loop_id}/decision 검증.

결정은 variant_group(슬롯) 단위(선생님 결정#2, 오르테가 크루 정정) — loop 전체 1개 아님.
S5 고유 가치(비-tautological):
ⓐ 이유 필수화(choose/rejection_reason min_length=1) — 스키마 레벨 구조적 거부.
ⓑ human-only — gate_service._ALWAYS_MANUAL_GATE_TYPES + 라우터 명시 체크 이중.
ⓒ 슬롯별 ARTIFACT_SET_MISMATCH(초과/누락) + NO_PENDING_ARTIFACTS_IN_GROUP.
ⓓ 부분 결정: 일부 그룹만 결정 시 loop 'deciding' 유지(전 슬롯 결판나야 executing 전이).
ⓔ 재-결정 방지(GATE_ALREADY_RESOLVED) + LOOP_NOT_IN_DECIDING_STATE.
ⓕ 단일슬롯 chosen_artifact_id stamp vs 다중슬롯 NULL 유지.
ⓖ 1콜 내 다중 그룹 중 하나가 실패하면(같은 트랜잭션) 앞서 처리된 그룹도 rollback 시 원복
   (BaseRepository/create_gate/transition_gate 전부 flush만·commit 안 함을 실 DB로 실증 —
   get_db 의존성의 except:rollback 패턴이 실제로 지킬 무결성 조건).

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import loops as r
from app.schemas.loop import LoopArtifactRejection, LoopDecisionRequest, VariantGroupDecision

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ⓐⓑ 구조 검증(유닛, DB 불요) ─────────────────────────────────────────────

def test_error_status_map_covers_decision_codes():
    expected = {
        "LOOP_NOT_IN_DECIDING_STATE", "GATE_ALREADY_RESOLVED",
        "NO_PENDING_ARTIFACTS_IN_GROUP", "ARTIFACT_SET_MISMATCH", "INVALID_LOOP_TRANSITION",
    }
    assert expected <= set(r._ERROR_STATUS)


def test_variant_group_decision_has_single_chosen_field_not_list():
    # 구조상 그룹당 chosen은 정확히 1개 필드(list 아님) — API가 2 chosen을 애초에 표현 불가.
    fields = VariantGroupDecision.model_fields
    assert fields["chosen_artifact_id"].annotation is uuid.UUID


def test_choose_reason_empty_raises_validation_error():
    with pytest.raises(ValidationError):
        VariantGroupDecision(
            variant_group="headline", chosen_artifact_id=uuid.uuid4(), choose_reason="",
            rejections=[],
        )


def test_rejection_reason_empty_raises_validation_error():
    with pytest.raises(ValidationError):
        LoopArtifactRejection(artifact_id=uuid.uuid4(), rejection_reason="")


def test_decisions_list_requires_at_least_one_entry():
    with pytest.raises(ValidationError):
        LoopDecisionRequest(decisions=[])


# ── realdb ───────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("1f000000-0000-0000-0000-000000000001")
USER = uuid.UUID("1f000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("1f000000-0000-0000-0000-0000000000b1")
AGENT = uuid.UUID("1f000000-0000-0000-0000-0000000000d1")
PROJ_A = uuid.UUID("1f000000-0000-0000-0000-000000000002")


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _agent_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT), email=None,
        claims={"app_metadata": {"api_key_id": "ak_test", "org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _seed(s):
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM asset_links WHERE org_id='{ORG}'",
        f"DELETE FROM loop_artifacts WHERE org_id='{ORG}'",
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C1F','c1forg','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c1f.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}',NULL,'{AGENT}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_loop(s, status="deciding") -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=PROJ_A, title="L", goal_tags=[], status=status,
        created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _seed_artifact(s, loop_id, variant_group, variant_label) -> uuid.UUID:
    from app.models.asset import Asset
    from app.models.loop import LoopArtifact
    asset = Asset(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ_A, container="uploads",
        object_path=f"org/{ORG}/asset-{uuid.uuid4().hex[:8]}.png", name="a.png", size_bytes=1,
    )
    s.add(asset)
    await s.flush()
    artifact = LoopArtifact(
        id=uuid.uuid4(), org_id=ORG, loop_id=loop_id, asset_id=asset.id,
        variant_group=variant_group, variant_label=variant_label, decision="pending",
        created_by_member_id=uuid.uuid4(),
    )
    s.add(artifact)
    await s.commit()
    return artifact.id


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── ⓑ human-only ─────────────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_agent_forbidden_403():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            a1 = await _seed_artifact(s, loop_id, "headline", "A")
            a2 = await _seed_artifact(s, loop_id, "headline", "B")

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="headline", chosen_artifact_id=a1, choose_reason="best",
                        rejections=[LoopArtifactRejection(artifact_id=a2, rejection_reason="worse")],
                    )]),
                    session=s, auth=_agent_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "DECISION_HUMAN_ONLY"
    finally:
        await eng.dispose()


# ── ⓔ 전제 상태 ────────────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_loop_not_deciding_state_409():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, status="draft")
            a1 = await _seed_artifact(s, loop_id, "headline", "A")
            a2 = await _seed_artifact(s, loop_id, "headline", "B")

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="headline", chosen_artifact_id=a1, choose_reason="best",
                        rejections=[LoopArtifactRejection(artifact_id=a2, rejection_reason="worse")],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "LOOP_NOT_IN_DECIDING_STATE"
    finally:
        await eng.dispose()


# ── ⓖ 1콜 내 부분실패 원자성(까심 QA 지적 지점) ──────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_partial_failure_within_one_call_rolls_back_earlier_group():
    """decisions=[headline(유효), cta(mismatch)] 한 콜 — cta에서 실패하면 headline도
    session.rollback() 후 pending으로 원복돼야 한다(BaseRepository/create_gate/transition_gate가
    flush만 하고 commit하지 않는다는 설계를 실제 DB round-trip으로 실증 — get_db 의존성의
    except:rollback 패턴이 프로덕션에서 지킬 원자성을 여기서는 명시적으로 재현·검증한다)."""
    from app.repositories.loop import LoopRunRepository
    from app.services.loop import LoopServiceError, decide_loop_artifacts
    from app.services.member_resolver import resolve_member

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            h1 = await _seed_artifact(s, loop_id, "headline", "A")
            h2 = await _seed_artifact(s, loop_id, "headline", "B")
            c1 = await _seed_artifact(s, loop_id, "cta", "A")
            await _seed_artifact(s, loop_id, "cta", "B")

        async with Session() as s:
            loop = await LoopRunRepository(s, ORG).get(loop_id)
            caller = await resolve_member(_auth(), ORG, s, project_id=loop.project_id)
            with pytest.raises(LoopServiceError) as ei:
                await decide_loop_artifacts(
                    s, ORG, caller, loop,
                    LoopDecisionRequest(decisions=[
                        VariantGroupDecision(
                            variant_group="headline", chosen_artifact_id=h1, choose_reason="best",
                            rejections=[LoopArtifactRejection(artifact_id=h2, rejection_reason="worse")],
                        ),
                        VariantGroupDecision(
                            # cta: rejections 누락 — mismatch로 실패 유도(headline은 이미 flush됨).
                            variant_group="cta", chosen_artifact_id=c1, choose_reason="best cta",
                            rejections=[],
                        ),
                    ]),
                )
            assert ei.value.code == "ARTIFACT_SET_MISMATCH"
            # get_db 의존성이 실제로 하는 것과 동일: 예외 시 rollback.
            await s.rollback()

        # 완전히 새 세션/커넥션으로 재조회 — 커밋되지 않았다면 headline도 여전히 pending.
        async with Session() as s:
            from app.models.loop import LoopArtifact
            fetched_h1 = (await s.execute(select(LoopArtifact).where(LoopArtifact.id == h1))).scalar_one()
            fetched_h2 = (await s.execute(select(LoopArtifact).where(LoopArtifact.id == h2))).scalar_one()
            assert fetched_h1.decision == "pending", "headline chosen이 rollback 후에도 남아있으면 원자성 위반"
            assert fetched_h2.decision == "pending", "headline rejected이 rollback 후에도 남아있으면 원자성 위반"
    finally:
        await eng.dispose()


# ── ⓒ 그룹별 mismatch ─────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_artifact_set_mismatch_missing_rejection():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            a1 = await _seed_artifact(s, loop_id, "headline", "A")
            await _seed_artifact(s, loop_id, "headline", "B")  # 누락 — rejections에 안 넣음

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="headline", chosen_artifact_id=a1, choose_reason="best",
                        rejections=[],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "ARTIFACT_SET_MISMATCH"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_decide_artifact_set_mismatch_extra_unrelated_artifact():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            a1 = await _seed_artifact(s, loop_id, "headline", "A")
            a2 = await _seed_artifact(s, loop_id, "headline", "B")

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="headline", chosen_artifact_id=a1, choose_reason="best",
                        rejections=[
                            LoopArtifactRejection(artifact_id=a2, rejection_reason="worse"),
                            LoopArtifactRejection(artifact_id=uuid.uuid4(), rejection_reason="ghost"),
                        ],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "ARTIFACT_SET_MISMATCH"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_decide_no_pending_artifacts_in_group_422():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            # headline 아티팩트 아예 없음(오타/미존재 그룹).

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="typo-group", chosen_artifact_id=uuid.uuid4(),
                        choose_reason="best", rejections=[],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "NO_PENDING_ARTIFACTS_IN_GROUP"
    finally:
        await eng.dispose()


# ── ⓔ gate가 loop.status와 별개로 이미 종결된 방어적 엣지케이스 ─────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_gate_already_resolved_while_loop_still_deciding_409():
    """loop.status='deciding'인데 그 loop의 gate가 (예: 외부/직접 경로로) 이미 approved인
    비정상 상태 — decide_loop_artifacts는 LOOP_NOT_IN_DECIDING_STATE 이전에 이 gate 체크로
    막혀야 한다(실제로는 loop.status가 deciding이라 그 체크는 통과하고 gate 체크가 잡음)."""
    from app.services.gate_service import create_gate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            a1 = await _seed_artifact(s, loop_id, "headline", "A")
            await _seed_artifact(s, loop_id, "headline", "B")
            gate = await create_gate(
                s, ORG, loop_id, "loop", "loop_decision", OM, uuid.uuid4(),
                neutral_facts={"requested_by_member_id": str(OM)},
            )
            gate.status = "approved"
            await s.commit()

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="headline", chosen_artifact_id=a1, choose_reason="x",
                        rejections=[],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "GATE_ALREADY_RESOLVED"
    finally:
        await eng.dispose()


# ── ⓕ 성공: 단일슬롯 → executing + chosen_artifact_id stamp ────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_single_group_success_transitions_and_stamps_chosen():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            a1 = await _seed_artifact(s, loop_id, "headline", "A")
            a2 = await _seed_artifact(s, loop_id, "headline", "B")

        async with Session() as s:
            out = await r.decide_loop(
                loop_id=loop_id,
                body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                    variant_group="headline", chosen_artifact_id=a1, choose_reason="best copy",
                    rejections=[LoopArtifactRejection(artifact_id=a2, rejection_reason="weaker CTA")],
                )]),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()
            assert out.all_groups_decided is True
            assert out.gate_status == "approved"
            assert out.loop.status == "executing"
            assert out.loop.chosen_artifact_id == a1

        async with Session() as s:
            from app.models.gate import Gate
            from app.models.loop import LoopArtifact
            chosen = (await s.execute(select(LoopArtifact).where(LoopArtifact.id == a1))).scalar_one()
            rejected = (await s.execute(select(LoopArtifact).where(LoopArtifact.id == a2))).scalar_one()
            assert chosen.decision == "chosen" and chosen.choose_reason == "best copy"
            assert rejected.decision == "rejected" and rejected.rejection_reason == "weaker CTA"
            gate = (await s.execute(
                select(Gate).where(Gate.org_id == ORG, Gate.work_item_id == loop_id, Gate.gate_type == "loop_decision")
            )).scalar_one()
            assert gate.status == "approved"
            assert gate.resolver_id == OM
    finally:
        await eng.dispose()


# ── ⓓⓕ 부분 결정: 다중슬롯 → 전 슬롯 결판나야 executing, chosen_artifact_id NULL 유지 ──────

@pytestmark_db
@pytest.mark.anyio
async def test_decide_multi_group_partial_then_complete():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s)
            h1 = await _seed_artifact(s, loop_id, "headline", "A")
            h2 = await _seed_artifact(s, loop_id, "headline", "B")
            c1 = await _seed_artifact(s, loop_id, "cta", "A")
            c2 = await _seed_artifact(s, loop_id, "cta", "B")

        # 1단계: headline만 결정 — 전 슬롯 미결판(cta 남음).
        async with Session() as s:
            out1 = await r.decide_loop(
                loop_id=loop_id,
                body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                    variant_group="headline", chosen_artifact_id=h1, choose_reason="best",
                    rejections=[LoopArtifactRejection(artifact_id=h2, rejection_reason="worse")],
                )]),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()
            assert out1.all_groups_decided is False
            assert out1.loop.status == "deciding"
            assert out1.loop.chosen_artifact_id is None

        # 재-결정(headline) 시도는 이미 pending 0이라 NO_PENDING_ARTIFACTS_IN_GROUP.
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="headline", chosen_artifact_id=h1, choose_reason="again",
                        rejections=[],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "NO_PENDING_ARTIFACTS_IN_GROUP"

        # 2단계: cta 결정 — 전 슬롯 결판(executing 전이). 2개 distinct group이라 chosen_artifact_id는 NULL 유지.
        async with Session() as s:
            out2 = await r.decide_loop(
                loop_id=loop_id,
                body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                    variant_group="cta", chosen_artifact_id=c1, choose_reason="best cta",
                    rejections=[LoopArtifactRejection(artifact_id=c2, rejection_reason="weak cta")],
                )]),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()
            assert out2.all_groups_decided is True
            assert out2.loop.status == "executing"
            assert out2.loop.chosen_artifact_id is None  # 다중슬롯 — SSOT는 loop_artifacts.decision

        # 재-결정 완전 종결 후 시도 → 409(loop이 이미 'executing'으로 떠나 LOOP_NOT_IN_DECIDING_STATE가
        # GATE_ALREADY_RESOLVED보다 먼저 잡힌다 — loop.status가 deciding일 때만 gate 체크까지 도달하므로,
        # 이 시나리오에서 더 정확한 신호. GATE_ALREADY_RESOLVED는 gate가 loop.status와 별개로 외부
        # 경로(generic gates.py)로 먼저 종결되는 방어적 엣지케이스용 — 별도 유닛으로 커버).
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.decide_loop(
                    loop_id=loop_id,
                    body=LoopDecisionRequest(decisions=[VariantGroupDecision(
                        variant_group="cta", chosen_artifact_id=c1, choose_reason="again",
                        rejections=[],
                    )]),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "LOOP_NOT_IN_DECIDING_STATE"
    finally:
        await eng.dispose()

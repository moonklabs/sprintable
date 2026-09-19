"""story #4042(E-RECIPE-1 ②, 페드루 PO 確定 2026-09-18 — 민 레군 프로브 실측 반영) —
evidence `payload.kind` fail-closed 화이트리스트(`_EVIDENCE_KIND_TYPE_REGISTRY`,
app/routers/evidence.py) 실증.

민 레군이 직접 실측으로 잡은 결함(2026-09-18) — `_validate_and_normalize_evidence_payload`
가 아는 kind 2종(generation_cost·verification_sheet)만 검증하고 그 밖은 else 없이 그냥
통과시켰다(`sprintable_add_evidence(kind="concept_brief", type="report")`가 실제로
201). 이 파일은 그 반대(수정 후 미등재 kind는 422)를 실증하고, 페드루 PO 후속 제안(kind→
type 페어링까지)도 같이 고정한다 — kind는 맞는데 type을 잘못 실으면(예: generation_cost를
type="report"로) `generation_budget.py::compute_generation_budget_status`가
`Evidence.type=="metric"`으로만 필터해 그 지출이 예산 합산에서 조용히 사라지는 데이터
유실 클래스를 막는다.

HTTP 계층 하네스는 test_3561_concept_approval_gate.py의 기존 인프라(`_setup_org_scoped_
app`의 `override_db_and_read` — story #2451 §6 root-fix, get_db·get_read_db 둘 다 항상
같은 provider)를 그대로 재사용한다(중복 재발명 금지, test_3498_..._evidence_and_config.py
류의 "작은 헬퍼는 import" 관례와 동형).
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3561_concept_approval_gate import (
    _client_for,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


# ─── 단위 축 — 레지스트리 자체(DB 불요) ─────────────────────────────────────────


def test_registry_pairs_generation_cost_with_metric_and_creative_kinds_with_report():
    """페드루 PO 후속 제안(2026-09-18 06:45Z)·민 레군 실측 표(06:46Z)와 정확히 일치."""
    from app.routers.evidence import _EVIDENCE_KIND_TYPE_REGISTRY

    assert _EVIDENCE_KIND_TYPE_REGISTRY == {
        "generation_cost": "metric",
        "verification_sheet": "report",
        "material_collection_sheet": "report",
        "concept_brief": "report",
        "storyboard": "report",
        "animatic": "report",
    }


# ─── 실행 축(realdb, HTTP 계층) ─────────────────────────────────────────────────


async def _create_evidence(client, *, work_item_id, work_item_type="story", evidence_type, payload, ref="probe"):
    return await client.post(
        "/api/v2/evidence",
        json={
            "work_item_id": str(work_item_id), "work_item_type": work_item_type,
            "type": evidence_type, "ref": ref, "payload": payload,
        },
    )


@pytest.mark.anyio
async def test_unregistered_kind_rejected_422_where_it_used_to_pass_201():
    """⭐음성 대조(AC4) — 이 카드 착수 전엔 이 정확한 호출이 201이었다(민 레군 프로브
    2026-09-18 06:03Z 실측). 수정 후 422 EVIDENCE_PAYLOAD_INVALID여야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="report",
                payload={"kind": "totally_unregistered_kind", "note": "오타 시나리오"},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
        assert "totally_unregistered_kind" in r.json()["error"]["message"]
    finally:
        await engine.dispose()


@pytest.mark.parametrize("bad_kind", [["a", "b"], {"x": 1}, 123, True, 1.5])
@pytest.mark.anyio
async def test_non_string_kind_rejected_422_not_crashed(bad_kind):
    """카디르 QA 지적(2026-09-19) — payload.kind가 list/dict 등 unhashable이면
    `_EVIDENCE_KIND_TYPE_REGISTRY.get(kind)`가 TypeError를 던져 fail-closed 422
    대신 미처리 크래시(fail-crash)로 샜다. 문자열이 아닌 kind는 전부 "등재되지
    않은 kind" 422로 fail-closed 되어야 한다(500/크래시 절대 금지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="report",
                payload={"kind": bad_kind},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_kind_registered_but_wrong_type_rejected_422_data_loss_class():
    """⭐페드루 PO 후속 제안 — kind는 맞는데 type을 틀리면(여기선 generation_cost를
    type="report"로) 예산 합산에서 조용히 사라지는 클래스라 등록 시점에 거부."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="report",
                payload={"kind": "generation_cost", "cost_minor": 1000, "currency": "KRW"},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
        assert "metric" in r.json()["error"]["message"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["material_collection_sheet", "concept_brief", "storyboard", "animatic"])
async def test_creative_kinds_accepted_with_type_report(kind):
    """AC3 — 크리에이티브 5종(+기존 generation_cost) 중 4종이 type="report"로 통과."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="report",
                payload={"kind": kind, "note": "shape 검증은 후속 정련 — 존재+type만 확인"},
            )
        assert r.status_code == 201, r.text
        assert r.json()["payload"]["kind"] == kind
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_creative_kind_with_wrong_type_rejected_422():
    """크리에이티브 kind도 페어링 축을 똑같이 탄다(generation_cost 전용 특례가 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="metric",
                payload={"kind": "storyboard", "shot_list": []},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_payload_without_kind_field_unaffected_regression_zero():
    """회귀 0 — kind가 없는 payload(예: 채널 인사이트 metric류)는 이 축의 검사 대상이
    아니다. 새 규칙을 안 만든다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="metric",
                payload={"impressions": 100, "reach": 80},
            )
        assert r.status_code == 201, r.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac4_live_probe_payloads_still_pass_after_fix():
    """⭐AC4 정확한 음성 대조 — 민 레군의 라이브 evidence 2건(concept_brief 3c2b4fc1·
    storyboard 442e8cc3, dev org에서 실측)과 동일한 (type, payload) 조합을 재현해 여전히
    201인지 확인(회귀 0 — 등록된 kind는 수정 후에도 그대로 통과해야 한다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            concept_r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="report",
                ref="probe:concept_brief-kind-router-whitelist-check",
                payload={
                    "kind": "concept_brief", "concept": "테스트 컨셉 프로브",
                    "rationale": "라우터 kind 화이트리스트 실측용 — 실제 크리에이터 산출물 아님",
                },
            )
            storyboard_r = await _create_evidence(
                client, work_item_id=story_id, evidence_type="report",
                ref="creator-slot-demo:storyboard",
                payload={
                    "kind": "storyboard",
                    "shot_list": [{"shot_no": 1, "angle": "wide", "duration_sec": 3, "desc": "데모"}],
                    "emotion_beats": [{"beat_no": 1, "shot_no": 1, "emotion": "안정"}],
                },
            )
        assert concept_r.status_code == 201, concept_r.text
        assert storyboard_r.status_code == 201, storyboard_r.text
    finally:
        await engine.dispose()

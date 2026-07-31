"""story #2224 후속(오르테가 판정, 2026-07-31) — 문(게이트) 레이어 BE 계약 실PG 검증.

미르코의 라이브 실측(「막힌 28」이 [E-ARCH]13·[E-GCE-RT]7·[E-POLISH]5·E-CONNECT3, 4개
목표에 뭉쳐 있음)이 근거 — 노드 위에 문을 그리려면 어느 노드가 막혔는지가 필요한데
`FlowNode`에 gate 필드가 아예 없었다(전수 확認, PR 본문 참조).

핵심 판정:
  ①`FlowNode.gate_pending`/`gate_reason` — 새 쿼리 없이 기존 blocked_ids에서 파생.
  ②「막힘」 정의 넓힘 — evidence_status='insufficient' 못박기를 뺀다(doc_approval 등
    evidence_status가 구조적으로 항상 NULL인 게이트 타입을 이제 잡는다).
  ③넓히기 前후 실측 수가 같음(회귀 없음) — 옛 좁은 필터로도 잡히던 케이스는 그대로.
  ④두 형제 화면(lane["blocked"] · EpicFlowNodesResponse.blocked_count/gate_pending)이
    «같은 조건»(`_blocked_story_evidence`)에서 나와 갈릴 수 없음을 왕복으로 확認.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_2301_story_body_mentions_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
    _setup_app_human,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_epic_with_gates(s, org, project):
    from app.models.pm import Goal
    epic = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic")
    s.add(epic)
    await s.commit()

    # evidence_status='insufficient' — 옛 좁은 필터로도 이미 blocked였던 케이스.
    story_merge_blocked = await _make_story(s, org.id, project.id, title="MERGE_BLOCKED")
    story_merge_blocked.epic_id = epic.id
    story_merge_blocked.status = "in-progress"

    # requires_human=True·pending인데 evidence_status=None(doc_approval류 흉내) — 옛
    # 좁은 필터에서는 blocked 밖(㉡)이었으나 넓힌 정의에서는 blocked에 들어가야 함.
    story_doc_approval_blocked = await _make_story(s, org.id, project.id, title="DOC_APPROVAL_BLOCKED")
    story_doc_approval_blocked.epic_id = epic.id
    story_doc_approval_blocked.status = "in-progress"

    # requires_human=False — 넓혀도 여전히 blocked 밖(음성대조, 옛 테스트와 동일 취지).
    story_not_blocked = await _make_story(s, org.id, project.id, title="NOT_BLOCKED")
    story_not_blocked.epic_id = epic.id
    story_not_blocked.status = "in-progress"

    await s.commit()

    from app.models.gate import Gate
    s.add_all([
        Gate(
            id=uuid.uuid4(), org_id=org.id, work_item_id=story_merge_blocked.id,
            work_item_type="story", gate_type="merge", status="pending",
            requires_human=True, evidence_status="insufficient",
        ),
        Gate(
            id=uuid.uuid4(), org_id=org.id, work_item_id=story_doc_approval_blocked.id,
            work_item_type="story", gate_type="doc_approval", status="pending",
            requires_human=True, evidence_status=None,
        ),
        Gate(
            id=uuid.uuid4(), org_id=org.id, work_item_id=story_not_blocked.id,
            work_item_type="story", gate_type="merge", status="pending",
            requires_human=False, evidence_status=None,
        ),
    ])
    await s.commit()

    return {
        "epic": epic,
        "merge_blocked": story_merge_blocked,
        "doc_approval_blocked": story_doc_approval_blocked,
        "not_blocked": story_not_blocked,
    }


async def test_flow_node_carries_gate_pending_and_reason_for_evidence_insufficient():
    """①②③ — evidence_status='insufficient'(merge류)는 gate_pending=True·
    gate_reason='evidence_insufficient'로 실린다(옛 좁은 필터로도 이미 잡히던 케이스,
    넓혀도 그대로 잡혀야 회귀 없음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            seeded = await _seed_epic_with_gates(s, org, project)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(seeded["epic"].id)},
            )
            assert resp.status_code == 200, resp.text
            nodes = {n["id"]: n for n in resp.json()["now"]["items"]}

            merge_node = nodes[str(seeded["merge_blocked"].id)]
            assert merge_node["gate_pending"] is True
            assert merge_node["gate_reason"] == "evidence_insufficient"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_widened_definition_now_catches_requires_human_gate_without_evidence_status():
    """② — 넓힌 정의의 핵심 실증: evidence_status=None인 requires_human+pending 게이트
    (doc_approval류)가 이제 gate_pending=True로 잡힌다. 옛 좁은 필터(evidence_status=
    'insufficient' 못박기)였다면 이 노드는 gate_pending=False로 «영영» 안 잡혔을 것 —
    바로 미르코군이 지적한 "이름은 막힘 전체인데 실제로는 merge만 센다" 그 갭."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            seeded = await _seed_epic_with_gates(s, org, project)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(seeded["epic"].id)},
            )
            assert resp.status_code == 200, resp.text
            nodes = {n["id"]: n for n in resp.json()["now"]["items"]}

            doc_node = nodes[str(seeded["doc_approval_blocked"].id)]
            assert doc_node["gate_pending"] is True, "requires_human+pending인데 evidence_status=None인 게이트가 안 잡힘(넓힘 실패)"
            assert doc_node["gate_reason"] == "pending_approval"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_requires_human_false_still_excluded_after_widening():
    """음성대조 — requires_human=False는 넓혀도 여전히 gate_pending=False다(넓힌 것은
    evidence_status 못박기뿐, requires_human 조건은 그대로)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            seeded = await _seed_epic_with_gates(s, org, project)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(seeded["epic"].id)},
            )
            assert resp.status_code == 200, resp.text
            nodes = {n["id"]: n for n in resp.json()["now"]["items"]}

            not_blocked_node = nodes[str(seeded["not_blocked"].id)]
            assert not_blocked_node["gate_pending"] is False
            assert not_blocked_node["gate_reason"] is None, "gate_pending=False인데 gate_reason이 있으면 거짓말"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_blocked_count_reflects_widened_definition():
    """③ — blocked_count(에픽 단위 집계)도 넓힌 정의를 그대로 반영해 2건(merge+doc_approval)
    이어야 한다(옛 좁은 필터였다면 1건 — merge만)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            seeded = await _seed_epic_with_gates(s, org, project)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(seeded["epic"].id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["blocked_count"] == 2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_lane_blocked_and_flow_nodes_blocked_count_agree():
    """④ — 형제 화면 왕복 대조: get_epics_progress_lane의 lane["blocked"]와
    epic-flow-nodes의 blocked_count가 «같은 seed»에서 같은 수를 낸다(같은 자리
    `_blocked_story_evidence`를 쓰므로 갈릴 수 없다는 것을 값으로 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            seeded = await _seed_epic_with_gates(s, org, project)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            lane_resp = await client.get(
                "/api/v2/analytics/epics-progress-lane", params={"project_id": str(project.id)}
            )
            assert lane_resp.status_code == 200, lane_resp.text
            lane_blocked = lane_resp.json()["epics"][str(seeded["epic"].id)]["blocked"]

            nodes_resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(seeded["epic"].id)},
            )
            assert nodes_resp.status_code == 200, nodes_resp.text
            nodes_blocked_count = nodes_resp.json()["blocked_count"]

            assert lane_blocked == nodes_blocked_count == 2, (
                f"형제 화면이 갈림 — lane[blocked]={lane_blocked}, "
                f"epic-flow-nodes.blocked_count={nodes_blocked_count}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

"""story #1951 (E-MOBILE P1a-S1) — GET /api/v2/deeplink-manifest 서빙 엔드포인트.

PO 재정(3자 검토 스코프 확장)으로 story #1951에서 추가된 런타임 API. mcp.py의
/api/v2/mcp/manifest 테스트 패턴(test_e_mcp_s2_toolset.py)을 그대로 따른다.

story #1952(P1a-S2)에서 CI 정식 편입 — "draft" 딱지 제거(`test_deeplink_manifest_endpoint_draft.py`
→ 이 파일). 로직 변경 없음(3자 검토 확정 산출물 그대로 승격).
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.dependencies.auth import AuthContext, get_current_user
from app.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _override_auth():
    return AuthContext(
        user_id=str(uuid.uuid4()),
        email=None,
        claims={"app_metadata": {}},
        org_id=str(uuid.uuid4()),
    )


@pytest.mark.anyio
async def test_deeplink_manifest_endpoint_returns_200_with_schema_version_and_lookup_key():
    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/deeplink-manifest")
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 200
    body = resp.json()

    assert body["schema_version"] == 1
    assert isinstance(body["version_policy"], str) and body["version_policy"]
    # story #2617: conversation.unsupervised_chain_expired 신설로 33→34.
    # story #2624: doc_approval_resolved 신설로 34→35.
    # story #2630: conversation.circuit_breaker_opened 신설로 35→36.
    # story #2631: doc_approval_discussion_requested 신설로 36→37.
    # story #2709: agent_decision_resolved 신설로 37→38.
    # story #1715: merge_gate_resolved 신설로 38→39.
    # story #2789: agent_decision_withdrawn 신설로 39→40.
    # story #2747: doc_draft_discussed_in_chat 신설로 40→41.
    # story #4417: ads_boost_spend_unreadable 신설로 41→42.
    # story #4533: agent.permission_request 신설로 42→43.
    # story #4534: agent.turn_ended 신설로 43→44.
    assert isinstance(body["entries"], list) and len(body["entries"]) == 47  # story #4685: + agent.limit_paused · agent.limit_lifted · story 4863: + agent.restart_stopped

    # 미르코 point ②: lookup_key = f"{type}:{entity_type}" (구분자 ":") 서빙 시점 파생.
    story_entry = next(
        e for e in body["entries"]
        if e["app"]["type"] == "dispatched" and e["app"]["entity_type"] == "story"
    )
    assert story_entry["lookup_key"] == "dispatched:story"

    # entity_type=None인 단일-타겟 엔트리도 콜론 포함 형태로 파생돼야 한다(빈 두번째 절).
    gate_entry = next(e for e in body["entries"] if e["app"]["type"] == "gate.pending_approval")
    assert gate_entry["lookup_key"] == "gate.pending_approval:"

    # 미르코 point ①: nested 구조(app/payload/channel) + snake_case 유지 확인.
    assert set(story_entry.keys()) >= {"lookup_key", "app", "payload", "channel"}
    assert "parent_tab" in story_entry["app"]
    assert "required_payload" in story_entry["payload"]
    assert "channel_grade" in story_entry["channel"]


@pytest.mark.anyio
async def test_deeplink_manifest_endpoint_requires_auth():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/api/v2/deeplink-manifest")
    assert resp.status_code in (401, 403)


@pytest.mark.anyio
async def test_target_promotion_pending_policy_explained_in_response():
    """2026-07-21(오르테가 PO 확認 요청): target_promotion_pending 뜻이 BE 소스 코드
    (Pydantic Field description)에만 있고 실제 응답 payload엔 없던 갭 — 소비자가 raw JSON만
    보고도 플래그 의미를 알 수 있어야 한다."""
    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/deeplink-manifest")
    finally:
        app.dependency_overrides.clear()

    body = resp.json()
    assert isinstance(body["target_promotion_pending_policy"], str)
    assert body["target_promotion_pending_policy"]


@pytest.mark.anyio
async def test_task_completed_promoted_to_story_detail_semantic_target():
    """2026-07-21(오르테가 PO 확定): task_completed의 target이 웹 전용 URL 조립 컨벤션
    ("/board?story=")에서 다른 29개 엔트리와 동형인 순수 의미 식별자("story_detail")로
    승격됐다 — story #1953이 이미 payload에 실어둔 story_id를 그 발판으로 쓴다.
    target_promotion_pending=True(전용 모바일 라우트 신설 전까지 안전 폴백,
    gate_detail/artifact_detail과 동일 패턴)."""
    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/deeplink-manifest")
    finally:
        app.dependency_overrides.clear()

    body = resp.json()
    task_entry = next(e for e in body["entries"] if e["app"]["type"] == "task_completed")
    assert task_entry["app"]["target"] == "story_detail"
    assert not task_entry["app"]["target"].startswith("/")
    assert task_entry["app"]["target_promotion_pending"] is True
    assert "story_id" in task_entry["payload"]["required_payload"]


@pytest.mark.anyio
async def test_permission_request_released_to_the_inbox_approvals_tab_4972():
    """story 4972 (push landing): `agent.permission_request` is no longer a «지금» fallback — the inbox's 결재함 tab opens the
    request's card from `/inbox?tab=gates&request=<reference_id>`, so the entry names that screen and is NOT promotion-pending
    (the target-exists contract then checks the inbox page really is there). Putting it back on «now» goes RED here."""
    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/deeplink-manifest")
    finally:
        app.dependency_overrides.clear()

    entry = next(e for e in resp.json()["entries"] if e["app"]["type"] == "agent.permission_request")
    assert entry["app"]["target"] == "permission_request"
    assert entry["app"]["parent_tab"] == "approvals"
    assert entry["app"]["target_promotion_pending"] is False
    assert entry["app"]["return_policy"] == "synthesize_parent"  # (fallback_now would let a client drop the target and land on «지금»)
    # 알려진 차이(PO 8781 · 지침 해석 — 코드 결함 아님): 이 엔트리의 target/parent_tab이 바뀌었는데 schema_version은 1 그대로 — 런타임 소비자가 0이고(폰은 번들 스냅샷만 · 대조용)
    # 옛 폰은 이 type이 스냅샷에 없어 이미 기본 착지라서. MAJOR는 앞으로의 런타임 소비자 전체를 «지금» 탭으로 떨굼. 폰 번들 스냅샷(`lib/deeplinkManifest.snapshot.json`)은
    # 서버 dev 배포 뒤 «스냅샷 갱신» PR에서 맞추고, 그 PR에서 이 항(아래 한 줄)을 지움.
    assert resp.json()["schema_version"] == 1
    assert entry["payload"]["required_payload"] == ["reference_id"]

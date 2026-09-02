"""story #3282(지원운영 어드민 관제, 2026-09-01 PO 판정 확定판) — 어드민 신규
/conversations·/conversations/{id}/messages. 핵심 pin은 "방향① 확定": 에스컬레이트 안 한
대화도 전부 열람 가능해야 한다(에스컬만 보이면 실패) — test_admin_metrics.py의 인증 스캐폴딩
(require_admin, MOONKLABS_ORG_ID/OTHER_ORG_ID)을 그대로 재사용한다."""
from __future__ import annotations

import uuid

from app.config import settings
from tests.conftest import MOONKLABS_ORG_ID, OTHER_ORG_ID, make_token


async def _post_message(client, org_id, content="hello"):
    headers = {"Authorization": f"Bearer {make_token(org_id)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": content}, headers=headers)
    return resp.json()


# --- 인증(신규 엔드포인트도 기존 require_admin 재사용 — 별도 인가 경계를 새로 안 만든다) ------


async def test_list_conversations_rejects_missing_admin_token(client):
    resp = await client.get("/api/v1/admin/conversations")
    assert resp.status_code == 401


async def test_get_messages_rejects_missing_admin_token(client):
    resp = await client.get(f"/api/v1/admin/conversations/{uuid.uuid4()}/messages")
    assert resp.status_code == 401


# --- 방향① pin — 에스컬 여부 무관 전 대화 항시 열람(선생님 13:45 확定) --------------------


async def test_list_conversations_includes_non_escalated_conversation(client, fake_llm, monkeypatch):
    """핵심 pin — 에스컬레이트된 적 없는(=SupportEscalation 행이 0인) 대화도 목록에 뜬다.
    구 설계안(방향②, 에스컬만 노출)이 부활하면 이 테스트가 즉시 깨진다."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "inquiry"  # 에스컬 트리거 없음
    exchange = await _post_message(client, OTHER_ORG_ID, content="평범한 문의(에스컬 아님)")
    conversation_id = exchange["customer_message"]["conversation_id"]

    resp = await client.get(
        "/api/v1/admin/conversations", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["conversations"]]
    assert conversation_id in ids


async def test_list_conversations_spans_all_orgs_when_org_id_omitted(client, fake_llm, monkeypatch):
    """org_id 생략 시 전 org 대상(어드민 콘솔의 "전 org 관제" 요건 — 방향① 재확認)."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "inquiry"
    a = await _post_message(client, OTHER_ORG_ID, content="org A 문의")
    b = await _post_message(client, MOONKLABS_ORG_ID, content="org B(moonklabs) 문의")

    resp = await client.get(
        "/api/v1/admin/conversations", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    ids = {c["id"] for c in resp.json()["conversations"]}
    assert a["customer_message"]["conversation_id"] in ids
    assert b["customer_message"]["conversation_id"] in ids


async def test_list_conversations_org_id_filters(client, fake_llm, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "inquiry"
    await _post_message(client, OTHER_ORG_ID, content="org A 문의")
    await _post_message(client, MOONKLABS_ORG_ID, content="org B(moonklabs) 문의")

    resp = await client.get(
        "/api/v1/admin/conversations",
        params={"org_id": str(OTHER_ORG_ID)},
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    orgs = {c["org_id"] for c in resp.json()["conversations"]}
    assert orgs == {str(OTHER_ORG_ID)}


async def test_list_conversations_exposes_escalation_ids_for_gate_crossref(client, fake_llm, monkeypatch):
    """escalation_ids는 status 문자열이 아니다(SupportEscalation.status 영구 'open' 결함,
    story 183fe7a5) — id만 실어 internal-api가 Gate.neutral_facts.support_escalation_id로
    역참조할 수 있게 한다(설계 doc §3/§4)."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "needs_human"
    exchange = await _post_message(client, OTHER_ORG_ID, content="화가 났어요")
    conversation_id = exchange["customer_message"]["conversation_id"]
    assert exchange["escalated"] is True

    resp = await client.get(
        "/api/v1/admin/conversations", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    row = next(c for c in resp.json()["conversations"] if c["id"] == conversation_id)
    assert len(row["escalation_ids"]) == 1


async def test_get_messages_returns_full_transcript_without_escalation_filter(client, fake_llm, monkeypatch):
    """방향① pin(메시지 축) — 에스컬 안 된 대화의 원문도 그대로 반환한다. admin.py 모듈의
    "원문 절대 반환 안 함" 원칙은 /metrics 전용이라 이 엔드포인트엔 적용 안 된다(PO 판정)."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "inquiry"
    marker = "매우-특이한-어드민-열람-마커-a7c1"
    exchange = await _post_message(client, OTHER_ORG_ID, content=marker)
    conversation_id = exchange["customer_message"]["conversation_id"]

    resp = await client.get(
        f"/api/v1/admin/conversations/{conversation_id}/messages",
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation_id"] == conversation_id
    contents = [m["content"] for m in body["messages"]]
    assert marker in contents  # 원문 그대로 — /metrics와 반대 원칙


async def test_get_messages_unknown_conversation_id_404s(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    resp = await client.get(
        f"/api/v1/admin/conversations/{uuid.uuid4()}/messages",
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    assert resp.status_code == 404


async def test_operator_identity_header_is_audit_only_not_authorization(client, fake_llm, monkeypatch):
    """x_operator_identity 미전송(기본값 "unknown")이어도 require_admin만 통과하면 200 —
    이 헤더는 인가 판단에 안 쓴다는 계약을 고정한다(모듈 docstring 참고)."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    resp = await client.get(
        "/api/v1/admin/conversations", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    assert resp.status_code == 200

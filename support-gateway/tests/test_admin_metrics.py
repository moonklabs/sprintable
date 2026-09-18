"""story #3264 AC3/AC4 — 어드민 계측 조회. 실 SupportMessage/SupportExecutionLog/
SupportEscalation 데이터로 집계(페드루 PO 강조 — "미측정이 아니라 실수로 나올 것", 합성
mock이 아니라 실제로 쌓인 행을 센다)."""
from __future__ import annotations

from app.config import settings
from tests.conftest import MOONKLABS_ORG_ID, OTHER_ORG_ID, make_token


async def _post_message(client, org_id, content="hello"):
    headers = {"Authorization": f"Bearer {make_token(org_id)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    return await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": content}, headers=headers)


# --- 인증(어드민 축은 고객 위임 토큰과 완전 별개) -----------------------------------------


async def test_admin_metrics_fails_closed_when_admin_token_not_configured(client):
    """settings.admin_token 미설정(기본값 "")이면 어떤 토큰을 보내도 401 — "빈 문자열끼리
    일치"로 우회되면 안 된다."""
    resp = await client.get("/api/v1/admin/metrics", headers={"Authorization": "Bearer "})
    assert resp.status_code == 401


async def test_admin_metrics_rejects_wrong_token(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    resp = await client.get("/api/v1/admin/metrics", headers={"Authorization": "Bearer wrong-token"})
    assert resp.status_code == 401


async def test_admin_metrics_rejects_missing_bearer_prefix(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    resp = await client.get("/api/v1/admin/metrics", headers={"Authorization": "the-real-admin-token"})
    assert resp.status_code == 401


async def test_admin_metrics_accepts_correct_token(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    resp = await client.get(
        "/api/v1/admin/metrics", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    assert resp.status_code == 200


async def test_admin_metrics_does_not_leak_customer_message_content(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    secret_marker = "매우-특이한-고객-발화-마커-9f2c"
    await _post_message(client, OTHER_ORG_ID, content=secret_marker)

    resp = await client.get(
        "/api/v1/admin/metrics", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    assert secret_marker not in resp.text


# --- 실 데이터 집계 ------------------------------------------------------------------


async def test_metrics_zero_sample_returns_none_rates_not_zero(client, monkeypatch):
    """표본 0을 "0% 해결"로 오판하면 안 된다 — None(측정 불가)으로 구분."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    resp = await client.get(
        "/api/v1/admin/metrics",
        params={"org_id": str(OTHER_ORG_ID), "since_days": 1},
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    body = resp.json()
    assert body["total_turns"] == 0
    assert body["resolution_rate"] is None
    assert body["escalation_rate"] is None


async def test_metrics_counts_resolved_and_escalated_turns_from_real_rows(client, fake_llm, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")

    fake_llm.classify_text = "inquiry"
    await _post_message(client, OTHER_ORG_ID, content="정상 문의 1")
    await _post_message(client, OTHER_ORG_ID, content="정상 문의 2")

    fake_llm.classify_text = "needs_human"
    await _post_message(client, OTHER_ORG_ID, content="화가 났어요")

    resp = await client.get(
        "/api/v1/admin/metrics",
        params={"org_id": str(OTHER_ORG_ID), "since_days": 1},
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    body = resp.json()
    assert body["total_turns"] == 3
    assert body["escalated_turns"] == 1
    assert body["resolved_turns"] == 2
    assert body["resolution_rate"] == 2 / 3
    assert body["escalation_rate"] == 1 / 3


async def test_metrics_org_filter_excludes_other_orgs(client, fake_llm, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "inquiry"
    await _post_message(client, OTHER_ORG_ID, content="org A 문의")
    await _post_message(client, MOONKLABS_ORG_ID, content="org B(moonklabs) 문의")

    resp = await client.get(
        "/api/v1/admin/metrics",
        params={"org_id": str(OTHER_ORG_ID), "since_days": 1},
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    assert resp.json()["total_turns"] == 1  # moonklabs 쪽은 안 섞임(특례 아닌 필터 정확도)


async def test_metrics_exposes_cost_cap_admin_values(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    monkeypatch.setattr(settings, "cost_cap_org_daily_usd", 7.5)
    monkeypatch.setattr(settings, "cost_cap_org_session_usd", 1.5)

    resp = await client.get(
        "/api/v1/admin/metrics", headers={"Authorization": "Bearer the-real-admin-token"}
    )
    body = resp.json()
    assert body["cost_cap_org_daily_usd"] == 7.5
    assert body["cost_cap_org_session_usd"] == 1.5

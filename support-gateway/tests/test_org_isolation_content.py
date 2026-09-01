"""story #3264 AC2 — org 교차 격리 "실측"(페드루 PO 강조: 상태코드만이 아니라 내용 자체가
새는지). tests/test_session_org_scope.py·test_message_history.py는 "A의 session_id로 B가
접근 시도"(404)를 잡는다 — 이 파일은 다른 각도: "B가 자기 자신의 정당한 세션을 조회했을 때
A의 내용이 섞여 들어오지 않는가"(_get_or_create_conversation의 org_id 필터가 실제로 서는지)."""
from __future__ import annotations

from app.config import settings
from tests.conftest import MOONKLABS_ORG_ID, OTHER_ORG_ID, make_token


async def _post_and_get_history(client, org_id, content):
    headers = {"Authorization": f"Bearer {make_token(org_id)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": content}, headers=headers)
    history = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    return history.json()["messages"]


async def test_org_b_own_legitimate_session_never_contains_org_a_content(client, fake_llm):
    """A(moonklabs 포함)와 B가 각자 자기 세션에만 쓰는데도, B가 자기 세션을 조회했을 때 A의
    발화가 섞여 들어오면 물리분리 DB든 뭐든 org_id 필터 자체가 뚫린 것 — 그걸 직접 잰다."""
    secret_a = "org-A-전용-비밀-발화-7c1e"
    secret_b = "org-B-전용-비밀-발화-4d9a"

    await _post_and_get_history(client, MOONKLABS_ORG_ID, secret_a)
    messages_b = await _post_and_get_history(client, OTHER_ORG_ID, secret_b)

    contents_b = [m["content"] for m in messages_b]
    assert secret_b in contents_b
    assert secret_a not in contents_b


async def test_org_a_own_legitimate_session_never_contains_org_b_content(client, fake_llm):
    """대칭 방향도 확認 — moonklabs가 나중에 써도(순서 뒤집어도) 동형."""
    secret_a = "org-A-전용-비밀-발화-2222"
    secret_b = "org-B-전용-비밀-발화-3333"

    await _post_and_get_history(client, OTHER_ORG_ID, secret_b)
    messages_a = await _post_and_get_history(client, MOONKLABS_ORG_ID, secret_a)

    contents_a = [m["content"] for m in messages_a]
    assert secret_a in contents_a
    assert secret_b not in contents_a


async def test_admin_metrics_org_scoped_query_excludes_other_org_even_when_both_have_activity(
    client, fake_llm, monkeypatch
):
    """AC2와 AC3의 접점 — 두 org 모두 실제 활동이 있는 상태에서도 org 필터가 정확히 서는지."""
    monkeypatch.setattr(settings, "admin_token", "the-real-admin-token")
    fake_llm.classify_text = "inquiry"

    await _post_and_get_history(client, MOONKLABS_ORG_ID, "moonklabs 문의 1")
    await _post_and_get_history(client, OTHER_ORG_ID, "other org 문의 1")
    await _post_and_get_history(client, OTHER_ORG_ID, "other org 문의 2")

    resp = await client.get(
        "/api/v1/admin/metrics",
        params={"org_id": str(MOONKLABS_ORG_ID), "since_days": 1},
        headers={"Authorization": "Bearer the-real-admin-token"},
    )
    assert resp.json()["total_turns"] == 1  # OTHER_ORG_ID의 2건이 안 섞임

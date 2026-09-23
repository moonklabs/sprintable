"""story #4178(PO CHANGES) — 에스컬레이션 원인이 «/auth/me member_id를 믿고 스트림에 붙음»이라
필드만 늘리면 외부 클라이언트가 같은 실수를 반복한다. /auth/me org_member_id와 /events/stream
member_id 쿼리의 설명이 OpenAPI 계약에 실제로 실리는지 고정(DB 불요)."""
from __future__ import annotations


def test_openapi_documents_org_member_id_for_events_stream():
    from app.main import app

    schema = app.openapi()

    org_member = schema["components"]["schemas"]["AuthMeResponse"]["properties"]["org_member_id"]
    assert "/api/v2/events/stream" in org_member.get("description", "")

    stream_params = schema["paths"]["/api/v2/events/stream"]["get"]["parameters"]
    member_param = next(p for p in stream_params if p["name"] == "member_id")
    assert "org_member_id" in member_param.get("description", "")

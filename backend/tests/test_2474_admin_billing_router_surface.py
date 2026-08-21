"""story #2474 — PO 보강ⓐ(2026-08-21): admin_billing 라우터가 노출하는 route(path+method)
집합을 값으로 단언한다. offering_version/grandfather_policy는 append-only라 값 「수정」
엔드포인트(PATCH/PUT)가 있으면 안 된다는 게 AC 자체의 계약 — 미래에 누군가 조용히
PATCH를 추가해도 이 테스트가 즉시 빨강이 된다(DB 불요, 라우터 정의만 검사)."""
from __future__ import annotations

from app.routers import admin_billing


def test_admin_billing_router_surface_is_pinned():
    routes = sorted(
        (route.path, method)
        for route in admin_billing.router.routes
        for method in route.methods
    )
    assert routes == [
        ("/api/v2/admin/grandfather-policies", "GET"),
        ("/api/v2/admin/grandfather-policies", "POST"),
        ("/api/v2/admin/offering-versions", "GET"),
        ("/api/v2/admin/offering-versions", "POST"),
        ("/api/v2/admin/orgs/{org_id}/billing/credit-grant", "POST"),
        ("/api/v2/admin/orgs/{org_id}/billing/retry", "POST"),
    ], (
        "admin_billing 라우터 표면이 바뀌었다 — offering_version/grandfather_policy는 "
        "append-only 계약이라 PATCH/PUT류 mutation 엔드포인트가 추가되면 안 된다. 의도된 "
        "신규 GET/POST 확장이면 이 목록을 함께 갱신할 것."
    )

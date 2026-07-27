"""도메인 축 B §3(org-1st-class-surface-ia-design-b): OpenAPI 태그 조직-우선 위계.

라우터는 기존 세부 tag를 유지한 채 4축(Organization/Work/Trust/Knowledge) 태그를 추가로
보유(additive·다중 tags) — URL·오퍼레이션·세부 tag 값 불변(하위호환 100%가 하드 AC).
"""
from __future__ import annotations

_AXES = ["Organization", "Work", "Trust", "Knowledge"]


def test_openapi_tags_organization_first():
    from app.main import app
    schema = app.openapi()
    tags = schema.get("tags", [])
    assert [t["name"] for t in tags] == _AXES, "4축 top-level tags·Organization이 최상위"


def test_axis_tag_operation_counts_sane():
    """각 축이 실제로 상당수 오퍼레이션에 붙었는지(스크립트가 조용히 0건 처리하지 않았는지) 확인.
    임계값은 doc §0 실측(조직 89·일감 52 라우터 규모)에 느슨히 대응 — 정확한 카운트가 아니라
    "그룹이 텅 비지 않았다"는 하한 sanity check."""
    from app.main import app
    schema = app.openapi()
    counts = {a: 0 for a in _AXES}
    for methods in schema["paths"].values():
        for method, op in methods.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            for t in op.get("tags", []):
                if t in counts:
                    counts[t] += 1
    assert counts["Organization"] >= 100, counts
    assert counts["Work"] >= 100, counts
    assert counts["Trust"] >= 20, counts
    assert counts["Knowledge"] >= 10, counts


def test_anchor_operations_tagged_per_doc_examples():
    """doc §3이 명시한 예시(organizations→Organization·stories→Work·gates→Trust·docs→Knowledge)
    를 실제 오퍼레이션 tags에서 직접 대조 — 내부에서 매핑을 재생성하지 않고 doc의 원 진술과 대조."""
    from app.main import app
    schema = app.openapi()
    paths = schema["paths"]

    def _tags_for(path: str, method: str) -> list[str]:
        return paths[path][method].get("tags", [])

    assert "Organization" in _tags_for("/api/v2/organizations", "get")
    assert "Work" in _tags_for("/api/v2/stories", "get")
    assert "Trust" in _tags_for("/api/v2/gates", "get")
    assert "Knowledge" in _tags_for("/api/v2/docs", "get")


def test_backward_compat_existing_tags_and_paths_unchanged():
    """축 태그는 추가일 뿐 — 기존 세부 tag·URL path 자체는 그대로."""
    from app.main import app
    schema = app.openapi()
    paths = schema["paths"]
    assert "/api/v2/stories" in paths
    assert "/api/v2/organizations" in paths
    assert "/api/v2/gates" in paths
    assert "/api/v2/docs" in paths
    assert "stories" in paths["/api/v2/stories"]["get"].get("tags", [])
    assert "organizations" in paths["/api/v2/organizations"]["get"].get("tags", [])
    assert "gates" in paths["/api/v2/gates"]["get"].get("tags", [])
    assert "docs" in paths["/api/v2/docs"]["get"].get("tags", [])


def test_infra_routers_not_forced_into_an_axis():
    """health/mcp/cron은 도메인 축이 아닌 인프라 — 4축 중 어느 것도 강제로 안 붙임(디디 판단·§3 선택)."""
    from app.main import app
    schema = app.openapi()
    paths = schema["paths"]
    assert "/api/v2/health" in paths, "경로 자체가 없으면 아래 검증이 공허해짐 — 존재 먼저 확인"
    health_ops = list(paths["/api/v2/health"].values())
    assert health_ops
    for op in health_ops:
        assert not (set(op.get("tags", [])) & set(_AXES))

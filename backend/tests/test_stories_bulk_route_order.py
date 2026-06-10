"""stories PATCH 라우트 순서 가드 — /bulk 가 /{id} 보다 먼저 선언돼야(shadow 방지).

근본(선생님 dnd 실테스트): /{id}(PATCH)가 /bulk 보다 먼저 선언되면 PATCH /api/v2/stories/bulk 가
/{id} 에 매칭돼 id="bulk" UUID 파싱 422 → /bulk 핸들러 영영 shadow → dnd 보드 상태저장 깨짐.
FastAPI 는 선언 순서로 매칭(first match wins)하므로 specific(/bulk) 을 parameterized(/{id}) 앞에 둔다.
"""
from __future__ import annotations


def test_bulk_patch_declared_before_id_patch():
    from app.main import app

    patch_paths: list[str] = []
    for r in app.routes:
        path = getattr(r, "path", "")
        methods = getattr(r, "methods", set()) or set()
        if path.startswith("/api/v2/stories") and "PATCH" in methods:
            patch_paths.append(path)

    assert "/api/v2/stories/bulk" in patch_paths, patch_paths
    assert "/api/v2/stories/{id}" in patch_paths, patch_paths
    bulk_i = patch_paths.index("/api/v2/stories/bulk")
    id_i = patch_paths.index("/api/v2/stories/{id}")
    assert bulk_i < id_i, f"/bulk 은 /{{id}} 보다 먼저 선언돼야(shadow 방지): {patch_paths}"

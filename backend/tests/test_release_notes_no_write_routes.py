"""3f1f2408: release-notes 공개 API write route 부재 — 멀티테넌시 침해 회귀 가드(no-DB).

릴노트=전역 changelog. write(POST/PATCH/PUT/DELETE)가 공개 라우터에 있으면 호출자 자기-org owner 가
전역 노트 편집/삭제 가능(EXPLOITABLE 실증). 공개 API 에서 write route 자체를 제거 → 고객 write 경로 0.
write 가 재추가되면 이 테스트가 잡는다. GET(published) 만 유지. (관리 write 는 별도 비공개 운영자 어드민.)
"""
from app.routers.release_notes import router


def test_public_router_exposes_only_get():
    methods: set[str] = set()
    for r in router.routes:
        methods |= (getattr(r, "methods", None) or set())
    assert "GET" in methods, "published GET 은 유지돼야"
    for m in ("POST", "PATCH", "PUT", "DELETE"):
        assert m not in methods, f"공개 release-notes 에 {m} write route 잔존 — 멀티테넌시 침해 재발"

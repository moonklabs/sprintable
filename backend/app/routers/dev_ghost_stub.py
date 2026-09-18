"""story #3816(Phase3·3-6 PR1, 페드루 PO 지시 2026-09-12) — dev 전용 Ghost Admin API
모의 서버. wordpress/webhook 스텁(story e4fc29fa 조각③c/④)과 같은 사상 — dev org에
실 Ghost 사이트가 없어 `ghost_client.py::verify_admin_api_key`가 진짜로 치는 HTTP
왕복(성공·키 오류·주소 오류 3갈래, story #3816 CHANGES 1)을 검증할 대상이 없던
문제를 채운다. `httpx.MockTransport`가 아니라 **실 프로세스 간 HTTP**(연결 저장
로직이 진짜 소켓을 연다) — PO 캡처(폼·키 오류·주소 오류 3장)가 이 스텁을 상대로만
실 도메인 노출 0으로 성립한다.

`{scenario}` 경로 세그먼트로 3갈래를 결정적으로 고른다 — site_url이 이 스텁의
base URL이 되므로, 폼에 어느 site_url을 넣느냐로 시나리오를 고른다:
`http://localhost:PORT/api/dev/ghost-stub/ok`(200)·`.../key-invalid`(401)·
`.../site-not-found`(404).

wordpress 스텁의 fail-closed 이중방어를 그대로 미러: ①이 라우터 자체가
`GHOST_TEST_STUB_ENABLED=true`일 때만 등재(app/main.py) ②기동 시점
`assert_ghost_stub_not_registered_in_prod()`가 prod에 잘못 켜졌으면 즉시
RuntimeError로 죽는다."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException

from app.services.ghost_client import ghost_stub_enabled

router = APIRouter(prefix="/api/dev/ghost-stub/{scenario}/ghost/api/admin", tags=["dev-ghost-stub"])


@router.get("/site/")
async def get_site(scenario: str, authorization: str | None = Header(default=None)) -> dict:
    """실 Ghost Admin API의 `GET /ghost/api/admin/site/` 최소 계약(Authorization:
    Ghost <jwt> 요구, 성공 시 `{"site": {...}}`)만 흉내낸다 — JWT 서명 자체를
    검증하진 않는다(dev 스텁이라 "헤더가 실제로 실려 왔는지"만 확認, wordpress
    스텁의 Basic auth 존재-확인만 하는 관례와 동형)."""
    if not authorization or not authorization.startswith("Ghost "):
        raise HTTPException(status_code=401, detail={"errors": [{"message": "Authorization header missing"}]})
    if scenario == "key-invalid":
        raise HTTPException(status_code=401, detail={"errors": [{"message": "Invalid API key."}]})
    if scenario == "site-not-found":
        raise HTTPException(status_code=404, detail={"errors": [{"message": "Not Found"}]})
    return {"site": {"title": "Dev Ghost Stub", "url": "http://localhost/", "version": "5.0.0"}}


def assert_ghost_stub_not_registered_in_prod() -> None:
    """story #3816(PR1) — `assert_wordpress_stub_not_registered_in_prod`와 동형
    2층 방어. env 플래그 게이트(app/main.py의 조건부 include_router)가 이미 prod
    cloudbuild.yaml에 이 키를 안 실어 정상 배포에서는 항상 no-op — 수동 오조작까지
    막는 두 번째 층."""
    from app.core.config import settings

    if settings.is_prod_deploy and ghost_stub_enabled():
        # story #3779 가드 회피 — 이 문자열은 사람 화면에 안 닿는 기동-중단 전용
        # 운영자 메시지(로그만)라 영문으로 등재한다(최근 채널 display_name 영문
        # 등재 관례와 동형 판단, ghost/stibee 어댑터 항목 주석 참고).
        raise RuntimeError(
            "fail-closed: GHOST_TEST_STUB_ENABLED is set to true in a prod deployment (story #3816 PR1)."
        )

"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③c) — dev 전용
WordPress REST 모의 서버. `sandbox_publish.py`(story 5b27b32f)와 같은 사상 — dev org에
실 WordPress 사이트가 없어(§7 명시) `wordpress_publish.py`가 진짜로 치는 HTTP 왕복을
검증할 대상이 없던 문제를, 우리 백엔드 위에 `/wp/v2/posts`의 최소 계약(생성·갱신·
Basic auth 요구)만 흉내내는 라우터로 채운다. `httpx.MockTransport`가 아니라 **실
프로세스 간 HTTP**(워커가 진짜 소켓을 연다) — AC7 "실왕복"은 이 스텁을 상대로만
성립한다.

sandbox_publish.py의 fail-closed 이중방어를 그대로 미러: ①이 라우터 자체가
`WORDPRESS_TEST_STUB_ENABLED=true`일 때만 등재(app/main.py) ②기동 시점
`assert_wordpress_stub_not_registered_in_prod()`가 prod에 잘못 켜졌으면 즉시
RuntimeError로 죽는다."""
from __future__ import annotations

import base64
import itertools

from fastapi import APIRouter, Header, HTTPException

from app.services.wordpress_publish import wordpress_stub_enabled

router = APIRouter(prefix="/api/dev/wordpress-stub/wp-json/wp/v2", tags=["dev-wordpress-stub"])

# dev 전용 프로세스 내 인메모리 원장 — 재발행(update)이 같은 id를 되짚을 수 있게(WordPress
# 실 서버의 "글 하나" 개념을 최소로 흉내). 프로세스 재시작마다 초기화돼도 무방(스모크 스텁).
_POSTS: dict[int, dict] = {}
_ID_SEQ = itertools.count(1)


def _require_basic_auth(authorization: str | None) -> None:
    """실 WordPress Application Password 계약의 최소 재현 — Authorization: Basic 헤더가
    없으면 401(진짜 WP 서버와 동형). base64 디코딩까지만 확인(자격 값 자체는 dev 스텁이라
    검증하지 않는다 — "헤더가 실제로 실려 왔는지"가 AC7이 증명하려는 것의 전부)."""
    if not authorization or not authorization.startswith("Basic "):
        raise HTTPException(status_code=401, detail={"code": "rest_forbidden", "message": "Sorry, you are not allowed to do that."})
    try:
        base64.b64decode(authorization.removeprefix("Basic "), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail={"code": "rest_forbidden", "message": "malformed credentials"}) from exc


@router.post("/posts")
async def create_post(body: dict, authorization: str | None = Header(default=None)) -> dict:
    _require_basic_auth(authorization)
    post_id = next(_ID_SEQ)
    slug = body.get("slug") or f"post-{post_id}"
    row = {
        "id": post_id, "title": body.get("title", ""), "content": body.get("content", ""),
        "excerpt": body.get("excerpt", ""), "slug": slug, "status": body.get("status", "publish"),
        "link": f"https://dev-wordpress-stub.internal/{slug}/",
    }
    _POSTS[post_id] = row
    return {"id": row["id"], "link": row["link"], "status": row["status"]}


@router.post("/posts/{post_id}")
async def update_post(post_id: int, body: dict, authorization: str | None = Header(default=None)) -> dict:
    _require_basic_auth(authorization)
    row = _POSTS.get(post_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "rest_post_invalid_id", "message": "Invalid post ID."})
    row.update({k: v for k, v in body.items() if k in ("title", "content", "excerpt", "slug", "status")})
    return {"id": row["id"], "link": row["link"], "status": row["status"]}


def assert_wordpress_stub_not_registered_in_prod() -> None:
    """story e4fc29fa(조각③c) — `assert_sandbox_channel_not_registered_in_prod`와 동형
    2층 방어. env 플래그 게이트(app/main.py의 조건부 include_router)가 이미 prod
    cloudbuild.yaml에 이 키를 안 실어 정상 배포에서는 항상 no-op — 수동 오조작까지
    막는 두 번째 층."""
    from app.core.config import settings

    if settings.is_prod_deploy and wordpress_stub_enabled():
        raise RuntimeError(
            "fail-closed: prod 배포에 WORDPRESS_TEST_STUB_ENABLED가 켜져 있습니다"
            "(story e4fc29fa 조각③c AC4)."
        )

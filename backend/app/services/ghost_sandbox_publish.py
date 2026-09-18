"""story #3816(Phase3·3-6 PR2 CHANGES 1, 페드루 PO 지목 2026-09-12) — Ghost 발행
sandbox 미러. `blog_destinations.py::BlogDestinationModule` 4호 구현체 —
ghost_publish.py와 같은 시그니처(publish/unpublish)지만 **네트워크 0·JWT 서명
0**(credential_kind="none" 샌드박스 연결이라 admin_api_key는 더미값
"sandbox-dummy-access-token" — 실제로 안 쓴다). 실 Ghost 사이트 없이도(dev-app
라이브 회차) 발행 축(성공·재서명-후-성공 모양·인증 실패 승격)을 결정적으로
재현한다 — sandbox_publish.py/facebook_sandbox_publish.py 등 기존 마커 관례
그대로(title·body_md 어디든 부분일치로 스캔).

마커 4갈래:
- `[sandbox:provider-error]` → `GhostPublishError(status_code=503)`(일시적,
  CHANNEL_PUBLISH_PROVIDER_ERROR — 백오프 재시도 대상).
- `[sandbox:ghost-jwt-expired]` → ghost_publish.py의 재서명 1회 재시도가 실제
  Ghost 사이트에서 성공하는 모양을 결정적으로 재현(첫 시도 401→재서명→둘째
  시도 성공, 이 모듈 안에서 흉내만 낸다 — 실 JWT 재서명은 없다). 최종 결과는
  published지만 external_id 접두사(`sandbox-ghost-jwtretry-`)로 이 경로를 탔음을
  구분한다(지어낸 구분이지만 테스트·라이브 캡처가 "그 경로가 실행됐다"를 확認할
  유일한 방법 — 최종 상태만 보면 마커 없음과 구별이 안 된다).
- `[sandbox:ghost-auth-failed]` → `GhostPublishError(status_code=401)`(재서명
  재시도까지 실패한 것과 같은 최종 상태 — site_posts.py::_blog_publish_error_code
  가 `GHOST_AUTH_FAILED`로 승격, 연결 「다시 연결 필요」).
- 마커 없음 → 성공. external_id=`sandbox-ghost-<uuid4>`·permalink=
  `https://ghost-sandbox.invalid/p/<external_id>/`(실물 도메인이 아닌 `.invalid`
  TLD — RFC 2606, 실 도메인 노출 0 규율과 동형).

unpublish — 항상 성공(멱등, 상태 보존 없음 — sandbox_publish.py의 결정적 성공
관례와 동형)."""
from __future__ import annotations

import uuid

from app.services.ghost_publish import GhostPublishError

_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_JWT_EXPIRED = "[sandbox:ghost-jwt-expired]"
_MARKER_AUTH_FAILED = "[sandbox:ghost-auth-failed]"

_SANDBOX_URL_BASE = "https://ghost-sandbox.invalid/p"


def _has_marker(marker: str, *texts: str) -> bool:
    return any(marker in text for text in texts if text)


async def publish(
    client,
    *,
    site_url: str,
    admin_api_key: str,
    title: str,
    body_md: str,
    summary: str,
    tags: list,
    slug: str,
    external_id: str | None = None,
    scheduled_at=None,
) -> tuple[str, str | None]:
    """ghost_publish.publish()와 같은 시그니처(BlogDestinationModule Protocol,
    site_posts.py::_call_blog_module_publish가 채널 무관하게 kwargs를 그대로
    넘긴다) — `client`는 이 모듈에서 실제로 쓰지 않는다(네트워크 0, 시그니처
    호환 목적으로만 받는다)."""
    if _has_marker(_MARKER_PROVIDER_ERROR, title, body_md):
        raise GhostPublishError(status_code=503, body="sandbox: [sandbox:provider-error] marker simulation")
    if _has_marker(_MARKER_AUTH_FAILED, title, body_md):
        raise GhostPublishError(status_code=401, body="sandbox: [sandbox:ghost-auth-failed] marker simulation")

    if _has_marker(_MARKER_JWT_EXPIRED, title, body_md):
        new_id = external_id or f"sandbox-ghost-jwtretry-{uuid.uuid4()}"
        return new_id, f"{_SANDBOX_URL_BASE}/{new_id}/"

    new_id = external_id or f"sandbox-ghost-{uuid.uuid4()}"
    return new_id, f"{_SANDBOX_URL_BASE}/{new_id}/"


async def unpublish(client, *, site_url: str, admin_api_key: str, external_id: str) -> None:
    """항상 성공 — 실 상태를 보존하지 않는 결정적 sandbox 관례(재발행으로도
    되돌릴 "진짜" 상태가 없다, wordpress/webhook과 달리 이 모듈은 처음부터
    비영속적 응답만 낸다)."""
    return None

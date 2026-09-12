"""story #3816(Phase3·3-6, 페드루 PO 確定 2026-09-12) — Ghost Admin API 클라이언트.
PR1은 저장 시점 site 검증(`GET /ghost/api/admin/site/`) 하나만(연결 생성 fail-closed,
stibee_client.py::verify_api_key 동형 관례) — 글 생성·이미지 업로드·발송 예약은 PR2 이후
(reuse 대상: wordpress 어댑터 형·hosted_site 발행 경로·external_publish 게이트).

그라운딩(공개 문서 지식, 2026-09-12 — 실 사이트 왕복 前 상태, stibee의 여러 self-correction
선례처럼 실 계정 확認 시 조정 여지 있음):
- Admin API 키는 `{id}:{hex secret}` 형(Ghost 설정 화면 → Integrations → Custom
  Integration에서 발급).
- JWT는 secret(hex→bytes)로 HS256 서명, header `kid=id`, payload `exp=iat+300`
  (Ghost가 5분 상한을 강제) · `aud="/admin/"` — 캐싱하지 않고 호출마다 재서명한다
  (서명 비용이 무시할 만큼 저렴하고, 캐싱하면 만료 임박 경합이 생긴다).
- 요금제 제한 존재 자체가 **미확認**(Ghost는 self-hosted 오픈소스가 기본이라 API에
  플랜 개념이 없을 수 있다 — PO 決定: 이 축은 상태 낱말 신설 0·폼 도움 문구 1줄로만
  다룬다, `verify_admin_api_key`의 판정 로직 자체엔 영향 없음)."""
from __future__ import annotations

import time

import httpx
from jose import jwt

_ADMIN_AUD = "/admin/"
_JWT_TTL_SECONDS = 300  # Ghost 강제 상한(exp-iat ≤ 5분)


class GhostAdminKeyMalformedError(Exception):
    """Admin API 키가 `{id}:{secret}` 형이 아니거나 secret이 유효한 hex가 아님 — 네트워크
    호출을 시도하지도 않는다(fail-closed, 저비용 형식 검증을 먼저 친다)."""


def sign_admin_jwt(admin_api_key: str) -> str:
    """`{id}:{hex secret}` → HS256 JWT(kid=id·exp=iat+300·aud=/admin/). PR2의 글 생성·
    이미지 업로드 호출도 이 함수를 그대로 재사용한다(서명 로직 한 곳)."""
    try:
        key_id, key_secret_hex = admin_api_key.split(":", 1)
        key_secret = bytes.fromhex(key_secret_hex)
    except ValueError as exc:
        raise GhostAdminKeyMalformedError(str(exc)) from exc
    now = int(time.time())
    return jwt.encode(
        {"iat": now, "exp": now + _JWT_TTL_SECONDS, "aud": _ADMIN_AUD},
        key_secret,
        algorithm="HS256",
        headers={"kid": key_id, "typ": "JWT"},
    )


class GhostSiteVerifyFailed(Exception):
    """site 검증(`GET /ghost/api/admin/site/`)이 200이 아니거나 네트워크 자체가
    실패했을 때. `.status_code`는 provider가 준 HTTP status(네트워크 실패·타임아웃
    시 None). stibee_client.StibeeAuthCheckFailed와 같은 판정축(「provider가 응답해서
    거절」=4xx 전체를 「키 재발급」 처방으로, 응답 자체가 없거나 5xx는 「잠시 뒤
    재시도」로) — 실 사이트 왕복 前까지는 이 보수적 기본값을 그대로 따른다(⚠️미확認).

    `key_malformed=True`는 admin_api_key가 애초에 `{id}:{hex}` 형이 아니어서 네트워크를
    타지도 못한 경우 — status_code가 None(응답 없음)과 같은 값이라도 이건 명백히
    「키 형식이 틀렸다」(재발급/재확認 처방)이지 「provider가 일시 불가」가 아니라서
    `.is_key_rejected`를 강제로 True로 얹는다(status_code 하나로 두 다른 사유를
    뭉치지 않는다)."""

    def __init__(self, message: str, *, status_code: int | None, key_malformed: bool = False):
        self.status_code = status_code
        self.key_malformed = key_malformed
        super().__init__(message)

    @property
    def is_key_rejected(self) -> bool:
        return self.key_malformed or (self.status_code is not None and 400 <= self.status_code < 500)


async def verify_admin_api_key(client: httpx.AsyncClient, *, site_url: str, admin_api_key: str) -> None:
    """`GET {site_url}/ghost/api/admin/site/` — 200이면 정상 반환(값 없음). 그 외
    status나 네트워크 실패, 또는 admin_api_key 형식 자체가 잘못됐으면
    `GhostSiteVerifyFailed`(fail-closed, 호출부가 연결 저장을 막는다)."""
    try:
        token = sign_admin_jwt(admin_api_key)
    except GhostAdminKeyMalformedError as exc:
        raise GhostSiteVerifyFailed(str(exc), status_code=None, key_malformed=True) from exc
    url = f"{site_url.rstrip('/')}/ghost/api/admin/site/"
    try:
        resp = await client.get(url, headers={"Authorization": f"Ghost {token}"})
    except httpx.HTTPError as exc:
        raise GhostSiteVerifyFailed(str(exc), status_code=None) from exc
    if resp.status_code != 200:
        raise GhostSiteVerifyFailed(resp.text[:500], status_code=resp.status_code)

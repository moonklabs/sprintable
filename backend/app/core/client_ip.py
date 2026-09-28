"""story #4398 — 요청 상한(slowapi)이 셀 사용자 IP를 정하는 한 곳.

신뢰 경계:
- 프런트(BFF)가 사용자 IP를 한 번 정해(Cloudflare 대역에서 온 접속일 때만 `CF-Connecting-IP`) `X-Sprintable-Client-IP`로 넘기고,
  `X-Sprintable-Edge-Key`에 공유 비밀을 싣는다. 비밀이 맞을 때만 그 값을 믿는다(상수 시간 비교).
- 그 밖(모바일 직통 · 백엔드 run.app 직통 · 비밀 미설정)은 Cloud Run 앞단(GFE)이 X-Forwarded-For **오른쪽 끝**에 붙인 접속 주소 —
  클라이언트가 보낸 XFF 앞 칸은 꾸밀 수 있지만 이 칸은 못 꾸민다.
- Cloud Run 밖(로컬 · 테스트)에선 소켓 주소(`request.client.host`).

⚠️ «XFF 오른쪽 끝 = 접속 주소»는 dev 로그 실측(4398 AC0 ④)이 전제 — 확인 전엔 병합하지 않는다.
"""
from __future__ import annotations

import hmac
import ipaddress
import os

from starlette.requests import Request

from app.core.config import settings

CLIENT_IP_HEADER = "x-sprintable-client-ip"
EDGE_KEY_HEADER = "x-sprintable-edge-key"


def _valid_ip(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def _on_cloud_run() -> bool:
    return bool(os.environ.get("K_SERVICE"))


def client_ip(request: Request) -> str:
    """요청 상한이 셀 사용자 IP. 위 신뢰 경계 순서대로 — 하나도 못 정하면 소켓 주소(없으면 빈 문자열이 아니라 "unknown")."""
    secret = settings.edge_client_ip_secret
    if secret:
        given = request.headers.get(EDGE_KEY_HEADER, "")
        forwarded_ip = _valid_ip(request.headers.get(CLIENT_IP_HEADER))
        if given and forwarded_ip and hmac.compare_digest(given.encode(), secret.encode()):
            return forwarded_ip
    if _on_cloud_run():
        xff = request.headers.get("x-forwarded-for", "")
        connecting = _valid_ip(xff.rsplit(",", 1)[-1]) if xff else None
        if connecting:
            return connecting
    return request.client.host if request.client else "unknown"

"""story #4398 ④ — **임시 관측**(dev만 · ④ 판정 뒤 걷음): Cloud Run 앞단(GFE)이 컨테이너에 넘기는 X-Forwarded-For의 칸 수와
맨 오른쪽 값을 요청마다 한 줄 남긴다. 같은 trace의 요청 로그 `httpRequest.remoteIp`와 맞대어 «XFF 오른쪽 끝 = 접속 주소»를 가른다
(요청 로그만으로는 헤더가 안 보인다).

- 스위치 `XFF_PROBE_ENABLED`(Settings `xff_probe_enabled`, 기본 꺼짐 · dev만 켬 · prod는 꺼짐). 꺼져 있으면 미들웨어를 아예 안 단다.
- 남기는 값은 **주소와 칸 수뿐**: 주소 모양이 아니면 `non-ip`로 바꿔 헤더 원문이 로그에 섞이지 않게 한다. 쿠키 · 토큰 · 다른 헤더 0.
- stdout 한 줄 JSON — Cloud Run이 `jsonPayload`로 받는다(`event="xff_probe"`로 조회).
"""
from __future__ import annotations

import ipaddress
import json
import re
import sys

from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.config import settings

EVENT = "xff_probe"
_TRACE_RE = re.compile(r"^[0-9a-fA-F]{8,64}$")


def probe_enabled() -> bool:
    return bool(settings.xff_probe_enabled)


def _address_or_marker(value: str | None) -> str:
    v = (value or "").strip()
    if not v:
        return ""
    try:
        return str(ipaddress.ip_address(v))
    except ValueError:
        return "non-ip"


def probe_record(headers: dict[str, str], peer: str | None, service: str) -> dict[str, object]:
    """헤더(소문자 키) · 소켓 주소로 로그 한 줄의 내용을 만든다 — 주소 · 칸 수 · trace id만."""
    xff = headers.get("x-forwarded-for", "")
    parts = xff.split(",") if xff else []
    trace = headers.get("x-cloud-trace-context", "").split("/", 1)[0]
    return {
        "event": EVENT,
        "service": service,
        "xff_hops": len(parts),
        "xff_rightmost": _address_or_marker(parts[-1]) if parts else "",
        "peer": _address_or_marker(peer),
        "trace_id": trace if _TRACE_RE.match(trace) else "",
    }


class XffProbeMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            client = scope.get("client")
            record = probe_record(headers, client[0] if client else None, "backend")
            sys.stdout.write(json.dumps(record) + "\n")
            sys.stdout.flush()
        await self.app(scope, receive, send)


def install_xff_probe(app) -> bool:  # noqa: ANN001 — FastAPI/Starlette 앱
    """스위치가 켜져 있을 때만 단다(꺼져 있으면 요청마다 드는 비용 0). 달았으면 True."""
    if not probe_enabled():
        return False
    app.add_middleware(XffProbeMiddleware)
    return True

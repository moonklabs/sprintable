"""story #3260(위젯 셸) — 이 서비스는 브라우저가 직접 호출한다(Next.js BFF 프록시 경유
아님) — 실제 CORS preflight가 매 요청 경로에 돈다. 이전 코드(`if settings.cors_allow_origins:`
분기)는 미설정 시 CORSMiddleware 자체를 안 붙였는데, 지금은 항상 붙이되 빈 origins면 실질
전부 거부(backend/app/main.py와 동형 컨벤션) — 이 fail-closed 기본값을 pin한다."""
from __future__ import annotations


async def test_options_preflight_gets_no_allow_origin_when_unconfigured(client):
    """SUPPORT_GATEWAY_CORS_ORIGINS 미설정(테스트 기본값 "")이면 어떤 origin도 preflight를
    통과하지 못한다 — 미설정=거부(허용 아님)가 fail-closed 원칙과 일치한다."""
    res = await client.options(
        "/api/v1/sessions",
        headers={"Origin": "https://dev-app.sprintable.ai", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers.keys()}

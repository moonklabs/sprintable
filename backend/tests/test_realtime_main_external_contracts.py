"""story #2089(2026-07-25, 오르테가군 지적) — 3-a 라이브 배포가 GCLB 헬스체크 실패(502)로
롤백된 뒤 세운 회귀가드.

2단계(«실제 로드된 모듈 목록» 측정)는 **의존**은 잡았지만 **이 서비스에 외부가 요구하는
계약**은 못 잡았다 — 로컬 TestClient 기동은 헬스체크를 안 태우므로 그 갭이 로컬에서는
안 보였다. `/api/v2/ping`이 빠진 채로 배포돼 GCLB가 영구 UNHEALTHY로 보고 502를 냈다.

이 파일은 realtime_main.py가 실제로 서비스해야 하는 외부 계약을 하나씩 명시하고 pin한다
(지금 아는 것은 GCLB 헬스체크 하나 — provision_realtime_gclb.sh 대조 확認. 더 있으면
이 파일에 추가할 것).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_gclb_health_check_path_responds_200():
    """provision_realtime_gclb.sh:112 --request-path=/api/v2/ping 과 대조 — 이 경로가
    없으면 GCLB가 이 서비스를 영구 UNHEALTHY로 판정해 502를 낸다(2026-07-25 실제 배포
    실패로 확認된 실패 모드)."""
    import app.realtime_main as rm

    with TestClient(rm.app) as client:
        response = client.get("/api/v2/ping")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_gclb_health_check_path_matches_provision_script():
    """provision_realtime_gclb.sh의 --request-path 값 자체가 바뀌면 이 pin도 같이 갱신돼야
    한다 — 두 파일이 서로 다른 경로를 말하게 되는 드리프트를 잡는다."""
    import pathlib

    script = (
        pathlib.Path(__file__).resolve().parents[1]
        / "scripts" / "provision_realtime_gclb.sh"
    )
    assert script.exists()
    source = script.read_text()
    assert "--request-path=/api/v2/ping" in source, (
        "provision_realtime_gclb.sh의 헬스체크 경로가 바뀌었다 — "
        "realtime_main.py가 그 경로를 여전히 서빙하는지 재확認 필요"
    )

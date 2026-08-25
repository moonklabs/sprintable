"""story #3070/#3071 후속(2026-08-25) — realtime-gateway MIG autoHealingPolicies SSOT 회귀가드.

배경: dev MIG(sprintable-realtime-gateway-dev)에 autoHealingPolicies가 없어 롤링업데이트의
"새 인스턴스 준비됐다" 판정이 GCLB 헬스체크(앱 실제 응답 여부)와 완전히 분리돼 있었다 —
실측(2026-08-25, 오늘 10사이클): insert→delete 간격이 앱 부팅시간과 거의 여유 0으로 맞물려
한 사이클만도 실 502 37건. 페드루 PO GO(2026-08-25) 후 dev에 즉시완화로 `gcloud beta
compute instance-groups managed update --health-check=... --initial-delay=270` 를 손으로
적용했으나, 그 값은 다음 배포/재생성이 덮는다 — 이 스크립트(deploy_realtime_gce.sh)가
정본이어야 한다. 이 테스트는 그 SSOT 반영을 실 파일 내용으로 고정한다(요약이 아니라 생성된
코드 그 자체 — named-ports/backend-service 부착과 동일한 "매 배포마다 방어적으로 보장"
원칙을 따르는지도 확認)."""
from __future__ import annotations

import os
import re
import subprocess

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "deploy_realtime_gce.sh")


def _resolve(env: str) -> dict[str, str]:
    proc = subprocess.run(
        ["bash", _SCRIPT, env],
        capture_output=True, text=True,
        env={**os.environ, "DRY_RUN": "1", "COMMIT_SHA": "deadbeef"}, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


def _script_text() -> str:
    with open(_SCRIPT, encoding="utf-8") as f:
        return f.read()


def test_dev_and_prod_resolve_distinct_health_check_names():
    dev_cfg = _resolve("dev")
    prod_cfg = _resolve("prod")
    assert dev_cfg["GCLB_HEALTH_CHECK"] == "realtime-gateway-dev-health-check"
    assert prod_cfg["GCLB_HEALTH_CHECK"] == "realtime-gateway-prod-health-check"


def test_autohealing_update_command_present_and_uses_resolved_health_check():
    text = _script_text()
    assert re.search(
        r"gcloud compute instance-groups managed update \"\$\{MIG_NAME\}\"", text
    ), "autoHealingPolicies를 설정하는 update 커맨드가 있어야 한다"
    assert '--health-check="${GCLB_HEALTH_CHECK}"' in text
    assert "--initial-delay=" in text


def test_initial_delay_has_safety_margin_over_known_boot_time():
    """알려진 최악 부팅시간(~3분=180초, #3070 그라운딩) 대비 여유가 있어야 한다 —
    너무 타이트하면 정상 부팅 중인 인스턴스를 autohealing이 죽이는 재발 위험."""
    text = _script_text()
    m = re.search(r"AUTOHEAL_INITIAL_DELAY_SEC=(\d+)", text)
    assert m, "AUTOHEAL_INITIAL_DELAY_SEC 변수가 정의돼 있어야 한다"
    assert int(m.group(1)) >= 240, "알려진 부팅시간(~180초)보다 유의미하게 커야 한다"


def test_autohealing_step_runs_defensively_every_deploy_like_named_ports():
    """named-ports/backend-service 부착과 동일 원칙 — MIG 재생성 조건문 밖(항상 실행 경로)에
    있어야 한다. set-named-ports 호출 뒤·backend-services add-backend 앞에 위치하는지로
    "항상 실행 블록" 안에 있음을 검증(두 앵커 다 무조건 실행 구간에 있다는 게 기존 계약)."""
    text = _script_text()
    named_ports_idx = text.index('gcloud compute instance-groups managed set-named-ports "${MIG_NAME}"')
    autoheal_idx = text.index('gcloud compute instance-groups managed update "${MIG_NAME}"')
    backend_attach_idx = text.index("gcloud compute backend-services add-backend")
    assert named_ports_idx < autoheal_idx < backend_attach_idx

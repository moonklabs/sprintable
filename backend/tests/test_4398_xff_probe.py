"""story #4398 ④ — 임시 관측(XFF 칸 모양) — 스위치 · 한 줄 · 헤더 원문이 안 섞임."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.core.xff_probe import EVENT, XffProbeMiddleware, install_xff_probe, probe_record

_GARBAGE = "<script>evil-token-4398</script>"


def test_record_holds_only_addresses_hop_count_and_trace():
    record = probe_record(
        {
            "x-forwarded-for": f"198.51.100.9, {_GARBAGE}",
            "x-cloud-trace-context": "0123456789abcdef0123456789abcdef/123;o=1",
            "cookie": "sp_at=secret-cookie",
            "authorization": "Bearer secret-token",
        },
        "169.254.1.1",
        "backend",
    )
    assert record == {
        "event": EVENT, "service": "backend", "xff_hops": 2, "xff_rightmost": "non-ip",
        "peer": "169.254.1.1", "trace_id": "0123456789abcdef0123456789abcdef",
    }
    dumped = json.dumps(record)
    for leaked in ("evil-token-4398", "secret-cookie", "secret-token", "198.51.100.9"):
        assert leaked not in dumped  # 헤더 원문 · 쿠키 · 토큰 · 오른쪽 끝이 아닌 칸은 안 남긴다


def test_record_normalizes_the_rightmost_address_and_handles_no_header():
    assert probe_record({"x-forwarded-for": "203.0.113.7, 2001:DB8::1"}, None, "backend")["xff_rightmost"] == "2001:db8::1"
    empty = probe_record({}, None, "backend")
    assert empty["xff_hops"] == 0 and empty["xff_rightmost"] == "" and empty["peer"] == "" and empty["trace_id"] == ""
    assert probe_record({"x-cloud-trace-context": "not-hex!/1"}, None, "backend")["trace_id"] == ""


def test_switch_off_installs_nothing(monkeypatch):
    monkeypatch.setattr(settings, "xff_probe_enabled", False)
    app = FastAPI()
    assert install_xff_probe(app) is False
    assert not any(m.cls is XffProbeMiddleware for m in app.user_middleware)


@pytest.mark.anyio
async def test_switch_on_logs_exactly_one_line_per_request(monkeypatch, capsys):
    monkeypatch.setattr(settings, "xff_probe_enabled", True)
    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    assert install_xff_probe(app) is True
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        await c.get("/ping", headers={"X-Forwarded-For": "203.0.113.7, 198.51.100.9", "Cookie": "sp_at=secret-cookie"})
    lines = [ln for ln in capsys.readouterr().out.splitlines() if f'"event": "{EVENT}"' in ln]
    assert len(lines) == 1
    logged = json.loads(lines[0])
    assert logged["xff_hops"] == 2 and logged["xff_rightmost"] == "198.51.100.9"
    assert "secret-cookie" not in lines[0]


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 배포: 프런트도 dev 밖은 명시 제거(까디르 렌즈 ② · PO 21:49Z) ──

def _run_frontend_assembly(deploy_env: str) -> dict[str, str]:
    """cloudbuild deploy-frontend 스텝을 실제 gcloud 호출 직전까지만 실행해 ENV_VARS · FE_REMOVE_ENV를 얻는다."""
    import os
    import re
    import subprocess

    from tests.test_deploy_backend_redis_secret_conflict import _apply_cloudbuild_escaping, _extract_step_script

    script = _apply_cloudbuild_escaping(_extract_step_script("deploy-frontend"))
    idx = script.index("gcloud run deploy sprintable-frontend")
    assembly = script[:idx] + '\necho "ENV_VARS=${ENV_VARS}"\necho "FE_REMOVE_ENV=${FE_REMOVE_ENV}"\n'
    subs = set(re.findall(r"\$\{(_[A-Z0-9_]+)\}", assembly))
    env = {**os.environ, **{k: "x" for k in subs}, "_DEPLOY_ENV": deploy_env}
    r = subprocess.run(["bash", "-c", assembly], env=env, capture_output=True, text=True, check=True)
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line and line.split("=", 1)[0] in ("ENV_VARS", "FE_REMOVE_ENV"))


def test_frontend_turns_the_probe_on_in_dev_only_and_removes_it_elsewhere():
    dev = _run_frontend_assembly("dev")
    assert "XFF_PROBE_ENABLED=true" in dev["ENV_VARS"].split(",")
    assert dev["FE_REMOVE_ENV"] == ""  # 같은 키를 켜면서 지우지 않는다
    for other in ("prod", "staging"):
        got = _run_frontend_assembly(other)
        assert "XFF_PROBE_ENABLED" not in got["ENV_VARS"]
        assert got["FE_REMOVE_ENV"] == "--remove-env-vars=XFF_PROBE_ENABLED"


def test_frontend_deploy_command_carries_the_removal_flag():
    from tests.test_deploy_backend_redis_secret_conflict import _extract_step_script

    script = _extract_step_script("deploy-frontend")
    call = script[script.index("gcloud run deploy sprintable-frontend"):]
    assert "$${FE_REMOVE_ENV}" in call.split("--quiet")[0]

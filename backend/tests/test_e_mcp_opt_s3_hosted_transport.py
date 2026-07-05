"""E-MCP-OPT S3: 호스팅(http) transport 유도 — connect-step BE 계약.

①`build_agent_mcp_config` transport 분기 + edition 기본 + 두 변형 bundle
②crux2 — verify rail transport-aware 분기(http=heartbeat 기반 4단계 축소 레일)
③router 레벨 `transport` 쿼리 배선(connection-artifact/verify-connection/verification-status)
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.routers.agents as ag
from app.services import agent_onboarding_config as cfg
from app.services.agent_verify import (
    HTTP_RAIL_STATES,
    RAIL_STATES,
    build_http_verification_rail,
    get_verification_state,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ① build_agent_mcp_config transport 분기 ───────────────────────────────────
def test_stdio_default_unchanged_when_no_transport_kwarg():
    """기존 호출부(회귀0) — transport 미지정이면 여전히 stdio."""
    out = cfg.build_agent_mcp_config(api_key_plaintext="k")
    assert out["mcpServers"]["sprintable"]["type"] == "stdio"


def test_http_variant_none_when_mcp_public_url_unset(monkeypatch):
    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)
    assert cfg.resolve_mcp_public_url() is None
    assert cfg.build_agent_mcp_config(api_key_plaintext="k", transport="http") is None


def test_http_variant_shape_with_key(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp/")
    assert cfg.resolve_mcp_public_url() == "https://mcp.sprintable.ai/mcp"  # trailing slash 제거
    out = cfg.build_agent_mcp_config(api_key_plaintext="sk_live_abc", transport="http")
    server = out["mcpServers"]["sprintable"]
    assert server == {
        "type": "http",
        "url": "https://mcp.sprintable.ai/mcp",
        "headers": {"Authorization": "Bearer sk_live_abc"},
    }


def test_http_variant_no_auth_header_when_key_absent(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    out = cfg.build_agent_mcp_config(api_key_plaintext=None, transport="http")
    assert out["mcpServers"]["sprintable"]["headers"] == {}


def test_default_transport_for_edition(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "license_consent", "", raising=False)
    assert cfg.default_transport_for_edition() == "stdio"
    monkeypatch.setattr(settings, "license_consent", "agreed", raising=False)
    assert cfg.default_transport_for_edition() == "http"


def test_bundle_saas_with_hosting_available(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "license_consent", "agreed", raising=False)
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    bundle = cfg.build_agent_mcp_config_bundle(api_key_plaintext="k")
    assert bundle["default_transport"] == "http"
    assert bundle["mcp_config"]["mcpServers"]["sprintable"]["type"] == "http"
    assert set(bundle["mcp_config_alternatives"]) == {"stdio"}


def test_bundle_oss_no_hosting_falls_back_to_stdio_only(monkeypatch):
    """OSS(호스팅 미배포) — MCP_PUBLIC_URL 미설정이면 default가 http여도 stdio로 폴백·alternatives 비움."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "license_consent", "agreed", raising=False)  # 가정: edition=SaaS이나
    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)                  # 이 인스턴스엔 호스팅 미배포
    bundle = cfg.build_agent_mcp_config_bundle(api_key_plaintext="k")
    assert bundle["default_transport"] == "stdio"
    assert bundle["mcp_config"]["mcpServers"]["sprintable"]["type"] == "stdio"
    assert bundle["mcp_config_alternatives"] == {}


def test_bundle_oss_default_stdio(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "license_consent", "", raising=False)
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")  # 배포는 있어도 OSS면 기본 stdio
    bundle = cfg.build_agent_mcp_config_bundle(api_key_plaintext="k")
    assert bundle["default_transport"] == "stdio"
    assert set(bundle["mcp_config_alternatives"]) == {"http"}


# ── ② crux2 — verify rail transport-aware ─────────────────────────────────────
def _states(rail):
    return {r["state"]: r["status"] for r in rail}


def test_http_rail_is_4_states_no_event_delivered_ack():
    rail = build_http_verification_rail(heartbeat_fresh=True)
    assert [r["state"] for r in rail] == list(HTTP_RAIL_STATES)
    assert len(HTTP_RAIL_STATES) == 4
    assert "event_delivered" not in _states(rail) and "ack" not in _states(rail)


def test_http_rail_fresh_heartbeat_all_done():
    s = _states(build_http_verification_rail(heartbeat_fresh=True))
    assert all(v == "done" for v in s.values())


def test_http_rail_no_heartbeat_waiting_active():
    s = _states(build_http_verification_rail(heartbeat_fresh=False))
    assert s["config_copied"] == "done"
    assert s["waiting"] == "active"
    assert s["mcp_reachable"] == "pending" and s["verified"] == "pending"


def _scalar(v):
    r = MagicMock()
    r.scalar_one_or_none.return_value = v
    return r


def _first(v):
    r = MagicMock()
    r.first.return_value = v
    return r


@pytest.mark.anyio
async def test_get_verification_state_http_uses_heartbeat_not_sse(monkeypatch):
    """transport='http' 는 Event/AgentEventCursor(SSE) 를 아예 조회 안 하고 heartbeat freshness 1회만."""
    from app.routers import agent_gateway as gw
    monkeypatch.setattr(gw, "_SESSION_FRESH_TTL", 60, raising=False)

    db = AsyncMock()
    db.execute = AsyncMock(return_value=_first(("profile-row",)))  # fresh heartbeat 존재
    out = await get_verification_state(db, uuid.uuid4(), transport="http")
    assert db.execute.await_count == 1  # SSE 관련 verify_seq/acked_seq 조회 0회
    assert out["verified"] is True
    assert [r["state"] for r in out["rail"]] == list(HTTP_RAIL_STATES)
    assert out["verify_seq"] is None and out["acked_seq"] is None  # http 는 이 개념 자체가 없음


@pytest.mark.anyio
async def test_get_verification_state_http_no_heartbeat_not_verified():
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_first(None))
    out = await get_verification_state(db, uuid.uuid4(), transport="http")
    assert out["verified"] is False


@pytest.mark.anyio
async def test_get_verification_state_stdio_default_unchanged():
    """transport 미지정 = 기존 stdio 6단계 경로 그대로(회귀0)."""
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalar(5), _scalar(7), _first(("sess",))])
    out = await get_verification_state(db, uuid.uuid4())
    assert [r["state"] for r in out["rail"]] == list(RAIL_STATES)
    assert out["verified"] is True


# ── ③ router 레벨 transport 배선 ──────────────────────────────────────────────
@pytest.mark.anyio
async def test_connection_artifact_transport_http_returns_http_content(monkeypatch):
    from app.routers.agents import get_agent_connection_artifact

    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    agent_id = uuid.uuid4()
    res = MagicMock()
    res.scalar_one_or_none.return_value = SimpleNamespace(id=agent_id, project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    with patch("app.routers.agents.AgentPersonaRepository.list", new_callable=AsyncMock, return_value=[]):
        out = await get_agent_connection_artifact(
            agent_id, runtime="claude-code", transport="http",
            session=db, auth=MagicMock(), org_id=uuid.uuid4(),
        )
    mcp_file = next(f for f in out["files"] if f["filename"] == ".mcp.json")
    parsed = json.loads(mcp_file["content"])
    assert parsed["mcpServers"]["sprintable"]["type"] == "http"


@pytest.mark.anyio
async def test_connection_artifact_transport_http_unavailable_400(monkeypatch):
    """http 명시 요청됐는데 이 환경엔 호스팅 배포가 없음(MCP_PUBLIC_URL 미설정) — 400."""
    from fastapi import HTTPException

    from app.routers.agents import get_agent_connection_artifact

    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)
    agent_id = uuid.uuid4()
    res = MagicMock()
    res.scalar_one_or_none.return_value = SimpleNamespace(id=agent_id, project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    with patch("app.routers.agents.AgentPersonaRepository.list", new_callable=AsyncMock, return_value=[]):
        with pytest.raises(HTTPException) as ei:
            await get_agent_connection_artifact(
                agent_id, runtime="claude-code", transport="http",
                session=db, auth=MagicMock(), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_connection_artifact_unsupported_transport_400():
    from fastapi import HTTPException

    from app.routers.agents import get_agent_connection_artifact
    agent_id = uuid.uuid4()
    res = MagicMock()
    res.scalar_one_or_none.return_value = SimpleNamespace(id=agent_id, project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    with patch("app.routers.agents.AgentPersonaRepository.list", new_callable=AsyncMock, return_value=[]), \
         pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            agent_id, runtime="claude-code", transport="carrier-pigeon",
            session=db, auth=MagicMock(), org_id=uuid.uuid4(),
        )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_verify_connection_http_skips_synthetic_event_and_wake(monkeypatch):
    """transport='http' — start_verification/wake_agent(SSE 전용 경로) 전혀 호출 안 됨."""
    from types import SimpleNamespace as _SN
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    db = AsyncMock()
    rail = [{"state": s, "status": "done"} for s in HTTP_RAIL_STATES]
    with patch.object(ag, "assert_agent_owner", new=AsyncMock(return_value=member)), \
         patch.object(ag, "start_verification", new=AsyncMock()) as start, \
         patch.object(ag, "get_verification_state",
                      new=AsyncMock(return_value={"verified": True, "rail": rail, "verify_seq": None})), \
         patch("app.routers.agent_gateway.wake_agent", new=MagicMock()) as wake:
        out = await ag.verify_agent_connection(
            member.id, transport="http", session=db,
            auth=_SN(user_id=str(uuid.uuid4())), org_id=uuid.uuid4(),
        )
    assert out["verified"] is True and out["rail"] == rail
    start.assert_not_awaited()
    wake.assert_not_called()


@pytest.mark.anyio
async def test_verification_status_passes_transport_through():
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalar(member))
    with patch.object(ag, "get_verification_state", new=AsyncMock(
        return_value={"verified": True, "rail": [], "verify_seq": None},
    )) as get_state:
        await ag.agent_verification_status(
            member.id, transport="http", session=db, auth=MagicMock(), org_id=uuid.uuid4(),
        )
    get_state.assert_awaited_once_with(db, member.id, transport="http")


# ── emit_onboarding_event dynamic transport (하드코딩 제거 회귀 가드) ──────────
def test_agents_router_no_longer_hardcodes_transport_stdio_literal():
    """agents.py 소스에 `transport=\"stdio\"` 하드코딩 문자열이 (verify-connection 자체의
    event_sent 콜 1곳 제외) 더는 없어야 한다 — agent_created/config_generated 는 실제
    default_transport/resolved_transport 변수를 넘겨야(안 그러면 SaaS 퍼널이 전부 stdio로 오기록)."""
    import inspect
    src = inspect.getsource(ag)
    create_src = inspect.getsource(ag.create_org_agent)
    artifact_src = inspect.getsource(ag.get_agent_connection_artifact)
    assert 'transport="stdio"' not in create_src
    assert 'transport="stdio"' not in artifact_src
    assert 'transport=config_bundle["default_transport"]' in create_src
    assert "transport=resolved_transport" in artifact_src

"""E-RECRUIT S3 (story ff2996d0): POST /agents/{id}/recruit 라우터 계약 — mock 기반.

DB write 시맨틱(persona upsert/키 회전)은 realdb 테스트(test_e_recruit_s3_recruit_service_realdb.py)
가 실증한다. 여기선 라우터 계층의 404/400 분기 + 응답 shape만 확인(순수 도메인 로직은 이미
compose_prompt(S2)/recruit_agent(realdb)가 커버).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_ctx():
    return SimpleNamespace(user_id=str(uuid.uuid4()))


@pytest.mark.anyio
async def test_recruit_404_when_agent_not_found():
    from fastapi import HTTPException
    from app.routers.agents import recruit_agent_endpoint
    from app.schemas.recruit import RecruitRequest

    session = MagicMock()
    with patch("app.routers.agents._fetch_org_agent", AsyncMock(return_value=None)):
        with pytest.raises(HTTPException) as ei:
            await recruit_agent_endpoint(
                uuid.uuid4(), RecruitRequest(role_template_slug="backend"),
                session=session, auth=_auth_ctx(), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_recruit_400_on_unsupported_runtime():
    from fastapi import HTTPException
    from app.routers.agents import recruit_agent_endpoint
    from app.schemas.recruit import RecruitRequest

    session = MagicMock()
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    with patch("app.routers.agents._fetch_org_agent", AsyncMock(return_value=member)):
        with pytest.raises(HTTPException) as ei:
            await recruit_agent_endpoint(
                uuid.uuid4(), RecruitRequest(role_template_slug="backend", runtime="bogus-runtime"),
                session=session, auth=_auth_ctx(), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_recruit_404_when_role_template_not_found():
    from fastapi import HTTPException
    from app.routers.agents import recruit_agent_endpoint
    from app.schemas.recruit import RecruitRequest

    session = MagicMock()
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    with patch("app.routers.agents._fetch_org_agent", AsyncMock(return_value=member)), \
         patch("app.routers.agents.get_published_role_template", AsyncMock(return_value=None)):
        with pytest.raises(HTTPException) as ei:
            await recruit_agent_endpoint(
                uuid.uuid4(), RecruitRequest(role_template_slug="nonexistent"),
                session=session, auth=_auth_ctx(), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_recruit_400_when_recruit_agent_raises_value_error():
    """QA MINOR 하드닝: recruit_agent의 fail-closed ValueError가 400으로 매핑되는지(500 아님)."""
    from fastapi import HTTPException
    from app.routers.agents import recruit_agent_endpoint
    from app.schemas.recruit import RecruitRequest

    session = MagicMock()
    session.commit = AsyncMock()
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    role_template = SimpleNamespace(slug="bogus", default_tool_groups=["not-real"])
    with patch("app.routers.agents._fetch_org_agent", AsyncMock(return_value=member)), \
         patch("app.routers.agents.get_published_role_template", AsyncMock(return_value=role_template)), \
         patch("app.routers.agents.recruit_agent", AsyncMock(side_effect=ValueError("unknown group"))):
        with pytest.raises(HTTPException) as ei:
            await recruit_agent_endpoint(
                uuid.uuid4(), RecruitRequest(role_template_slug="bogus"),
                session=session, auth=_auth_ctx(), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_recruit_success_response_shape():
    from app.routers.agents import recruit_agent_endpoint
    from app.schemas.recruit import RecruitRequest

    session = MagicMock()
    session.commit = AsyncMock()
    agent_id = uuid.uuid4()
    member = SimpleNamespace(id=agent_id, project_id=uuid.uuid4())
    role_template = SimpleNamespace(slug="backend", default_tool_groups=["stories", "tasks"])
    persona = SimpleNamespace(id=uuid.uuid4(), system_prompt="합성된 지침 텍스트")
    recruit_result = {
        "persona": persona,
        "api_key_plaintext": "sk_live_deadbeef",
        "tool_allowlist": ["stories", "tasks"],
    }
    bundle = {
        "default_transport": "stdio",
        "mcp_config": {"mcpServers": {"sprintable": {"type": "stdio"}}},
        "mcp_config_alternatives": {},
    }

    with patch("app.routers.agents._fetch_org_agent", AsyncMock(return_value=member)), \
         patch("app.routers.agents.get_published_role_template", AsyncMock(return_value=role_template)), \
         patch("app.routers.agents.recruit_agent", AsyncMock(return_value=recruit_result)), \
         patch("app.routers.agents.build_agent_mcp_config_bundle", MagicMock(return_value=bundle)), \
         patch("app.routers.agents.emit_onboarding_event", AsyncMock()):
        response = await recruit_agent_endpoint(
            agent_id, RecruitRequest(role_template_slug="backend"),
            session=session, auth=_auth_ctx(), org_id=uuid.uuid4(),
        )

    assert response["agent_id"] == str(agent_id)
    assert response["role_template_slug"] == "backend"
    assert response["system_prompt"] == "합성된 지침 텍스트"
    assert response["tool_allowlist"] == ["stories", "tasks"]
    assert response["api_key"] == "sk_live_deadbeef"
    assert response["default_transport"] == "stdio"
    assert response["mcp_config"] == bundle["mcp_config"]
    session.commit.assert_awaited_once()

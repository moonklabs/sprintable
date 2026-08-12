"""story #2600(P1·A2A발견) — 찰스 시나리오 e2e(실 PG). #2584 스파이크 doc ③ 판정기준의 자동화.

시나리오: 신입 에이전트(찰스)가 「버그 고쳐서 PR 올리고 QA 받아주기 바라는」 한 줄만 받는다.
QA 담당 member_id는 아무도 알려주지 않는다. 찰스는 발견 도구가 감싸는 실 엔드포인트
(`GET /api/v2/a2a/members?skill=`, #2597)를 스스로 호출해 QA 적임자를 찾고(#2599가 백필한
qa-automation 카탈로그 skills로 신호가 이름 문자열 하나가 아니라 구조화된 tags를 갖는다),
찾은 member_id로 실제 메시지를 전달한다.

핵심 검증(스파이크 ③ 4단계) = 발견: 디스트랙터(backend 에이전트)는 매칭에서 제외되고, 찰스
쪽 어떤 fixture/컨텍스트도 QA member_id를 사전 주입하지 않는다 — 발견 HTTP 호출의 실 응답에서만
그 id가 나온다(우연히 지어낸 이름이 아니라 실제 조회로 찾았다는 증거). 도달(5·6단계)은 기존
SendMessage 경로(#2583/#2597 파이프라인)를 그대로 재사용 — A2A RPC 태스크 완결까지는 요구하지
않는다(TASK_STATE_WORKING 생성 + 서버측 Event 관측까지).

DB env 없으면 skip — 이 DB는 alembic head까지 마이그돼 있어야 한다(#2599의 role_templates.skills
백필된 실 seed를 그대로 재사용 — synthetic role_template을 새로 만들지 않는다).
"""
from __future__ import annotations

import os
import uuid
from urllib.parse import urlparse

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_with_key(app, raw_key: str):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Bearer {raw_key}"},
    )


async def _seed_agent(session, *, org_id, project_id, name: str, agent_role: str | None) -> dict:
    """org-scoped agent(Member+AgentProjectProfile+ProjectAccess) + ApiKey(sk_live_) 시드 —
    #2599 realdb 패턴(test_e_mcp_opt_ff6cb90d_multiproject_scoping_realdb.py) 재사용."""
    from app.core.security import hash_token
    from app.models.api_key import ApiKey
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name)
    session.add(agent)
    await session.commit()
    session.add(AgentProjectProfile(
        id=uuid.uuid4(), member_id=agent.id, project_id=project_id, agent_role=agent_role,
    ))
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=agent.id, permission="granted",
    ))
    await session.commit()

    raw_key = f"sk_live_{uuid.uuid4().hex}"
    session.add(ApiKey(
        id=uuid.uuid4(), team_member_id=agent.id, member_id=agent.id,
        key_prefix=raw_key[:12], key_hash=hash_token(raw_key), scope=["read", "write"],
    ))
    await session.commit()
    return {"member_id": agent.id, "raw_key": raw_key}


async def _attach_persona(session, *, org_id, project_id, member_id, role_template_id, slug, name):
    """recruit_agent()를 거치지 않고 그 결과 형태(persona.config.role_template_id marker)만
    재현 — a2a.py `_build_agent_card`가 실제로 읽는 자리(role_template_id 있으면 그 role_template
    의 skills를 카드-빌드 시점에 직접 반영)."""
    from app.models.agent_deployment import AgentPersona

    session.add(AgentPersona(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=member_id,
        name=name, slug=slug, description=f"{name} persona", config={"role_template_id": str(role_template_id)},
        is_default=True,
    ))
    await session.commit()


async def test_charlie_discovers_qa_without_prior_injection_and_reaches_them():
    from sqlalchemy import select

    from app.main import app
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.role_template import RoleTemplate
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()

        async with Session() as s:
            s.add(Organization(id=org_id, name="Charlie Org", slug=f"org-{uuid.uuid4().hex[:8]}"))
            await s.commit()
            s.add(Project(id=project_id, org_id=org_id, name="P"))
            await s.commit()

            # #2599가 백필한 실 seed 그대로 재사용 — synthetic role_template 신설 안 함.
            qa_rt = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.slug == "qa-automation")
            )).scalar_one()
            assert qa_rt.skills, (
                "qa-automation.skills가 비어있음 — #2599 마이그(0240) 미적용 DB. "
                "이 테스트는 alembic head까지 마이그된 DB가 전제."
            )

            qa = await _seed_agent(
                s, org_id=org_id, project_id=project_id, name="카디르", agent_role="qa-automation",
            )
            await _attach_persona(
                s, org_id=org_id, project_id=project_id, member_id=qa["member_id"],
                role_template_id=qa_rt.id, slug="qa-automation", name="카디르",
            )

            # 디스트랙터 — skill 매칭에서 제외돼야 「아무나 반환」이 아님을 증명.
            backend_rt = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.slug == "backend")
            )).scalar_one()
            distractor = await _seed_agent(
                s, org_id=org_id, project_id=project_id, name="디디", agent_role="backend",
            )
            await _attach_persona(
                s, org_id=org_id, project_id=project_id, member_id=distractor["member_id"],
                role_template_id=backend_rt.id, slug="backend", name="디디",
            )

            # 찰스 — QA member_id를 아는 게 전혀 없는 신입 에이전트. 이 시드 함수 호출부
            # 어디에도 qa["member_id"]를 넘기지 않는다(구조적으로 주입 불가).
            charlie = await _seed_agent(
                s, org_id=org_id, project_id=project_id, name="찰스", agent_role=None,
            )

        app.dependency_overrides.clear()

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise
        app.dependency_overrides[get_db] = _db

        client = _client_with_key(app, charlie["raw_key"])
        try:
            # ── 스파이크 ③ 4단계: 발견 — 찰스가 실제로 발견 엔드포인트를 호출한다 ──────────
            # tags-only 검색어(qa-automation.name/description에는 없음, #2599 백필 tags에만
            # 있음) — 이 검색이 성공한다는 것 자체가 「이름을 지어낸 게 아니라 #2599가 채운
            # 구조화 skills를 실제로 조회했다」는 증거(스파이크 doc 갭 D가 실제로 닫혔다는 실측).
            discover_resp = await client.get("/api/v2/a2a/members", params={"skill": "test-automation"})
            assert discover_resp.status_code == 200, discover_resp.text
            cards = discover_resp.json()

            found_ids = {c["name"] for c in cards}
            assert "카디르" in found_ids, f"QA 후보가 발견 응답에 없음: {cards}"
            assert "디디" not in found_ids, "디스트랙터(backend)가 QA 스킬 검색에 잘못 매칭됨"

            qa_card = next(c for c in cards if c["name"] == "카디르")
            discovered_member_id = uuid.UUID(qa_card["supportedInterfaces"][0]["tenant"])
            # 검증(사전 주입 아님을 확인하는 assert) — 찰스의 "발견" 산출물이 실제 QA id와
            # 일치하는지는 여기서 처음 비교된다(그 전까지 discovered_member_id라는 변수 자체가
            # 존재하지 않았다).
            assert discovered_member_id == qa["member_id"]

            interface_path = urlparse(qa_card["supportedInterfaces"][0]["url"]).path
            assert interface_path == f"/api/v2/a2a/members/{discovered_member_id}/rpc"

            # ── 스파이크 ③ 5·6단계: 도달 — 기존 A2A SendMessage 경로 재사용, 새 코드 없음 ──
            rpc_resp = await client.post(interface_path, json={
                "jsonrpc": "2.0",
                "id": "charlie-1",
                "method": "SendMessage",
                "params": {
                    "message": {
                        "messageId": str(uuid.uuid4()),
                        "role": "ROLE_USER",
                        "parts": [{"text": "PR #999 올렸어요, QA 봐주실 수 있나요?"}],
                    }
                },
            })
            assert rpc_resp.status_code == 200, rpc_resp.text
            rpc_body = rpc_resp.json()
            assert "error" not in rpc_body or rpc_body["error"] is None, rpc_body
            task = rpc_body["result"]["task"]
            assert task["status"]["state"] == "TASK_STATE_WORKING"

            # 서버측 관측 — A2ATask가 실제로 discovered_member_id(카디르) 앞으로 생성됨.
            from app.models.a2a_task import A2ATask
            async with Session() as s:
                created = (await s.execute(
                    select(A2ATask).where(A2ATask.id == uuid.UUID(task["id"]))
                )).scalar_one()
                assert created.member_id == discovered_member_id
                assert created.state == "TASK_STATE_WORKING"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()

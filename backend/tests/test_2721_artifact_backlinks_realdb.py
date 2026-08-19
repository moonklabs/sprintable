"""story #2721(아티팩트·원장 1급화 1단) — `GET /api/v2/visual-artifacts/{id}/backlinks` 실PG
검증.

그라운딩(2026-08-17, 디디)이 확認한 사실: WRITE(entity_references에 target_type=artifact
저장)는 이미 배선돼 있었다(reference_registry.ENTITY_RESOLVERS에 artifact가 이미 등재 —
직접 실PG 왕복으로 실증됨, `insert_chat_mentions`로 채팅 메시지 안 `entity:artifact:` 토큰이
그대로 저장됨). 이 스토리의 유일한 신규 로직은 READ(backlinks 조회) — `BACKLINKS_ALLOWED_
TARGET_TYPES`에 artifact 추가 + `GET /{id}/backlinks` 엔드포인트 신설뿐이다.

커버:
  AC1: 채팅 메시지의 entity:artifact: 참조 → entity_references 저장(이미 됨, 회귀가드로
       재확認) + 이 엔드포인트가 그 참조를 목록으로 되돌려줌.
  AC3: 기존 참조 계약(#2679 origin·#2702 explicit) 무회귀 — auto 참조는 응답에서 빠짐.
  AC4: 존재하지 않는 artifact 404, project 접근 없으면 404(existence-non-disclosure,
       `_get_artifact_or_404`의 기존 계약 그대로 상속 — 새 인가 로직 발명 0).
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

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


# ─── seeding ────────────────────────────────────────────────────────────────

async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2721", slug=f"org2721-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted",
    ))
    await session.commit()
    return member_id


async def _seed_artifact(session, org_id, project_id, created_by, title="아티팩트"):
    from app.models.visual_artifact import VisualArtifact

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, created_by=created_by,
    )
    session.add(artifact)
    await session.commit()
    return artifact


async def _seed_conversation(session, org_id, project_id, member_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title="T", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _seed_message(session, conversation_id, sender_id, content="본문"):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id, content=content,
        created_at=datetime.now(UTC),
    )
    session.add(msg)
    await session.commit()
    return msg


async def _make_reference(
    session, org_id, source_type, source_id, target_type, target_id, created_by,
    origin="explicit", form="mention",
):
    from app.models.reference import Reference
    ref = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field="body",
        source_id=source_id, target_type=target_type, target_id=target_id, form=form,
        origin=origin, created_by=created_by,
    )
    session.add(ref)
    await session.commit()
    return ref


def _agent_auth(agent_id, org_id, project_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {
            "org_id": str(org_id), "project_id": str(project_id), "api_key_id": str(uuid.uuid4()),
        }},
    )


async def _setup_app(app, Session, agent_id, org_id, project_id):
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return _agent_auth(agent_id, org_id, project_id)

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ─── AC1 — 실 왕복: 채팅 메시지의 entity:artifact 참조 → entity_references → backlinks ──

@pytest.mark.anyio
async def test_chat_message_artifact_mention_appears_in_backlinks():
    from app.main import app
    from app.services.mention_parser import insert_chat_mentions
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            artifact = await _seed_artifact(s, org_id, project_id, agent_id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            # 실 send_message() 경로는 ConversationMessage를 먼저 만든 뒤 그 id로
            # insert_chat_mentions를 부른다(mention_parser.py는 참조-write 헬퍼일 뿐 메시지
            # 자체를 만들지 않는다) — 여기서도 같은 순서로 진짜 메시지 행을 먼저 심는다.
            token = build_reference_token("artifact", artifact.id, artifact.title)
            msg = await _seed_message(s, conv_id, agent_id, content=f"참고: {token}")
            result = await insert_chat_mentions(
                s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id,
            )
            await s.commit()
            assert result.stored == 1, "그라운딩이 확認한 WRITE 배선 자체가 회귀하면 여기서 잡힌다"
            msg_id = msg.id

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            source_ids = {item["source_id"] for item in body["data"]}
            assert str(msg_id) in source_ids
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC3 — 기존 참조 계약 무회귀(#2679 origin 필터) ─────────────────────────────

@pytest.mark.anyio
async def test_backlinks_excludes_auto_origin_includes_explicit():
    """#2679가 세운 origin 필터가 artifact target에도 동형 적용되는지 — story/doc 대상으로 이미
    검증된 필터 로직을 target_type 파라미터만 바꿔 재사용하는 것이라(재구현 0) 이 축이 새로
    깨질 이유는 구조적으로 없지만, "artifact를 처음 여는 이 PR이 그 불변식을 실제로 상속받는가"
    자체가 이 스토리 AC3의 요구사항이라 직접 확認한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            artifact = await _seed_artifact(s, org_id, project_id, agent_id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)
            auto_msg = await _seed_message(s, conv_id, agent_id, content="auto")
            explicit_msg = await _seed_message(s, conv_id, agent_id, content="explicit")

            await _make_reference(
                s, org_id, "chat_message", auto_msg.id, "artifact", artifact.id, agent_id, origin="auto",
            )
            await _make_reference(
                s, org_id, "chat_message", explicit_msg.id, "artifact", artifact.id, agent_id,
                origin="explicit",
            )

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact.id}/backlinks")
            assert resp.status_code == 200, resp.text
            source_ids = {item["source_id"] for item in resp.json()["data"]}
            assert str(auto_msg.id) not in source_ids, "auto 참조가 새면 #2679 회귀"
            assert str(explicit_msg.id) in source_ids, "explicit 참조는 그대로 떠야 함"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC4 — 존재/접근 게이트(existence-non-disclosure) ──────────────────────────

@pytest.mark.anyio
async def test_nonexistent_artifact_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{uuid.uuid4()}/backlinks")
            assert resp.status_code == 404
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_artifact_in_other_project_returns_404_not_cross_project_leak():
    """SEC-S8류(story 83ea3d6a) 선례 — org는 같은데 project가 다른 artifact_id를 직접 조회하면
    404(existence-non-disclosure, `_get_artifact_or_404`의 org_id+project_id 이중 필터 그대로
    상속). 이 스토리가 새 크로스-project 구멍을 열지 않는지 실측."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a = await _seed_org_project(s)
            from app.models.project import Project
            project_b = Project(id=uuid.uuid4(), org_id=org_id, name="ProjectB")
            s.add(project_b)
            await s.commit()

            agent_in_a = await _seed_agent(s, org_id, project_a)
            artifact_in_b = await _seed_artifact(s, org_id, project_b.id, agent_in_a)

        await _setup_app(app, Session, agent_in_a, org_id, project_a)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact_in_b.id}/backlinks")
            assert resp.status_code == 404
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()

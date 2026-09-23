"""story #4142(critical·[E-RECIPE-1], 페드루 PO 처방 2026-09-22) — 레시피 자동 발행이
영상(REELS, 비동기 컨테이너) 초안에서 `container_created`에 멈추던 실사고의 처방.

근본원인(원문 실측, `publish_recipe_approved_draft` — channel_posts.py:2442~): 이
함수가 `publish_channel_post_draft()`의 반환을 무조건 최종 성공으로 간주해
`gate.publish_outcome="published"`를 쓰고 published stage 이벤트까지 냈다 — 그런데
비동기 미디어(REELS 등)는 컨테이너만 만들고 `status="container_created"`를 돌려주며,
호출부가 그 시점에 `PublicationCommand`를 pending으로 안 남기면 아무 워커 tick도
그 컨테이너를 이어 폴링하지 않는다(즉시-발행 라우터는 이미 이렇게 하고 있었다 —
`channel_posts.py::publish_channel_post_draft_endpoint`, 2303~2316행).

처방: 즉시-발행 라우터와 동일 헬퍼(`create_or_get_publication_command`)로 command를
pending 남기고, 실제 완료는 기존 워커(#4093 경로, `resolve_recipe_context_for_
scheduled_publication`)가 이어받게 한다 — 새 로직 발명 0, #4093이 이미 성공/실패
양쪽 다 레시피 published stage 이벤트·publish_outcome 갱신을 구현해 둔 걸 재사용한다.

세팅 헬퍼는 test_4090_ac2_recipe_auto_publish_realdb.py·test_4093_scheduled_publish_
event_realdb.py의 하네스를 그대로 미러(발명 0) — 채널만 REELS 지원 가능한
"instagram_sandbox"로 바꾸고, 제출된 버전에 영상 마스터를 직접 seed한다(업로드
멀티파트 왕복은 test_3554의 스코프 — 이 파일은 그 경로를 재검증하지 않는다).

AC5(페드루 PO CHANGES-1, 2026-09-22) — 초안 «화면 클릭 0으로 완주» 처방은 스크립트가
아니라 워커 tick(`publication_command.py::process_due_publication_commands`) 자체의
self-heal 스윕(`_sweep_stuck_container_created_publications`)이다 — 사람이 gcloud로
oneoff Job을 돌릴 필요 0, 이미 Cloud Scheduler로 도는 이 함수가 다음 실행부터
스스로 고친다(`test_ac5e_...`가 그 스윕 1틱→2틱 전체 루프를 잰다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
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


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_620beefc_channel_post_image_upload.py::_local_channel_media_storage와
    동형 — 커버 이미지 업로드(그 모듈의 `_upload_and_confirm`/`_put_raw_object`를
    그대로 재사용)가 이 fixture 없이는 CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED(503)로
    막힌다. 버킷 이름은 그 모듈 자신의 `_CHANNEL_MEDIA_BUCKET` 상수를 그대로 써야
    한다 — `_put_raw_object`가 그 상수로 저장하므로, 여기서 다른 이름으로
    monkeypatch하면 저장한 곳과 confirm이 읽는 곳이 어긋난다."""
    import app.services.channel_post_images as cpi_module
    from tests.test_620beefc_channel_post_image_upload import _CHANNEL_MEDIA_BUCKET

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib

    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


def _load_migration_module(filename: str, alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        alias, os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4142")
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4142",
)
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4142",
)
_KEY = "preset.4142.video_production"
_PAYLOAD_SCHEMA = _MIG_0382._NEW_PAYLOAD_SCHEMA
_ROUTING = _MIG_0381._ROUTING
_STAGE_METADATA = _MIG_0387._NEW_STAGE_METADATA


async def _realdb_session():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_references_non_proof "
            "ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation) "
            "WHERE form <> 'proof'"
        ))
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE runtime_type = 'system-publisher' AND type = 'agent'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org4142", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user_id = uuid.uuid4()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user_id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human",
        name="org owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id, owner_user_id


async def _seed_system_publisher_teammember_shim(session, org_id, project_id):
    """test_4090_ac2/test_4093 동형 shim — team_members는 실 DB에선 VIEW라
    create_all() 하네스가 못 만든다(그라운딩 갭 정정 선례 재사용)."""
    from app.models.team import TeamMember
    from app.routers.events import _get_or_create_system_publisher

    system_member = await _get_or_create_system_publisher(session, org_id)
    session.add(TeamMember(
        id=system_member.id, org_id=org_id, project_id=project_id, type="agent",
        name="시스템 발행", is_active=True,
    ))
    await session.commit()


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC1 영상 자동발행"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(4142 테스트)",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_reels_connection(session, org_id, *, status="active"):
    """story #4142 — instagram_sandbox: REELS(create_reels_container)를 지원하는
    유일한 sandbox 채널(plain "sandbox"는 REELS 미지원, #4090 하네스가 쓰던 채널
    그대로는 이 스토리의 비동기 컨테이너 경로를 못 밟는다)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="instagram_sandbox",
        account_id=f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token") if status == "active" else None,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_text_sandbox_connection(session, org_id, *, account_id=None):
    """AC4-d 회귀대조 전용 — plain "sandbox"(Threads류, text-optional)는 IMAGE도
    REELS도 아닌 순수 TEXT 즉시-동기 경로를 태운다(instagram_sandbox는 이미지가
    필수라 이 대조엔 안 맞는다, instagram_sandbox_publish.py::create_container
    INSTAGRAM_IMAGE_REQUIRED 실측)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox",
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="none", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token"),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_recipe_channel_binding(session, org_id, connection_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=None, event_definition_key=_KEY,
        stage="published", channel_connection_id=connection_id,
    ))
    await session.commit()


async def _seed_video_for_version(session, *, org_id, draft_id, version_id, created_by):
    """story #4142 — 업로드 멀티파트 왕복(signed URL→confirm, test_3554 스코프) 대신
    영상 마스터 행을 직접 심는다. 이 값들은 오케스트레이션의 `has_video` 판별
    (channel_post_videos 행 존재 여부, channel_posts.py:1783-1789)에만 쓰이고
    sandbox 어댑터는 video_url 내용 자체를 검사하지 않는다(결정적 stateless
    설계, sandbox_publish.py 계열 공통 계약) — 값은 형식만 맞으면 충분."""
    from app.models.channel_post_video import ChannelPostVideo

    session.add(ChannelPostVideo(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=version_id,
        original_object_path=f"org/{org_id}/channel-posts/{draft_id}/video.mp4",
        original_sha256="0" * 64, original_content_type="video/mp4", original_bytes=1_000_000,
        duration_seconds=15.0, width=1080, height=1920, codec="avc1",
        created_by=created_by,
    ))
    await session.commit()


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext

    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest

    return StarletteRequest(scope={"type": "http", "headers": []})


def _client_for(app):
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth_dep():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth_dep


async def _walk_to_pending_approval_with_abc_approved(s, *, org_id, story_id, creator_id, owner_member_id):
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.gate_service import transition_gate

    async def _publish(stage: str, *, actor_id: uuid.UUID, extra: dict | None = None):
        payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
        if extra:
            payload.update(extra)
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload=payload),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
        )

    await _publish("draft", actor_id=creator_id)
    await _publish("concept_confirmed", actor_id=creator_id)
    gate_a = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_a.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("animatic", actor_id=creator_id)
    gate_b = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "structure_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_b.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("structure_passed", actor_id=owner_member_id, extra={"estimated_cost_minor": 80_000})
    gate_c = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
    )).scalar_one()
    await transition_gate(s, org_id, gate_c.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("pending_approval", actor_id=creator_id)
    gate_d = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish", Gate.scope_key == "")
    )).scalar_one()
    assert gate_d.status == "pending"
    return gate_d.id


async def _create_and_submit_video_draft(
    Session, app, *, org_id, story_id, creator_id, owner_member_id, connection_id,
):
    from sqlalchemy import select

    from app.models.channel_post_version import ChannelPostVersion

    gate_d_id = None
    async with Session() as s:
        gate_d_id = await _walk_to_pending_approval_with_abc_approved(
            s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
        )

    _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
    async with _client_for(app) as client:
        r_draft = await client.post(
            f"/api/v2/organizations/{org_id}/channel-posts/drafts",
            json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "4142 영상 초안"},
        )
        assert r_draft.status_code == 201, r_draft.text
        draft_id = uuid.UUID(r_draft.json()["draft_id"])

        # instagram_sandbox 어댑터는 image_required=True(릴스도 예외 없음 — 커버는
        # 릴스 전용 테이블이 아니라 기존 ChannelPostImage position=0 재사용,
        # channel_post_video.py 모듈 docstring 10~12행) — 제출 검증(channel_posts.py:
        # 1322)이 image_sha256 없이는 422로 막는다. 영상 자체는 여전히 직접 seed.
        from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes, _upload_and_confirm

        cover_bytes = _jpeg_bytes(width=1080, height=1080)
        r_cover = await _upload_and_confirm(client, org_id, draft_id, cover_bytes, content_type="image/jpeg")
        assert r_cover.status_code == 201, r_cover.text

        r_submit = await client.post(
            f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
        )
        assert r_submit.status_code == 200, r_submit.text
        assert r_submit.json()["status"] == "pending", "ⓓ 미승인 상태에서 잘못 자동충족됐다"
        scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

    async with Session() as s:
        version = (await s.execute(
            select(ChannelPostVersion)
            .where(ChannelPostVersion.draft_id == draft_id)
            .order_by(ChannelPostVersion.version.desc()).limit(1)
        )).scalar_one()
        await _seed_video_for_version(
            s, org_id=org_id, draft_id=draft_id, version_id=version.id, created_by=creator_id,
        )

    return gate_d_id, scoped_gate_id, draft_id


@pytest.mark.anyio
async def test_ac1_video_approval_creates_pending_command_not_false_published():
    """AC1 핵심 — 영상(REELS) 초안이 승인되면 즉시 published로 거짓 단정하지 않고,
    즉시-발행 라우터와 동일하게 PublicationCommand를 pending으로 남긴다. 이게 이
    스토리의 근본원인 그 자체(회수 0이면 아무 워커도 이 컨테이너를 이어 폴링 안 함)."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.routers.events import _find_existing_stage_publish
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4142a")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_reels_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

        gate_d_id, scoped_gate_id, draft_id = await _create_and_submit_video_draft(
            Session, app, org_id=org_id, story_id=story_id, creator_id=creator_id,
            owner_member_id=owner_member_id, connection_id=connection_id,
        )

        # ⓓ 승인 — 서비스 직접호출(transition_gate)로 승계-승인+AC1 처방을 트리거.
        async with Session() as s:
            from app.services.gate_service import transition_gate

            await transition_gate(s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인")
            await s.commit()

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert publication is not None, "승인 즉시 컨테이너 생성 자체가 안 일어났다"
            assert publication.status == "container_created", (
                f"REELS는 첫 호출에서 container_created여야 한다: {publication.status!r}"
            )
            assert publication.external_container_id is not None and (
                publication.external_container_id.startswith("sandbox-ig-reels-")
            ), "REELS 컨테이너가 아니라 다른 경로로 샜다"

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert command is not None, (
                "AC1 핵심 — 비동기 컨테이너인데 PublicationCommand가 안 만들어졌다"
                "(이게 이 스토리의 근본원인 그 자체 — 아무 워커도 이어 폴링 못 함)"
            )
            assert command.status == "pending", f"command가 pending이어야: {command.status!r}"
            assert command.next_attempt_at is not None and command.next_attempt_at > datetime.now(timezone.utc), (
                "다음 워커 tick 재시도 시각이 미래로 안 잡혔다"
            )

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome == "publishing", (
                f"비최종 상태인데 publish_outcome이 최종값처럼 남음: {gate_d.publish_outcome!r}"
            )

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is None, (
                "아직 발행이 안 끝났는데 published stage 이벤트가 벌써 났다(거짓 완료 신호)"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_worker_tick_completes_video_publish_and_emits_stage_event_once():
    """AC2 — 워커 tick(#4093 경로 재사용)이 이어받아 실제로 완결하면 published·
    permalink·published stage 이벤트 정확히 1회."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.routers.events import _find_existing_stage_publish
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4142b")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_reels_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

        gate_d_id, scoped_gate_id, draft_id = await _create_and_submit_video_draft(
            Session, app, org_id=org_id, story_id=story_id, creator_id=creator_id,
            owner_member_id=owner_member_id, connection_id=connection_id,
        )

        async with Session() as s:
            from app.services.gate_service import transition_gate

            await transition_gate(s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인")
            await s.commit()

        async with Session() as s:
            # due 시각 경과 후 워커 tick(instagram_sandbox get_container_status는
            # 항상 즉시 FINISHED — 실측: instagram_sandbox_publish.py:135-139).
            counts = await process_due_publication_commands(s, now=datetime.now(timezone.utc) + timedelta(minutes=10))
            assert counts["completed"] == 1, f"워커가 완료로 안 셈: {counts}"

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert publication is not None and publication.status == "published"
            assert (publication.permalink or "").startswith("https://sandbox.invalid/instagram/"), (
                f"자동발행이 sandbox 밖으로 샜다: {publication.permalink}"
            )

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one()
            assert command.status == "completed"

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome == "published", (
                f"워커 발행 성공 뒤 publish_outcome이 최종 성공을 반영 안 함: {gate_d.publish_outcome!r}"
            )

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is not None, "워커 실발행 뒤 레시피 published stage 이벤트가 안 났다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_worker_tick_final_failure_emits_zero_events_and_records_outcome():
    """음성 대조 — 워커 tick 시점에 연결이 비활성화(실사고류: 토큰 만료)되면 published
    이벤트는 0건, gate.publish_outcome엔 publish_failed:<닫힌 3값>만 — 승인자 본인
    resolution_note는 무변(#4090/#4093 규율 동형)."""
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    from app.models.gate import Gate
    from app.routers.events import _find_existing_stage_publish
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4142c")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_reels_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

        gate_d_id, scoped_gate_id, draft_id = await _create_and_submit_video_draft(
            Session, app, org_id=org_id, story_id=story_id, creator_id=creator_id,
            owner_member_id=owner_member_id, connection_id=connection_id,
        )

        async with Session() as s:
            from app.services.gate_service import transition_gate

            await transition_gate(s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인")
            await s.commit()

        async with Session() as s:
            # 컨테이너 생성 뒤·워커 tick 前에 연결이 만료됨(실사고 재현).
            connection = await s.get(ChannelConnection, connection_id)
            connection.status = "expired"
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s, now=datetime.now(timezone.utc) + timedelta(minutes=10))
            assert counts["completed"] == 0, f"실패해야 하는데 완료로 셈: {counts}"

        async with Session() as s:
            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is None, "발행 실패했는데 published 이벤트가 났다"

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome is not None and gate_d.publish_outcome.startswith("publish_failed:"), (
                f"실패 사유 코드가 publish_outcome에 안 남음: {gate_d.publish_outcome!r}"
            )
            assert gate_d.resolution_note == "ⓓ 발행 승인", "훅이 승인자 본인 resolution_note를 건드렸다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac4d_text_only_draft_still_completes_synchronously_with_completed_command():
    """회귀 음성대조(AC4-d) — 동기 미디어(순수 텍스트, has_async_media=False)는
    기존(#4090)과 동일하게 승인 즉시 published까지 끝난다(plain "sandbox" 채널 —
    instagram_sandbox는 이미지가 필수라 이 대조엔 안 맞는다). #4142가 새로 얹은
    command 생성이 동기 경로에도 적용되므로, 이번엔 그 command가 즉시 completed로
    남는지까지 함께 잰다(예전엔 이 경로에 command 자체가 없었다)."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.routers.events import _find_existing_stage_publish
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4142d")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_text_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        # 순서B(제출 먼저·승인 나중) — 정정(story #4190, PO 판정 2026-09-23): 옛 순서A(승인 먼저)는 ⓓ 승인
        # 화면에 없던 draft라 이제 승계되지 않는다. 이 테스트가 재는 것은 동기 경로의 command 완료라 순서만 바꾼다.
        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "4142d 텍스트 전용"},
            )
            draft_id = uuid.UUID(r_draft.json()["draft_id"])

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            assert r_submit.json()["status"] == "pending"
            scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/gates/{gate_d_id}/transition",
                json={"status": "approved", "note": "ⓓ 발행 승인", "evidence_viewed": True},
            )
            assert r.status_code == 200, r.text

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert publication is not None and publication.status == "published", (
                "동기(이미지 IMAGE 컨테이너) 경로가 회귀됐다 — #4142 이전과 동일하게 즉시 완료돼야"
            )

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert command is not None and command.status == "completed", (
                f"동기 경로도 이제 command가 생겨 즉시 completed로 남아야: {command}"
            )

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome == "published"

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac5e_self_heal_sweep_queues_and_worker_completes_stuck_publication():
    """AC5(페드루 PO CHANGES-1, 2026-09-22) — 클래스 처방. 스크립트/Job을 사람이
    손으로 돌릴 필요 0 — 이미 Cloud Scheduler로 도는 워커 tick 자체가 `container_
    created`+command 0건인 발행물을 스스로 훑어 고친다.

    "stuck" 상태는 `publish_channel_post_draft()`를 직접 호출해(AC1이 고친
    `publish_recipe_approved_draft`를 우회) 재현한다 — 이게 정확히 옛 버그가 만들던
    DB 모양(컨테이너만 있고 command 0건)이고, AC1 수정 後엔 정상 경로로는 더 이상
    이 모양이 안 나오므로(그게 이 스토리의 요점) 직접 재현이 유일한 방법이다.

    1틱: 스윕이 pending command를 큐잉(next_attempt_at=+30s, 이 틱 안에서 곧바로
    처리 안 함) — publication은 여전히 container_created·stage 이벤트 0.
    2틱(+30s 이상 경과): 그 command를 실제로 처리 — published·permalink·stage
    이벤트 정확히 1회."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.routers.events import _find_existing_stage_publish
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select, update

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4142e")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_reels_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

        gate_d_id, scoped_gate_id, draft_id = await _create_and_submit_video_draft(
            Session, app, org_id=org_id, story_id=story_id, creator_id=creator_id,
            owner_member_id=owner_member_id, connection_id=connection_id,
        )

        # 옛 버그 재현 — publish_recipe_approved_draft(AC1 수정) 우회, 스코프 게이트만
        # 직접 approved로 만들고 publish_channel_post_draft를 바로 호출한다.
        async with Session() as s:
            scoped_gate = await s.get(Gate, scoped_gate_id)
            scoped_gate.status = "approved"
            scoped_gate.resolver_id = owner_member_id
            await s.commit()

        async with Session() as s:
            from app.services.channel_posts import publish_channel_post_draft

            pub = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_member_id,
            )
            assert pub.status == "container_created", "옛 버그 재현 자체가 실패(전제 무효)"
            pub_id = pub.id

            no_command_yet = (await s.execute(select(PublicationCommand.id))).first()
            assert no_command_yet is None, "재현 단계에서 이미 command가 있으면 스윕 테스트가 무의미"

            # 5분 임계 통과 — created_at을 과거로 백데이트(옛 버그가 실제로 방치했던
            # 시간 경과를 흉내낸다, server_default=now()를 직접 UPDATE로 덮어씀).
            await s.execute(
                update(ChannelPublication).where(ChannelPublication.id == pub_id)
                .values(created_at=datetime.now(timezone.utc) - timedelta(minutes=10))
            )
            await s.commit()

        base_now = datetime.now(timezone.utc) + timedelta(minutes=20)

        # 1틱 — 스윕이 pending command를 큐잉만(이 틱 안 즉시완료 0).
        async with Session() as s:
            counts = await process_due_publication_commands(s, now=base_now)
            assert counts["completed"] == 0, f"스윕 직후 같은 틱에서 완료되면 안 됨: {counts}"

        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert command is not None, "AC5 self-heal 스윕이 pending command를 안 큐잉했다"
            assert command.status == "pending"
            assert command.next_attempt_at is not None and command.next_attempt_at > base_now

            pub_after_tick1 = await s.get(ChannelPublication, pub_id)
            assert pub_after_tick1.status == "container_created", "1틱 만에 완료되면 30초 폴링 관례 위반"

            no_event_yet = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert no_event_yet is None, "1틱만에 published stage 이벤트가 났다(너무 이르다)"

        # 2틱(+30초 이상 경과) — 이제 그 command가 due 상태라 실제로 완결.
        async with Session() as s:
            counts = await process_due_publication_commands(s, now=base_now + timedelta(seconds=31))
            assert counts["completed"] == 1, f"2틱에서 완료 안 됨: {counts}"

        async with Session() as s:
            pub_final = await s.get(ChannelPublication, pub_id)
            assert pub_final.status == "published"
            assert (pub_final.permalink or "").startswith("https://sandbox.invalid/instagram/")

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is not None, "2틱 완결 뒤에도 레시피 published stage 이벤트가 안 났다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

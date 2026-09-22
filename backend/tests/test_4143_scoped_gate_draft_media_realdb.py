"""story #4143([E-RECIPE-1], 2호 리허설 실측, 페드루 PO 確定 2026-09-22) — 채널 초안의
scoped external_publish 게이트 카드가 초안 실물을 안 보여주던 결함(영상 편입 1건인데
video 요소 0·목적지 instagram_sandbox인데 «호스팅 블로그»로 표시).

원인 그라운딩(디디, origin/develop f22b00a4c):
- BE 쓰기: `channel_posts.py::submit_channel_post_draft`가 `gate.sealed_destination_
  connection_id`를 한 번도 안 채웠다(site_posts.py는 채움) — `_create_evidence` 결이
  아니라 `channel_posts.py` 1481행 부근 봉인 블록의 누락.
- BE 읽기: `gates.py::_enrich_linked_channel_draft`는 unscoped(레시피) 게이트 전용
  가드(scope_key=="")라 scoped 게이트는 이 함수의 나머지 줄에 절대 안 들어간다 —
  scoped 게이트 자신의 미디어를 싣는 자리가 아예 없었다.

처방: ① write-path에 봉인 한 줄 추가(신규 게이트) ② `_enrich_scoped_channel_draft_media`
신설(#4098의 `_build_linked_channel_draft` 직렬화 재사용 — 두 번째 직렬화기 0) — 신규
게이트뿐 아니라 sealed_destination_connection_id가 아직 null인 옛 게이트도 조회 시
draft.connection_id로 파생해 같은 모양으로 답한다(AC1)."""
from __future__ import annotations

import os
import uuid

import pytest

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
def _configure_secrets(monkeypatch):
    import importlib

    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.fixture(autouse=True)
def _configure_media_public_base(monkeypatch):
    """story #4143 — `public_url_for_object_path`는 모듈 로드 시점에 계산된
    `_PUBLIC_BASE`(env `GCS_CHANNEL_MEDIA_BUCKET` 기반)를 쓴다 — 테스트 프로세스엔
    이 env가 안 실려 None인 채 고정된다(모듈 재import해도 이미 앱 전역에서 캐시된
    다른 모듈들이 이 값을 참조하므로 env 재설정만으론 안 먹는다). 값 자체(모듈
    속성)를 직접 patch — video_url/image_urls가 실제로 non-null 나오는지가 이
    카드의 핵심 주장이라 우회할 수 없다."""
    import app.services.channel_post_images as cpi_module
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", "https://storage.googleapis.com/test-bucket/")
    yield


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
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org = Organization(id=uuid.uuid4(), name="Org4143", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uuid.uuid4(), role="owner")
    session.add(owner_member)
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_default_participation_role(session, org_id):
    """submit_channel_post_draft가 `_default_role_id()`(is_default=True인
    ParticipationRole)로 게이트 결재 역할을 정하므로, 이게 없으면 제출 자체가
    ChannelPostApproverRoleMissingError로 422(이 스토리의 관심사 밖 — 이 픽스처가
    없어서 죽지 않게 표준으로 심는다)."""
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC4143"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_sandbox_connection(session, org_id, *, channel="instagram_sandbox", account_id=None, account_label=None):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", account_label=account_label, status="active",
        credential_kind="none", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token"),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _attach_video(session, *, org_id, draft_id, version_id, created_by):
    from app.models.channel_post_video import ChannelPostVideo

    video = ChannelPostVideo(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=version_id,
        original_object_path=f"channel-posts/{draft_id}/video.mp4",
        original_sha256="deadbeef" * 8, original_content_type="video/mp4", original_bytes=12345,
        duration_seconds=30.0, width=1080, height=1920, codec="avc1",
        created_by=created_by,
    )
    session.add(video)
    await session.commit()
    return video


@pytest.mark.anyio
async def test_submit_channel_post_draft_seals_destination_connection_id():
    """AC1 BE ① — 신규 상신은 이제 sealed_destination_connection_id를 채운다(site_posts.py
    선례와 동형 — 라이브 실사고 fef381ca가 null이던 그 자리)."""
    from app.models.gate import Gate
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug="4143a")
            await _seed_default_participation_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)

            version, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="릴스 캡션", link_url=None, author_member_id=creator_id, author_kind="agent",
                image_sha256="deadbeef" * 8,
            )
            gate, _version_id = await submit_channel_post_draft(
                s, org_id=org_id, draft_id=version.draft_id, version_id=None, requester_member_id=creator_id,
                scheduled_at=None,
            )
            gate_id = gate.id

        async with Session() as s:
            fetched = await s.get(Gate, gate_id)
            assert fetched.sealed_destination_connection_id == connection_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_to_gate_response_scoped_gate_includes_video_and_channel_label():
    """AC1 BE ①② + AC2 — 영상이 편입된 초안의 scoped 게이트 응답에 linked_channel_draft.
    video_url이 실리고, sealed_destination_channel이 실 채널 코드(instagram_sandbox)로
    풀린다(«호스팅 블로그» 오추정의 근본 원인이던 그 축 — read-side에서 값 자체를
    검증한다, FE 문구 판별은 별도 vitest)."""
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug="4143b")
            await _seed_default_participation_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)

            version, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="릴스 캡션", link_url=None, author_member_id=creator_id, author_kind="agent",
                image_sha256="deadbeef" * 8,
            )
            gate, _version_id = await submit_channel_post_draft(
                s, org_id=org_id, draft_id=version.draft_id, version_id=None, requester_member_id=creator_id,
                scheduled_at=None,
            )
            await _attach_video(s, org_id=org_id, draft_id=version.draft_id, version_id=version.id, created_by=creator_id)
            gate_id = gate.id

        async with Session() as s:
            fetched = await s.get(Gate, gate_id)
            resp = await to_gate_response(s, org_id, fetched)
            assert resp.linked_channel_draft is not None, "scoped 게이트에 초안 미디어가 안 실렸다"
            assert resp.linked_channel_draft.video_url is not None
            assert resp.linked_channel_draft.video_url.startswith("https://storage.googleapis.com/test-bucket/")
            assert resp.linked_channel_draft.image_urls == []
            assert resp.sealed_destination_connection_id == connection_id
            assert resp.sealed_destination_channel == "instagram_sandbox"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_old_gate_missing_sealed_destination_derives_from_draft_on_read():
    """AC1 BE "기존 게이트(봉인 前 생성분)는 조회 시 초안에서 파생해 같은 모양으로 답한다"
    — sealed_destination_connection_id를 일부러 null로 되돌려(write-path 배포 前 생성분
    흉내) 조회하면, _enrich_scoped_channel_draft_media가 draft.connection_id로 응답
    필드만 보정한다(DB 컬럼 자체는 안 건드림 — 소급 UPDATE 0, 응답 직렬화 시점 파생)."""
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug="4143c")
            await _seed_default_participation_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)

            version, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="라이브 실사고 흉내(옛 게이트)", link_url=None, author_member_id=creator_id, author_kind="agent",
                image_sha256="deadbeef" * 8,
            )
            gate, _version_id = await submit_channel_post_draft(
                s, org_id=org_id, draft_id=version.draft_id, version_id=None, requester_member_id=creator_id,
                scheduled_at=None,
            )
            gate_id = gate.id

        # write-path 배포 前 생성분 흉내 — DB 컬럼을 직접 null로 되돌린다(라이브
        # fef381ca가 실제로 이 상태였다).
        async with Session() as s:
            fetched = await s.get(Gate, gate_id)
            fetched.sealed_destination_connection_id = None
            await s.commit()

        async with Session() as s:
            fetched = await s.get(Gate, gate_id)
            assert fetched.sealed_destination_connection_id is None, "사전조건 자체가 틀렸다"
            resp = await to_gate_response(s, org_id, fetched)
            assert resp.sealed_destination_connection_id == connection_id, "옛 게이트가 조회 시 초안에서 파생되지 않았다"
            assert resp.sealed_destination_channel == "instagram_sandbox"
            assert resp.linked_channel_draft is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_draft_does_not_leak_into_enrichment():
    """AC3 "타 org 403 회귀 0"의 read-side 대응 — Org B의 draft_id가 (오손 데이터 등으로)
    Org A 게이트의 neutral_facts.draft_id에 들어가 있어도, get_channel_post_draft가
    org_id로 스코프하므로 조회 자체가 실패해(None) 응답이 조용히 비어야 한다(Org B
    초안 실물이 Org A 승인자에게 새면 안 된다)."""
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a_id, project_a_id, _owner_a = await _seed_org_with_owner(s, slug="4143d-a")
            org_b_id, project_b_id, _owner_b = await _seed_org_with_owner(s, slug="4143d-b")
            await _seed_default_participation_role(s, org_a_id)
            await _seed_default_participation_role(s, org_b_id)
            creator_a_id = await _seed_agent(s, org_a_id, project_a_id, name="댄A")
            creator_b_id = await _seed_agent(s, org_b_id, project_b_id, name="댄B")
            story_a_id = await _seed_story(s, org_a_id, project_a_id)
            story_b_id = await _seed_story(s, org_b_id, project_b_id)
            connection_a_id = await _seed_sandbox_connection(s, org_a_id)
            connection_b_id = await _seed_sandbox_connection(s, org_b_id)

            version_a, _c, _v = await create_channel_post_draft_version(
                s, org_id=org_a_id, work_item_id=story_a_id, connection_id=connection_a_id,
                text="Org A 초안", link_url=None, author_member_id=creator_a_id, author_kind="agent",
                image_sha256="deadbeef" * 8,
            )
            gate_a, _ = await submit_channel_post_draft(
                s, org_id=org_a_id, draft_id=version_a.draft_id, version_id=None,
                requester_member_id=creator_a_id, scheduled_at=None,
            )
            version_b, _c, _v = await create_channel_post_draft_version(
                s, org_id=org_b_id, work_item_id=story_b_id, connection_id=connection_b_id,
                text="Org B 초안(오손 시나리오 대상)", link_url=None, author_member_id=creator_b_id, author_kind="agent",
                image_sha256="deadbeef" * 8,
            )
            gate_a_id = gate_a.id
            draft_b_id = str(version_b.draft_id)

        # 오손 데이터 흉내 — Org A 게이트의 neutral_facts.draft_id를 Org B의 draft_id로 덮어쓴다.
        async with Session() as s:
            fetched = await s.get(Gate, gate_a_id)
            fetched.neutral_facts = {**(fetched.neutral_facts or {}), "draft_id": draft_b_id}
            await s.commit()

        async with Session() as s:
            fetched = await s.get(Gate, gate_a_id)
            resp = await to_gate_response(s, org_a_id, fetched)
            assert resp.linked_channel_draft is None, "타 org 초안이 새어 실물이 붙었다(IDOR급 사고)"
    finally:
        await engine.dispose()

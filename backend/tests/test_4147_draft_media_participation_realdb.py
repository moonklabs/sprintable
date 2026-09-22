"""story #4147([E-RECIPE-1·Phase 3 폴리시] 채널 초안 영상 업로드 URL 발급·확認이 같은
org의 아무 에이전트 키에 열려 있음, 미르코 #4146 그라운딩 후속 · 페드루 PO 確定
2026-09-22) — 이미지·영상 업로드 URL 발급·확認 4라우트(grep 전수: `/assets/upload-url`·
`/assets/confirm`·`/assets/video/upload-url`·`/assets/video/confirm`) + CHANGES-1
(페드루 PO 確定 2026-09-22, PR #4522 리뷰) `/assets/import-image`(#3666, MCP/플러그인
에이전트 전용 base64 원콜 입구 — "에이전트가 실제로 타는 길") 총 5라우트가 org_id
일치만 봤다(같은 org의 아무 에이전트 키나 남의 초안에 미디어를 편입할 수 있었던 갭).
이 스토리는 draft 참여(origin author 또는 그 work_item에 적용된 레시피의 «넓은
crew») 판정을 추가한다(`channel_posts.py::_require_draft_media_participant`, 판정
로직 자체는 `event_routing_resolver.resolve_broad_crew_member_ids`로 #4132와 공용화
— 새 판정 0).

세팅 헬퍼는 두 기존 파일을 그대로 재사용(새 헬퍼 발명 0): draft 생성·업로드/확認 호출·
로컬 스토리지 픽스처는 `test_620beefc_channel_post_image_upload.py`, agent/RecipeRoleBinding
세팅 모양은 `test_4132_channel_connection_status_realdb.py`(TeamMember 직접 insert)와
동형 — 다만 #4147 판정은 EventDefinition·stage_metadata를 전혀 안 본다(순수
"이 project(+org 전역)에 바인딩된 적 있는 agent_member_id 집합" 질문이라
`resolve_broad_crew_member_ids`가 그 이상을 요구하지 않는다 — #4132류 stage-매칭
세팅은 이 스토리에 불요)."""
from __future__ import annotations

import base64
import os
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _CHANNEL_MEDIA_BUCKET,
    _client_for,
    _create_draft,
    _jpeg_bytes,
    _seed_connection,
    _seed_human as _seed_human_org_member,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
    _upload_and_confirm,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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
def _local_storage(monkeypatch, tmp_path):
    """story 620beefc 원 픽스처와 동형(파일마다 재선언 관례, import로 전파 안 됨) — 양성
    경로 테스트가 그 파일의 `_upload_and_confirm`/`_put_raw_object`를 그대로 빌려 쓰므로
    (새 헬퍼 0), 그 헬퍼들이 참조하는 모듈 상수와 같은 `_CHANNEL_MEDIA_BUCKET`(from
    test_620beefc_channel_post_image_upload)을 그대로 써야 한다 — 이 파일 전용 버킷
    이름을 따로 만들면 PUT은 A 버킷에, confirm의 존재 검증은 B 버킷에 하게 돼 매번
    OBJECT_NOT_FOUND로 깨진다(실측)."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_broad_crew_binding(session, *, org_id, project_id, agent_id, key="org.e4147.recipe"):
    """story #4147 — `resolve_broad_crew_member_ids`는 EventDefinition 존재를 요구하지
    않는다(순수 RecipeRoleBinding.agent_member_id 집합 질문) — stage_metadata·
    payload_schema 세팅 0, #4132류 세팅보다 훨씬 얇다."""
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=key, stage="draft", agent_member_id=agent_id,
    ))
    await session.commit()


# ─── AC2 — 작성자 200 · crew 200 · 비참여 403 · 사람 무변 ────────────────────


@pytest.mark.anyio
async def test_origin_author_agent_gets_200():
    """작성자(초안을 만든 에이전트 본인)는 넓은 crew 바인딩이 0건이어도 통과한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_id = await _seed_agent(s, org_id, project_id, name="author")
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(400, 400), content_type="image/jpeg",
            )
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_broad_crew_agent_gets_200():
    """작성자가 아닌 에이전트도, 이 work_item의 project(+org 전역)에 적용된 레시피의
    넓은 crew(RecipeRoleBinding.agent_member_id)에 속하면 통과한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_id = await _seed_agent(s, org_id, project_id, name="author")
            crew_id = await _seed_agent(s, org_id, project_id, name="crew")
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_broad_crew_binding(s, org_id=org_id, project_id=project_id, agent_id=crew_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=crew_id, agent=True)
        async with _client_for(app) as client:
            r = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(400, 400), content_type="image/jpeg",
            )
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_participant_agent_gets_403():
    """작성자도 아니고 이 project(+org 전역)에 적용된 어느 레시피의 crew도 아닌 같은 org
    에이전트는 403 NOT_DRAFT_PARTICIPANT — 이 스토리가 막는 실측 갭 그 자체."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_id = await _seed_agent(s, org_id, project_id, name="author")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=outsider_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/upload-url",
                json={"content_type": "image/jpeg"},
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "NOT_DRAFT_PARTICIPANT"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_caller_unaffected():
    """사람(org 멤버)은 이 판정 자체가 안 걸린다 — 작성자도 crew도 아닌 사람 멤버가
    기존처럼 200을 받는다(무변 회귀 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_id = await _seed_agent(s, org_id, project_id, name="author")
            human_id = await _seed_human_org_member(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(400, 400), content_type="image/jpeg",
            )
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC1 — 5개 라우트 전수 배선 확認(비참여 403이 upload-url 하나만이 아니라 실제로
# 모든 발급·확認·import 라우트에 걸려 있는지 — "컴포넌트 존재≠배선" 클래스 회귀 방지) ──


def _import_image_body() -> dict:
    """story #4147 CHANGES-1 — import-image는 base64 원콜이라, 게이트가 이 라우트
    내부에서 `validate_image_bytes`(§IMAGE_CORRUPT) *뒤*에 위치한다(image_import
    docstring §3753 순서 그대로) — 다른 3라우트처럼 아무 문자열이나 넣으면 게이트
    도달 前에 다른 코드(400/422)로 먼저 끊겨 이 파라미터라이즈의 전제(모든 갈래가
    NOT_DRAFT_PARTICIPANT로 수렴)가 깨진다. 그래서 이 케이스만 실 JPEG 바이트를 넣는다."""
    return {"content_type": "image/jpeg", "image_base64": base64.b64encode(_jpeg_bytes(400, 400)).decode()}


@pytest.mark.anyio
@pytest.mark.parametrize(
    "path_suffix,json_body_factory",
    [
        ("assets/upload-url", lambda: {"content_type": "image/jpeg"}),
        ("assets/confirm", lambda: {"object_path": "channel-media/does-not-matter.jpg"}),
        ("assets/video/upload-url", lambda: {"content_type": "video/mp4"}),
        ("assets/video/confirm", lambda: {"object_path": "channel-media/does-not-matter.mp4"}),
        ("assets/import-image", _import_image_body),
    ],
)
async def test_non_participant_403_across_all_five_routes(path_suffix, json_body_factory):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_id = await _seed_agent(s, org_id, project_id, name="author")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=outsider_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/{path_suffix}",
                json=json_body_factory(),
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "NOT_DRAFT_PARTICIPANT"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

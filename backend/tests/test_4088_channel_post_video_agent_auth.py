"""story #4088([E-RECIPE-1] 에이전트가 만든 영상을 사람이 승인 카드에서 재생하게) —
BE 권한 그라운딩(디디, 페드루 지시 2026-09-21 "설계·BE 권한 부분은 지금 시작해도
되는") 실측.

발견 — `channel_posts.py`의 영상 upload-url/confirm 두 엔드포인트는 이미
`Depends(get_current_user)`(x-agent-api-key 헤더 수용)+`Depends(get_verified_org_id)`
(에이전트 org 멤버십도 검증, auth.py:628-642 TeamMember 재확인 분기)만 쓴다 — 이미지
엔드포인트(`post_channel_post_image_upload_url`) 자신의 docstring도 "고객 에이전트·
휴먼 공용(초안 제출 엔드포인트와 동형 폭)"이라 명시한다. `confirm_channel_post_video_
upload`(channel_post_videos.py:334) 자체도 `member_kind: str` 파라미터를 받아
`author_kind`에 그대로 싣는 서비스 계층 — human/agent를 판별해 막는 코드가 **이미
어디에도 없다**(신규 BE 권한 코드 0건 가설). 이 테스트는 그 가설을 realdb로 pin한다
— 뮤테이션 킬: `get_current_user` 의존성을 JWT-only로 되돌리면(agent 분기 제거)
이 테스트가 401/403으로 RED."""
from __future__ import annotations

import os
import struct
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _create_draft,
    _put_raw_object,
    _seed_connection,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)
from tests.test_3554_instagram_reels import _build_mp4, _VALID_9_16

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


# story #620beefc 선례 그대로(중복 재발명 금지 — 파일 간 공유 fixture는 pytest가
# import만으로 autouse 승격을 안 해줘 각 파일에 다시 선언해야 한다) ─────────────

# story #620beefc의 `_put_raw_object`를 그대로 재사용하므로(재발명 0) 그 모듈
# 자신의 `_CHANNEL_MEDIA_BUCKET` 값과 반드시 같아야 한다 — 다르면 PUT과 confirm이
# 서로 다른 버킷을 봐 "업로드된 객체를 찾을 수 없습니다"(404)로 샌다(실측 함정).
_CHANNEL_MEDIA_BUCKET = "test-channel-media-620beefc"


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
def _local_channel_media_storage(monkeypatch, tmp_path):
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


def _object_path_for_video(org_id, draft_id, *, content_type: str = "video/mp4") -> str:
    ext = {"video/mp4": "mp4", "video/quicktime": "mov"}.get(content_type, "bin")
    return f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.{ext}"


@pytest.mark.anyio
async def test_agent_api_key_upload_url_not_rejected_for_auth_reasons():
    """AC1 첫 절반 — upload-url 엔드포인트가 agent 클레임 caller를 human과 동일하게
    통과시킨다(신규 코드 0, 기존 get_current_user/get_verified_org_id 그대로).

    200을 못 본다 — `storage/local.py`는 create_only=True(signed PUT) 서명 자체를
    fail-closed로 미발급한다(사람 caller로도 로컬에선 동일하게 503, 620beefc의
    `_upload_and_confirm` docstring이 이미 문서화한 환경 한계·이 스토리와 무관).
    여기서 pin하는 건 그 503이 **인가 실패(401/403)가 아니라는** 사실 하나뿐 —
    사람과 정확히 같은 실패 모드라는 것이 "권한 코드가 human/agent를 안 가른다"는
    이 스토리의 핵심 주장이다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
        # human으로 draft를 만들고(초안 생성 권한은 이 테스트 스코프 밖), agent로 전환해
        # 그 draft에 영상 업로드-url을 요청한다 — 이 스토리가 pin하려는 축은 정확히 이것뿐.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/video/upload-url",
                json={"content_type": "video/mp4"},
            )
        assert r.status_code not in (401, 403), (
            f"agent 클레임이 인가 단계에서 거부됨(status={r.status_code}) — 신규 BE 권한 코드가 필요할 수 있음: {r.text}"
        )
        assert r.status_code == 503, r.text  # local storage 환경 한계, 의도된 값
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_api_key_can_confirm_video_upload_and_is_recorded_as_agent_author():
    """AC1 나머지 절반 — confirm 엔드포인트도 agent 클레임으로 201, 그리고
    `confirm_channel_post_video_upload`에 넘어가는 member_kind가 실제로 'agent'로
    해소돼 새 버전의 author_kind에 그대로 싣는지까지 실측(호출은 됐는데 human으로
    오분류되는 회귀를 별도로 잡는다 — 단순 200/201 카운트로는 못 잡는 클래스)."""
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
        object_path = _object_path_for_video(org_id, draft_id)
        await _put_raw_object(object_path, raw, content_type="video/mp4")
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/video/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 201, r.text
        body = r.json()

        async with Session() as s:
            version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(body["version_id"]))
            )).scalar_one()
        assert version.author_kind == "agent", (
            f"agent 호출인데 author_kind={version.author_kind!r} — member_kind 해소가 human으로 샘"
        )
        assert version.author_member_id == agent_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_from_other_org_gets_403_on_video_confirm():
    """AC4 — 타 org 키 403. agent의 실 소속(claims org_id)은 org B인데 org A의 draft를
    가리키는 URL로 confirm을 호출하면, `post_channel_post_video_confirm`의 첫 줄
    `if org_id != verified_org_id: raise 403`(org_id mismatch)에서 걸린다 — 이 가드는
    caller kind와 무관하게 모든 호출자에 적용되는 1차 경계라, video 엔드포인트에도
    새로 심을 코드가 없다는 이 스토리의 핵심 주장과 같은 증거."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, project_a_id = await _seed_org(s, slug=f"org-a-{uuid.uuid4().hex[:8]}")
            org_b_id, project_b_id = await _seed_org(s, slug=f"org-b-{uuid.uuid4().hex[:8]}")
            human_a_id = await _seed_human(s, org_a_id, project_a_id)
            agent_b_id = await _seed_agent(s, org_b_id, project_b_id)
            connection_a_id = await _seed_connection(s, org_a_id, channel="instagram_sandbox")
            story_a_id = await _seed_story(s, org_a_id, project_a_id)

        _setup_org_scoped_app(app, Session, org_a_id, user_id=human_a_id, agent=False)
        async with _client_for(app) as client:
            draft_a_id = await _create_draft(client, org_id=org_a_id, connection_id=connection_a_id, story_id=story_a_id)

        # agent_b_id의 claims org_id는 org_b_id(자기 소속 그대로) — org_a_id의 draft를
        # URL로 가리킨다(도용 아님, "남의 조직 것을 잘못/악의로 겨냥"의 최소 재현).
        _setup_org_scoped_app(app, Session, org_b_id, user_id=agent_b_id, agent=True)
        object_path = _object_path_for_video(org_a_id, draft_a_id)
        async with _client_for(app) as client:
            r_upload_url = await client.post(
                f"/api/v2/organizations/{org_a_id}/channel-posts/drafts/{draft_a_id}/assets/video/upload-url",
                json={"content_type": "video/mp4"},
            )
            r_confirm = await client.post(
                f"/api/v2/organizations/{org_a_id}/channel-posts/drafts/{draft_a_id}/assets/video/confirm",
                json={"object_path": object_path},
            )
        assert r_upload_url.status_code == 403, r_upload_url.text
        assert r_confirm.status_code == 403, r_confirm.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_video_over_size_limit_rejected_413():
    """AC4 — 한도 초과 413. instagram_sandbox video_max_bytes=100MB(channel_adapters.py)
    보다 1바이트 큰 payload — `confirm_channel_post_video_upload`의 크기 검사가
    `parse_mp4_metadata`(MP4 박스 파싱) *前*이라 유효 MP4가 아니어도 이 갈래를 그대로
    탄다(라인 순서 그대로, 새 픽스처 불요 — 순수 바이트열)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        oversized = b"\x00" * (100 * 1024 * 1024 + 1)
        object_path = _object_path_for_video(org_id, draft_id)
        await _put_raw_object(object_path, oversized, content_type="video/mp4")
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/video/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 413, r.text
        assert r.json()["error"]["code"] == "CHANNEL_VIDEO_TOO_LARGE", r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

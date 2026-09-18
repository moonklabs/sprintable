"""story #3734(결함·high, 선생님 UI 점검 지시 2026-09-09 06:22Z 후속) — 블로그 포스트
(site_post_drafts)·채널 포스트(channel_post_drafts) 초안을 「보관」(soft-delete,
SoftDeleteMixin.deleted_at)하는 원시. 배경: 두 리소스 모두 delete/archive API가 0이고
목록에 행 액션도 0이라 스모크/테스트 표본이 첫 화면을 영영 채우던 결함(선생님 직접 관찰)
— PO 손조작(DB 직접 편집) 없이는 못 치웠다.

핵심 회귀축(뮤테이션 표적):
  ① 목록 기본 필터 — archive된 draft는 `include_deleted`(쿼리 파라미터) 없이는 목록에서
     빠져야 한다(이 가드가 없으면 표본이 여전히 첫 화면을 채운다 — 이 스토리의 존재 이유).
  ② 인가 — origin author 또는 org owner/admin만 보관/보관 해제 가능(그 외 403).
  ③ 발행/승인 기록 무변 — 보관은 소프트 가시성 축일 뿐, Gate·SitePost(발행 projection)·
     ChannelPublication 등 승인·발행 이력에 어떤 영향도 주면 안 된다(#3291 정합 — "삭제가
     아니라 보관"이라는 이 스토리의 핵심 설계 근거를 직접 검증).
  ④ 단건 조회는 보관 여부와 무관하게 항상 200(목록 기본 필터가 특정 URL로 들어온 초안을
     조용히 404 취급하면 안 된다 — withdraw #3614와 동형 관례).
  ⑤ 멱등 — 이미 보관된 draft를 다시 archive해도 200(재클릭 방어).

세팅 헬퍼는 test_3414_publication_command_core.py를 그대로 재사용(중복 재발명 0, 그
파일 자체 docstring이 "세팅 헬퍼·픽스처는 이 파일이 소유"라 명시) — channel 쪽뿐 아니라
site 쪽도 이 파일의 agent=True 인증 지원(api_key_id 클레임)이 필요해(site_posts 자체
테스트 파일들의 _setup_org_scoped_app은 api_key_id를 안 실어 agent 호출자가 resolve_
member의 human(JWT) 분기로 잘못 해소돼 400을 낸다) 여기서 함께 재사용한다."""
from __future__ import annotations

import uuid

import pytest

from tests.test_3414_publication_command_core import (
    _seed_org, _seed_agent, _seed_human, _seed_default_role, _seed_connection, _seed_story,
    _session_factory, _setup_org_scoped_app, _client_for, _draft_body, _approve_gate_directly,
    _create_draft_submit_approve,
)

pytestmark = [pytest.mark.destructive_schema]


@pytest.fixture
def anyio_backend():
    return "asyncio"


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
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _site_draft_body(*, work_item_id, slug="a-post", lang="ko", title="글 제목"):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다.", "tags": [], "body_md": "# 제목\n\n본문입니다.",
    }


async def _create_site_draft(client, *, org_id, work_item_id, slug="a-post"):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/site-posts/drafts",
        json=_site_draft_body(work_item_id=work_item_id, slug=slug),
    )
    assert r.status_code == 201, r.text
    return r.json()["draft_id"]


async def _create_channel_draft(client, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다."):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json=_draft_body(work_item_id=story_id, connection_id=connection_id, text=text),
    )
    assert r.status_code == 201, r.text
    return r.json()["draft_id"]


# ── 사이트 포스트(블로그) ────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_site_origin_author_agent_can_archive_own_draft():
    """①②·정상 경로 — 작성자(에이전트) 본인이 보관 → is_deleted=True, 목록 기본
    조회에서 빠짐, include_deleted=True로는 보임."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_site_draft(client, org_id=org_id, work_item_id=story_id)

            r_archive = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")
            assert r_archive.status_code == 200, r_archive.text
            assert r_archive.json() == {"draft_id": draft_id, "is_deleted": True}

            r_list_default = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            assert r_list_default.status_code == 200, r_list_default.text
            assert draft_id not in [d["draft_id"] for d in r_list_default.json()]

            r_list_all = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", params={"include_deleted": "true"},
            )
            assert r_list_all.status_code == 200, r_list_all.text
            matched = [d for d in r_list_all.json() if d["draft_id"] == draft_id]
            assert len(matched) == 1
            assert matched[0]["is_deleted"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_non_author_non_admin_gets_403():
    """② — 작성자도 admin/owner도 아닌 멤버는 403(SITE_POST_ARCHIVE_FORBIDDEN).
    ⭐뮤테이션 표적 — 이 가드를 지우면 아무나 남의 초안을 보관할 수 있게 된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_agent_id = await _seed_agent(s, org_id, project_id, name="작성자")
            other_agent_id = await _seed_agent(s, org_id, project_id, name="타인")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_site_draft(client, org_id=org_id, work_item_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=other_agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "SITE_POST_ARCHIVE_FORBIDDEN"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_org_admin_can_archive_others_draft_and_restore_reverses_it():
    """②·역방향 — org owner는 원저자가 아니어도 보관 가능. restore가 정확한 역임을 확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            owner_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_site_draft(client, org_id=org_id, work_item_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_archive = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")
            assert r_archive.status_code == 200, r_archive.text
            assert r_archive.json()["is_deleted"] is True

            r_restore = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/restore")
            assert r_restore.status_code == 200, r_restore.text
            assert r_restore.json() == {"draft_id": draft_id, "is_deleted": False}

            r_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            assert draft_id in [d["draft_id"] for d in r_list.json()]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_archive_is_idempotent():
    """⑤ — 이미 보관된 draft를 다시 archive해도 200(재클릭 방어), 상태는 그대로."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_site_draft(client, org_id=org_id, work_item_id=story_id)
            r1 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")
            r2 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json() == r2.json() == {"draft_id": draft_id, "is_deleted": True}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_detail_visible_regardless_of_archived_state():
    """④ — 단건 조회는 보관 前後 항상 200(목록 기본 필터가 URL 직접 접근을 404로
    가리면 안 된다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_site_draft(client, org_id=org_id, work_item_id=story_id)

            r_before = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}")
            assert r_before.status_code == 200 and r_before.json()["is_deleted"] is False

            await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")

            r_after = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}")
            assert r_after.status_code == 200, r_after.text
            assert r_after.json()["is_deleted"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_archive_unknown_draft_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}/archive")
        assert r.status_code == 404, r.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_archiving_published_draft_does_not_touch_publication_record():
    """③ — 핵심 설계 근거 검증. 발행된 draft를 보관해도 SitePost(공개 projection) 행·
    published_at은 완전히 무변 — 삭제가 아니라 목록에서만 빼는 소프트 축이라는 주장을
    실제로 확認한다(#3291 정합)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            owner_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_site_draft(client, org_id=org_id, work_item_id=story_id, slug="pub-post")
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_publish = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish",
            )
            assert r_publish.status_code == 200, r_publish.text
            published_at_before = r_publish.json()["published_at"]
            assert published_at_before is not None

            r_before_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            row_before = next(d for d in r_before_list.json() if d["draft_id"] == draft_id)
            assert row_before["published_at"] == published_at_before

            r_archive = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/archive")
            assert r_archive.status_code == 200, r_archive.text

            r_after_list = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", params={"include_deleted": "true"},
            )
            row_after = next(d for d in r_after_list.json() if d["draft_id"] == draft_id)
            # 보관 前後 발행 필드 완전 무변 — 소프트 축이 발행 이력을 안 건드린다는 증거.
            assert row_after["published_at"] == published_at_before
            assert row_after["gate_status"] == row_before["gate_status"]
    finally:
        await engine.dispose()


# ── 채널 포스트 ──────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_channel_origin_author_agent_can_archive_own_draft():
    """①②·정상 경로 — 사이트와 동형(channel_post_drafts 축)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_channel_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

            r_archive = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/archive")
            assert r_archive.status_code == 200, r_archive.text
            assert r_archive.json() == {"draft_id": draft_id, "is_deleted": True}

            r_list_default = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert draft_id not in [d["draft_id"] for d in r_list_default.json()]

            r_list_all = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts", params={"include_deleted": "true"},
            )
            matched = [d for d in r_list_all.json() if d["draft_id"] == draft_id]
            assert len(matched) == 1 and matched[0]["is_deleted"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_non_author_non_admin_gets_403():
    """② — ⭐뮤테이션 표적. site 쪽과 동형 — 별도 에러코드(CHANNEL_POST_ARCHIVE_FORBIDDEN)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_agent_id = await _seed_agent(s, org_id, project_id, name="작성자")
            other_agent_id = await _seed_agent(s, org_id, project_id, name="타인")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=author_agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_channel_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=other_agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/archive")
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CHANNEL_POST_ARCHIVE_FORBIDDEN"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_archive_independent_of_withdraw_status():
    """③(구조축) — status(draft|withdrawn)와 deleted_at은 독립 축이라는 설계를
    실측한다: withdraw된 draft도 보관 가능하고, 그 반대로 보관은 status를 안 바꾼다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_channel_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            r_withdraw = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
            assert r_withdraw.status_code == 200 and r_withdraw.json()["status"] == "withdrawn"

            r_archive = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/archive")
            assert r_archive.status_code == 200, r_archive.text
            assert r_archive.json()["is_deleted"] is True

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r_detail.status_code == 200, r_detail.text
            body = r_detail.json()
            assert body["draft_status"] == "withdrawn"  # archive가 status를 안 건드림
            assert body["is_deleted"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_archiving_published_draft_does_not_touch_publication_record():
    """③ — 발행된(status='published') 채널 draft를 보관해도 ChannelPublication
    (published_at·permalink)은 완전히 무변. Threads 실제 발행 파이프라인은 이 테스트의
    관심사가 아니라(그건 test_3414의 몫) ChannelPublication 행을 직접 시딩해 "이미
    발행된 상태"를 구성한다 — withdraw(#3614)는 발행되면 409로 막히지만 archive는
    발행 여부와 무관하게 허용된다는 설계 차이도 함께 확認한다."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.channel_post_version import ChannelPostVersion
    from datetime import datetime, timezone
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        published_at = datetime.now(timezone.utc)
        async with Session() as s:
            version_id = (await s.execute(
                select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalar_one()
            s.add(ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
                connection_id=connection_id, channel="threads",
                external_id="ext-1", permalink="https://threads.example/p/1",
                status="published", published_at=published_at,
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_archive = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/archive",
            )
            assert r_archive.status_code == 200, r_archive.text

            r_after = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}",
            )
            assert r_after.status_code == 200, r_after.text
            body = r_after.json()
            assert body["published_at"] == published_at.isoformat()
            assert body["permalink"] == "https://threads.example/p/1"
            assert body["is_deleted"] is True
    finally:
        await engine.dispose()

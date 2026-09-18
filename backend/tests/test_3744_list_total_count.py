"""story #3744(UI 재설계 ①, 미르코 2026-09-09) — 블로그·채널 포스트 목록의 「N개 중
M개 표시 중」 부분 상태 표기용 X-Total-Count. goals.py::list_epics_endpoint의 관례를
그대로 따른다 — service 레이어에 count_site_post_drafts/count_channel_post_drafts를
신설하고, 라우터가 그 값을 응답 헤더에 싣는다(limit/offset과 무관한 전체 개수, 현재
필터(org_id·include_deleted·include_withdrawn) 적용 後).

세팅 헬퍼는 test_3414_publication_command_core.py 재사용(중복 재발명 0 — 그 파일
docstring이 "세팅 헬퍼·픽스처는 이 파일이 소유"라 명시, test_3734_post_archive.py와
동일 관례)."""
from __future__ import annotations

import uuid

import pytest

from tests.test_3414_publication_command_core import (
    _seed_org, _seed_agent, _seed_story, _seed_connection, _seed_default_role,
    _session_factory, _setup_org_scoped_app, _client_for, _draft_body,
)
from tests.test_3386_site_post_publication import _seed_human, _submit_and_approve

pytestmark = [pytest.mark.destructive_schema]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    monkeypatch.setenv("CRON_SECRET", "test-cron-secret")
    monkeypatch.setenv("APP_ENV", "local")
    monkeypatch.setenv("CHANNEL_CREDENTIAL_ENCRYPTION_KEY", Fernet.generate_key().decode())
    import app.core.config as config_module
    importlib.reload(config_module)
    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_site_post_draft(session, *, org_id, work_item_id, slug, deleted_at=None):
    from app.models.site_post_draft import SitePostDraft

    draft = SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, slug=slug, deleted_at=deleted_at)
    session.add(draft)
    await session.commit()
    return draft


# ── count_site_post_drafts (서비스 레이어 직접) ──────────────────────────────

@pytest.mark.anyio
async def test_count_site_post_drafts_matches_created_count():
    from app.services.site_posts import count_site_post_drafts

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story1 = await _seed_story(s, org_id, project_id)
            story2 = await _seed_story(s, org_id, project_id)
            await _seed_site_post_draft(s, org_id=org_id, work_item_id=story1, slug="a")
            await _seed_site_post_draft(s, org_id=org_id, work_item_id=story2, slug="b")

            total = await count_site_post_drafts(s, org_id=org_id)
        assert total == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_count_site_post_drafts_excludes_archived_by_default_includes_with_flag():
    """뮤테이션 표적 — include_deleted 분기를 지우면 이 테스트가 실패해야 한다."""
    from app.services.site_posts import count_site_post_drafts

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story1 = await _seed_story(s, org_id, project_id)
            story2 = await _seed_story(s, org_id, project_id)
            await _seed_site_post_draft(s, org_id=org_id, work_item_id=story1, slug="a")
            import datetime
            await _seed_site_post_draft(
                s, org_id=org_id, work_item_id=story2, slug="b", deleted_at=datetime.datetime.now(datetime.timezone.utc),
            )

            default_total = await count_site_post_drafts(s, org_id=org_id)
            included_total = await count_site_post_drafts(s, org_id=org_id, include_deleted=True)
        assert default_total == 1
        assert included_total == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_count_site_post_drafts_scoped_to_org():
    from app.services.site_posts import count_site_post_drafts

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id_a, project_id_a = await _seed_org(s)
            org_id_b, project_id_b = await _seed_org(s)
            story_a = await _seed_story(s, org_id_a, project_id_a)
            story_b = await _seed_story(s, org_id_b, project_id_b)
            await _seed_site_post_draft(s, org_id=org_id_a, work_item_id=story_a, slug="a")
            await _seed_site_post_draft(s, org_id=org_id_b, work_item_id=story_b, slug="b")

            total_a = await count_site_post_drafts(s, org_id=org_id_a)
        assert total_a == 1
    finally:
        await engine.dispose()


# ── count_channel_post_drafts (서비스 레이어 직접) ───────────────────────────

async def _seed_channel_post_draft_row(session, *, org_id, work_item_id, channel="instagram", deleted_at=None, status="draft"):
    from app.models.channel_post_draft import ChannelPostDraft

    draft = ChannelPostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, channel=channel,
        connection_id=uuid.uuid4(), deleted_at=deleted_at, status=status,
    )
    session.add(draft)
    await session.commit()
    return draft


@pytest.mark.anyio
async def test_count_channel_post_drafts_excludes_archived_and_withdrawn_by_default():
    """뮤테이션 표적 — include_deleted/include_withdrawn 분기를 지우면 실패해야 한다."""
    from app.services.channel_posts import count_channel_post_drafts

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story = await _seed_story(s, org_id, project_id)
            import datetime
            await _seed_channel_post_draft_row(s, org_id=org_id, work_item_id=story)  # 정상 1
            await _seed_channel_post_draft_row(
                s, org_id=org_id, work_item_id=story, deleted_at=datetime.datetime.now(datetime.timezone.utc),
            )  # 보관 1
            await _seed_channel_post_draft_row(s, org_id=org_id, work_item_id=story, status="withdrawn")  # 폐기 1

            default_total = await count_channel_post_drafts(s, org_id=org_id)
            with_deleted = await count_channel_post_drafts(s, org_id=org_id, include_deleted=True)
            with_withdrawn = await count_channel_post_drafts(s, org_id=org_id, include_withdrawn=True)
            with_both = await count_channel_post_drafts(s, org_id=org_id, include_deleted=True, include_withdrawn=True)
        assert default_total == 1
        assert with_deleted == 2
        assert with_withdrawn == 2
        assert with_both == 3
    finally:
        await engine.dispose()


# ── 라우터 — X-Total-Count 헤더 실제 응답 ────────────────────────────────────

@pytest.mark.anyio
async def test_site_posts_list_endpoint_sets_x_total_count_header():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story1 = await _seed_story(s, org_id, project_id)
            story2 = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                r1 = await client.post(
                    f"/api/v2/organizations/{org_id}/site-posts/drafts",
                    json={"work_item_id": str(story1), "lang": "ko", "slug": "a", "title": "글1", "summary": "요약", "body_md": "본문"},
                )
                assert r1.status_code == 201, r1.text
                r2 = await client.post(
                    f"/api/v2/organizations/{org_id}/site-posts/drafts",
                    json={"work_item_id": str(story2), "lang": "ko", "slug": "b", "title": "글2", "summary": "요약", "body_md": "본문"},
                )
                assert r2.status_code == 201, r2.text

                r_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
                assert r_list.status_code == 200, r_list.text
                assert r_list.headers.get("x-total-count") == "2"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_posts_list_endpoint_sets_x_total_count_header():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                r1 = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json=_draft_body(work_item_id=story, connection_id=connection_id),
                )
                assert r1.status_code == 201, r1.text

                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                assert r_list.status_code == 200, r_list.text
                assert r_list.headers.get("x-total-count") == "1"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ── site-posts 목록 public_url(PO 決 2026-09-09, 「발행됨」 행 다음 발 「발행된 글 보기」) ──

@pytest.mark.anyio
async def test_site_posts_list_public_url_set_when_published_and_base_url_configured():
    """test_3386_site_post_publication.py::test_publication_info_all_fields_present_when_published
    과 동일 랜딩 베이스 주입 관례 재사용 — 목록 응답에도 같은 URL 패턴이 실려야 한다."""
    # story #3744(테스트 인프라 결함 자체 발견·수정) — _configure_secrets 픽스처가
    # importlib.reload(app.core.config)를 하는 자리라, 이미 import된 app.services.
    # site_posts 모듈은 reload 전 settings 객체를 계속 들고 있다(모듈 레벨
    # \은 이름을 바인딩할 뿐 재로드를 안 따라간다).
    # test_3386_site_post_publication.py는 이 파일과 달리 reload를 안 해 우연히 안전했다.
    # 실 코드가 읽는 객체(app.services.site_posts.settings)를 직접 패치해야 값이 먹는다.
    import app.services.site_posts as site_posts_module
    from app.main import app

    engine, Session = await _session_factory()
    original_base_url = site_posts_module.settings.public_site_base_url
    site_posts_module.settings.public_site_base_url = "https://sprintable.ai"
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={"work_item_id": str(story_id), "lang": "ko", "slug": "2ho-blog", "title": "2호 글", "summary": "요약", "body_md": "본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
            assert r_pub.status_code == 200, r_pub.text

            async with _client_for(app) as client:
                r_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            assert r_list.status_code == 200, r_list.text
            item = next(d for d in r_list.json() if d["draft_id"] == draft_id)
            assert item["public_url"] == "https://sprintable.ai/ko/blog/2ho-blog"
        finally:
            app.dependency_overrides.clear()
    finally:
        site_posts_module.settings.public_site_base_url = original_base_url
        await engine.dispose()


@pytest.mark.anyio
async def test_site_posts_list_public_url_null_when_not_published():
    """뮤테이션 표적 — post가 없을 때(미발행) public_url을 지어내면 이 테스트가 실패해야
    한다(AC "모른다≠다르다"와 같은 원칙 — 발행 안 된 draft는 갈 곳이 없다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/site-posts/drafts",
                    json={"work_item_id": str(story_id), "lang": "ko", "slug": "a", "title": "글1", "summary": "요약", "body_md": "본문"},
                )
                assert r_draft.status_code == 201, r_draft.text

                r_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            assert r_list.status_code == 200, r_list.text
            assert r_list.json()[0]["public_url"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_posts_list_public_url_null_when_base_url_unconfigured():
    """뮤테이션 표적 — public_site_base_url 미설정(dev 기본 상태)이면 발행됐어도
    public_url이 API 주소 등으로 새면 안 된다(story 194acb63 재발 방지, _resolve_
    public_site_display_url 자체가 이미 처방한 축을 목록에서도 그대로 지킨다)."""
    # story #3744 — 위 test와 동일 이유(_configure_secrets의 reload 때문에 app.core.
    # config.settings가 아니라 app.services.site_posts.settings를 직접 패치해야 실
    # 코드 경로가 그 값을 본다).
    import app.services.site_posts as site_posts_module
    from app.main import app

    engine, Session = await _session_factory()
    original_base_url = site_posts_module.settings.public_site_base_url
    site_posts_module.settings.public_site_base_url = ""
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={"work_item_id": str(story_id), "lang": "ko", "slug": "b", "title": "글2", "summary": "요약", "body_md": "본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
            assert r_pub.status_code == 200, r_pub.text

            async with _client_for(app) as client:
                r_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            assert r_list.status_code == 200, r_list.text
            item = next(d for d in r_list.json() if d["draft_id"] == draft_id)
            assert item["public_url"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        site_posts_module.settings.public_site_base_url = original_base_url
        await engine.dispose()

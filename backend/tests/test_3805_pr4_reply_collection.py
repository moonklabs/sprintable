"""story #3805(Phase3·3-1·PR 4, 페드루 PO 確定 2026-09-11 12:12Z) — 인바운드 중첩
답글 수집. 그라운딩 확定①(문서 실측, 카드 append): Threads(`replied_to`/
`root_post`)·Instagram(`parent_id`)·Facebook(`parent`) 셋 다 Graph API 문서상
부모-댓글 참조 필드가 있다(실 dev 연결 응답 채움 여부는 배포 뒤 PO가 라이브
회차에서 확認 — 이 파일은 문서 계약을 고정할 뿐 실 API 왕복은 안 한다).

`parent_comment_id` 해소는 `collect_comments_for_publication`이 어댑터가 끌어올린
공용 계약 `parent_external_id`(raw item의 top-level 키)를 보고 같은 publication
안에서 external_comment_id로 조회해 채운다 — 부모가 아직 미수집이면 null로 남는다
(유실 아님, raw JSONB에 외부 parent id 보존).

세팅 헬퍼는 test_3516_channel_post_comments.py·test_3805_engagement_items.py와
동형 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication
from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app

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
def _enable_sandbox_adapter(monkeypatch):
    """test_3516_channel_post_comments.py::_enable_sandbox_adapter와 동형(dict 직접
    주입 — SANDBOX_CHANNEL_ENABLED가 모듈 import 시점에 없으면 CHANNEL_ADAPTERS에
    sandbox 자체가 없다)."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
        supports_fetch_replies=True, supports_reply=True, reply_required_scope="sandbox_manage_replies",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


def _fake_comment(comment_id: str, text: str = "댓글", *, parent_external_id: str | None = None) -> dict:
    item = {"id": comment_id, "text": text, "username": "user1", "timestamp": datetime.now(timezone.utc).isoformat()}
    if parent_external_id:
        item["parent_external_id"] = parent_external_id
    return item


# ─── collect_comments_for_publication: parent_comment_id 해소 ─────────────────


@pytest.mark.anyio
async def test_collect_resolves_parent_when_parent_arrives_in_same_batch(monkeypatch):
    """뮤테이션 대상: 배치 후처리 해소 루프를 걷으면(또는 select 조건이 틀리면)
    이 테스트가 실패한다 — 부모·답글이 같은 fetch 응답(같은 페이지)에 같이 온
    가장 흔한 모양."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id, **kwargs):
                return [_fake_comment("c1"), _fake_comment("c2", parent_external_id="c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            rows = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == pub.id)
            )).scalars().all()
            by_external_id = {r.external_comment_id: r for r in rows}
            assert by_external_id["c1"].parent_comment_id is None
            assert by_external_id["c2"].parent_comment_id == by_external_id["c1"].id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_resolves_parent_when_parent_already_collected_earlier(monkeypatch):
    """부모가 이전 수집(다른 due 창)에서 이미 들어와 있던 경우 — 이번 배치 upsert가
    아니라 기존 DB 행을 조회해 해소돼야 한다."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _first_fetch(client, *, access_token, media_id, **kwargs):
                return [_fake_comment("c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _first_fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            async def _second_fetch(client, *, access_token, media_id, **kwargs):
                return [_fake_comment("c1"), _fake_comment("c2", parent_external_id="c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _second_fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            rows = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == pub.id)
            )).scalars().all()
            by_external_id = {r.external_comment_id: r for r in rows}
            assert by_external_id["c2"].parent_comment_id == by_external_id["c1"].id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_leaves_parent_null_when_parent_not_collected(monkeypatch):
    """부모가 아직 어디에도 없으면(유령 parent id) null로 남는다 — «부모 미수집」
    분기가 예외를 던지거나 엉뚱한 값을 채우면 이 테스트가 잡는다. 외부 parent id
    자체는 raw에 남아 유실 0(별도 단언은 raw 컬럼 직접조회 — DB round-trip
    보존만 확認, 직렬화 세부는 조회 안 함)."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id, **kwargs):
                return [_fake_comment("c2", parent_external_id="ghost-never-collected")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            row = (await s.execute(
                select(ChannelPostComment).where(
                    ChannelPostComment.publication_id == pub.id, ChannelPostComment.external_comment_id == "c2",
                )
            )).scalar_one()
            assert row.parent_comment_id is None
            assert row.raw.get("parent_external_id") == "ghost-never-collected"
    finally:
        await engine.dispose()


# ─── kind 필터·응답 판정 ───────────────────────────────────────────────────


async def _seed_comment(session, *, org_id, publication_id, channel, parent_comment_id=None):
    from app.models.channel_post_comment import ChannelPostComment

    c = ChannelPostComment(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_comment_id=f"ext-{uuid.uuid4().hex[:8]}", text="본문",
        text_sha256=uuid.uuid4().hex, captured_at=datetime.now(timezone.utc),
        parent_comment_id=parent_comment_id,
    )
    session.add(c)
    await session.commit()
    return c


@pytest.mark.anyio
async def test_list_response_kind_matches_parent_comment_id():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            top_level = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")
            reply = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads", parent_comment_id=top_level.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items")
        assert r.status_code == 200, r.text
        by_id = {item["id"]: item for item in r.json()["items"]}
        assert by_id[str(top_level.id)]["kind"] == "comment"
        assert by_id[str(reply.id)]["kind"] == "reply"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_kind_filter_narrows_to_comment_or_reply():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            top_level = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")
            await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads", parent_comment_id=top_level.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_comment = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?kind=comment")
            r_reply = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?kind=reply")
        assert r_comment.status_code == 200 and r_reply.status_code == 200
        comment_items = r_comment.json()["items"]
        reply_items = r_reply.json()["items"]
        assert len(comment_items) == 1 and comment_items[0]["kind"] == "comment"
        assert len(reply_items) == 1 and reply_items[0]["kind"] == "reply"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── sandbox 미러 3종: 댓글 2 = 댓글 1의 답글 ──────────────────────────────


@pytest.mark.anyio
async def test_sandbox_threads_mirror_marks_comment_two_as_reply_to_comment_one():
    import app.services.sandbox_publish as sandbox_publish

    items, complete, _total = await sandbox_publish.fetch_replies(
        None, access_token="sandbox", media_id="media-x", published_at=datetime.now(timezone.utc),
    )
    assert complete is True
    assert items[0].get("parent_external_id") is None
    assert items[1]["parent_external_id"] == items[0]["id"]


@pytest.mark.anyio
async def test_sandbox_instagram_mirror_marks_comment_two_as_reply_to_comment_one():
    import app.services.instagram_sandbox_publish as instagram_sandbox_publish

    items, complete, _total = await instagram_sandbox_publish.fetch_replies(
        None, access_token="sandbox", media_id="media-x", published_at=datetime.now(timezone.utc),
    )
    assert complete is True
    assert items[0].get("parent_external_id") is None
    assert items[1]["parent_external_id"] == items[0]["id"]


@pytest.mark.anyio
async def test_sandbox_facebook_mirror_marks_comment_two_as_reply_to_comment_one():
    import app.services.facebook_sandbox_publish as facebook_sandbox_publish

    items, complete, _total = await facebook_sandbox_publish.fetch_replies(
        None, access_token="sandbox", media_id="media-x", published_at=datetime.now(timezone.utc),
    )
    assert complete is True
    assert items[0].get("parent_external_id") is None
    assert items[1]["parent_external_id"] == items[0]["id"]


# ─── 「조용히 0」 처방(PO 追加 確定 2026-09-11 12:29Z): reply_detection_unavailable ─


def _fake_comment_without_parent_field_marker(comment_id: str, text: str = "댓글") -> dict:
    """실 어댑터가 parent 필드 키 자체를 못 받은 상황(권한·API 버전 미지원)을
    흉내 — `parent_field_observed=False`를 명시적으로 싣는다(3종 실 어댑터가
    threads_publish.py 등에서 이렇게 판정해 보내는 값과 동형)."""
    return {
        "id": comment_id, "text": text, "username": "user1",
        "timestamp": datetime.now(timezone.utc).isoformat(), "parent_field_observed": False,
    }


@pytest.mark.anyio
async def test_reply_detection_flagged_unavailable_when_parent_field_key_missing(monkeypatch):
    """뮤테이션 대상: collect_comments_for_publication이 ChannelConnection 갱신을
    걷으면(또는 조건을 뒤집으면) 이 테스트가 실패한다."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id, **kwargs):
                return [_fake_comment_without_parent_field_marker("c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            # story #3805 PR 4 후속 — 갱신은 ORM 유닛오브워크가 아니라 Core
            # `update(ChannelConnection)`로 실행돼(같은 행을 이 세션이 이미 upsert
            # 로 만들며 identity map에 올려둔 경우도 있어) `session.get()`이 캐시된
            # 옛 값을 돌려줄 수 있다 — `refresh()`로 DB에서 다시 읽는다.
            await s.refresh(conn)
            assert conn.reply_detection_unavailable_at is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reply_detection_self_heals_when_parent_field_observed_again(monkeypatch):
    """다음 수집에서 필드가 다시 보이면 null로 되돌아간다(영구 낙인 방지)."""
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch_missing(client, *, access_token, media_id, **kwargs):
                return [_fake_comment_without_parent_field_marker("c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch_missing)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()
            await s.refresh(conn)
            assert conn.reply_detection_unavailable_at is not None

            async def _fetch_observed(client, *, access_token, media_id, **kwargs):
                return [_fake_comment("c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch_observed)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()
            await s.refresh(conn)
            assert conn.reply_detection_unavailable_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collection_status_exposes_reply_detection_unavailable(monkeypatch):
    from app.main import app
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id, **kwargs):
                return [_fake_comment_without_parent_field_marker("c1")], True, None

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/collection-status")
        assert r.status_code == 200, r.text
        by_connection = {c["connection_id"]: c for c in r.json()["connections"]}
        assert by_connection[str(conn.id)]["reply_detection_unavailable"] is True
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

"""story #3320(Phase2·마케팅운영, 페드루 PO 決定 2026-09-06) — Instagram Graph API
커넥터 조각③(인사이트+댓글). 조각①(연결+sandbox 발행)이 이미 만든 dict 기반
dispatch(`get_publish_client_module`)에 그대로 얹는다 — 신규 dispatch 로직은
`insight_snapshots.py::_fetch_for_snapshot`/`channel_post_comments.py::
_fetch_replies_raw`의 instagram/instagram_sandbox 분기 2곳뿐, 그 외 오케스트
레이션(`channel_posts.py`·`publication_command.py::reply` 호출부)은 무변경.

세팅 헬퍼는 test_3497_insight_snapshots.py·test_3516_channel_post_comments.py와
동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication

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
def _enable_instagram_sandbox_adapter(monkeypatch):
    """instagram_sandbox는 SANDBOX_CHANNEL_ENABLED env가 모듈 import 시점에 없으면
    CHANNEL_ADAPTERS에 아예 없다 — test_3320_instagram_connector.py의 dict 직접
    주입 선례와 동형(중복 재발명 금지), 조각③ capability(supports_fetch_replies/
    reply=True) 포함."""
    import app.services.channel_adapters as adapters_mod

    ig_sandbox_cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual", credential_kind="none", display_name="Instagram Sandbox",
        max_text_length=2200, utm_source="instagram_sandbox", utm_medium="test",
        image_formats=("image/jpeg",), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91, image_aspect_min=0.8,
        image_width_min=320, image_width_max=1440, image_color_space="sRGB", image_max_count=1,
        supports_fetch_replies=True, supports_reply=True, reply_required_scope="sandbox_manage_replies",
        insight_metrics=("views", "reach", "engagements"),
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "instagram_sandbox", ig_sandbox_cfg)
    yield


def _patch_transport(monkeypatch, handler) -> None:
    """test_3497_insight_snapshots.py::_patch_threads_transport와 동형."""
    import httpx

    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    class _PatchedAsyncClient(real_async_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _PatchedAsyncClient)


# ─── ChannelAdapterConfig: 조각③에서 켠 capability 선언 ──────────────────────


def test_instagram_adapter_declares_fetch_replies_reply_and_insight_metrics():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    ig = CHANNEL_ADAPTERS["instagram"]
    assert ig.supports_fetch_replies is True
    assert ig.supports_reply is True
    assert ig.reply_required_scope == "instagram_business_manage_comments"
    assert ig.insight_metrics == ("views", "reach", "engagements")


# ─── instagram_publish.py::fetch_replies ─────────────────────────────────────


@pytest.mark.anyio
async def test_instagram_fetch_replies_normalizes_from_username_to_top_level():
    """channel_post_comments.py::collect_comments_for_publication이 raw.get("username")
    을 top-level에서 읽는다(sandbox/threads raw 모양과 동일 계약) — IG 실 응답은
    `from.username`에 있어 fetch_replies가 이걸 끌어올려야 한다."""
    from app.services.instagram_publish import fetch_replies

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {
                "data": [
                    {"id": "c1", "text": "댓글1", "timestamp": "2026-09-06T00:00:00+0000",
                     "from": {"id": "u1", "username": "sprintable_demo"}},
                ],
                "paging": {},
            }

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    items, complete = await fetch_replies(_FakeClient(), access_token="tok", media_id="media-1")
    assert complete is True
    assert items[0]["username"] == "sprintable_demo"
    assert items[0]["from_id"] == "u1"
    assert items[0]["from"] == {"id": "u1", "username": "sprintable_demo"}  # 원본 보존.


@pytest.mark.anyio
async def test_instagram_fetch_replies_follows_cursor_until_exhausted():
    from app.services.instagram_publish import fetch_replies

    pages = [
        {"data": [{"id": "c1", "from": {"username": "u1"}}], "paging": {"cursors": {"after": "cursor2"}}},
        {"data": [{"id": "c2", "from": {"username": "u2"}}], "paging": {}},
    ]
    call_count = {"n": 0}

    class _FakeResponse:
        def __init__(self, body):
            self.status_code = 200
            self._body = body
        def json(self):
            return self._body

    class _FakeClient:
        async def get(self, url, *, params):
            resp = _FakeResponse(pages[call_count["n"]])
            call_count["n"] += 1
            return resp

    items, complete = await fetch_replies(_FakeClient(), access_token="tok", media_id="media-1")
    assert [i["id"] for i in items] == ["c1", "c2"]
    assert complete is True
    assert call_count["n"] == 2


@pytest.mark.anyio
async def test_instagram_fetch_replies_uses_graph_instagram_com_host():
    """페드루 PO REQUIRED(2026-09-06, #3872 PASS 철회) — comments 엔드포인트도
    graph.instagram.com이어야 한다(instagram_publish.py::_GRAPH_BASE와 동일
    호스트로 통일). 호스트를 facebook.com으로 되돌리면 RED."""
    from app.services.instagram_publish import fetch_replies

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"data": [], "paging": {}}

    class _FakeClient:
        async def get(self, url, *, params):
            captured["url"] = url
            return _FakeResponse()

    await fetch_replies(_FakeClient(), access_token="tok", media_id="media-1")
    assert captured["url"].startswith("https://graph.instagram.com/")
    assert "facebook.com" not in captured["url"]


@pytest.mark.anyio
async def test_instagram_reply_uses_graph_instagram_com_host():
    """페드루 PO REQUIRED(2026-09-06, #3872 PASS 철회) — comment replies
    엔드포인트도 graph.instagram.com이어야 한다."""
    from app.services.instagram_publish import reply

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"id": "reply-1"}

    class _FakeClient:
        async def post(self, url, *, params):
            captured["url"] = url
            return _FakeResponse()

    await reply(_FakeClient(), access_token="tok", threads_user_id="ig-1", reply_to_id="c1", text="x")
    assert captured["url"].startswith("https://graph.instagram.com/")
    assert "facebook.com" not in captured["url"]


@pytest.mark.anyio
async def test_instagram_fetch_replies_failure_raises_threads_publish_error():
    from app.services.instagram_publish import fetch_replies
    from app.services.threads_publish import ThreadsPublishError

    class _FakeResponse:
        status_code = 400
        text = "bad request"

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    with pytest.raises(ThreadsPublishError) as exc_info:
        await fetch_replies(_FakeClient(), access_token="tok", media_id="media-1")
    assert exc_info.value.code == "INSTAGRAM_FETCH_REPLIES_FAILED"


# ─── instagram_publish.py::reply ──────────────────────────────────────────────


@pytest.mark.anyio
async def test_instagram_reply_posts_to_comment_replies_endpoint():
    from app.services.instagram_publish import reply

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"id": "reply-1"}

    class _FakeClient:
        async def post(self, url, *, params):
            captured["url"], captured["params"] = url, params
            return _FakeResponse()

    external_reply_id, permalink = await reply(
        _FakeClient(), access_token="tok", threads_user_id="ig-1", reply_to_id="c1", text="답변합니다",
    )
    assert external_reply_id == "reply-1"
    assert permalink is None  # IG 댓글엔 permalink 개념이 없음.
    assert captured["url"].endswith("/c1/replies")
    assert captured["params"]["message"] == "답변합니다"


@pytest.mark.anyio
async def test_instagram_reply_failure_raises():
    from app.services.instagram_publish import reply
    from app.services.threads_publish import ThreadsPublishError

    class _FakeResponse:
        status_code = 403
        text = "forbidden"

    class _FakeClient:
        async def post(self, url, *, params):
            return _FakeResponse()

    with pytest.raises(ThreadsPublishError) as exc_info:
        await reply(_FakeClient(), access_token="tok", threads_user_id="ig-1", reply_to_id="c1", text="x")
    assert exc_info.value.code == "INSTAGRAM_REPLY_FAILED"


# ─── instagram_sandbox_publish.py: 결정적 댓글+답변 ──────────────────────────


@pytest.mark.anyio
async def test_instagram_sandbox_fetch_replies_deterministic_two_comments():
    from app.services.instagram_sandbox_publish import fetch_replies

    items, complete = await fetch_replies(None, access_token="x", media_id="media-1")
    assert complete is True
    assert [i["id"] for i in items] == [
        "sandbox-ig-comment-media-1-1", "sandbox-ig-comment-media-1-2",
    ]

    items2, _ = await fetch_replies(None, access_token="x", media_id="media-1")
    assert items == items2, "결정적이어야 함(같은 media_id는 매번 같은 값)"


@pytest.mark.anyio
async def test_instagram_sandbox_reply_returns_id_without_permalink():
    from app.services.instagram_sandbox_publish import reply

    external_reply_id, permalink = await reply(
        None, access_token="x", threads_user_id="ig-1", reply_to_id="c1", text="답변",
    )
    assert external_reply_id.startswith("sandbox-ig-reply-")
    assert permalink is None


# ─── channel_post_comments.py::_fetch_replies_raw dispatch(instagram/instagram_sandbox) ─


@pytest.mark.anyio
async def test_collect_comments_for_publication_dispatches_instagram(monkeypatch):
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.instagram_publish as instagram_publish
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="instagram", external_id="ig-media-1",
            )

            async def _fake_fetch(client, *, access_token, media_id):
                return [{"id": "c1", "text": "댓글", "username": "u1", "timestamp": datetime.now(timezone.utc).isoformat()}], True

            monkeypatch.setattr(instagram_publish, "fetch_replies", _fake_fetch)
            await collect_comments_for_publication(
                s, org_id=org_id, publication_id=pub.id, channel="instagram", external_id="ig-media-1",
            )
            await s.commit()

            rows = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].external_comment_id == "c1"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_comments_for_publication_dispatches_instagram_sandbox():
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)

            await collect_comments_for_publication(
                s, org_id=org_id, publication_id=uuid.uuid4(), channel="instagram_sandbox",
                external_id="ig-sandbox-media-1",
            )
            await s.commit()

            rows = (await s.execute(select(ChannelPostComment))).scalars().all()
            assert len(rows) == 2, "sandbox는 결정적 2건을 upsert해야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_comments_instagram_token_expired_maps_to_channel_token_expired(monkeypatch):
    from app.services.channel_post_comments import CommentFetchError, collect_comments_for_publication
    import app.services.instagram_publish as instagram_publish
    from app.services.threads_publish import ThreadsPublishError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="instagram", external_id="ig-media-1",
            )

            async def _fake_fetch_401(client, *, access_token, media_id):
                raise ThreadsPublishError("INSTAGRAM_FETCH_REPLIES_FAILED", "expired", status_code=401)

            monkeypatch.setattr(instagram_publish, "fetch_replies", _fake_fetch_401)
            with pytest.raises(CommentFetchError) as exc_info:
                await collect_comments_for_publication(
                    s, org_id=org_id, publication_id=pub.id, channel="instagram", external_id="ig-media-1",
                )
            assert exc_info.value.error_code == "CHANNEL_TOKEN_EXPIRED"
    finally:
        await engine.dispose()


# ─── insight_snapshots.py::_fetch_instagram(MockTransport) ───────────────────


@pytest.mark.anyio
async def test_instagram_insights_200_maps_likes_comments_saved_shares_to_engagements(monkeypatch):
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="instagram")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="instagram", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": [
                {"name": "views", "values": [{"value": 500}]},
                {"name": "reach", "values": [{"value": 300}]},
                {"name": "likes", "values": [{"value": 10}]},
                {"name": "comments", "values": [{"value": 2}]},
                {"name": "saved", "values": [{"value": 1}]},
                {"name": "shares", "values": [{"value": 4}]},
            ]}))
            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.normalized["views"] == 500
            assert snap.normalized["reach"] == 300
            assert snap.normalized["engagements"] == 17  # 10+2+1+4
            # 페드루 PO REQUIRED(2026-09-06, #3874 리뷰) — impressions는 2024-07-02
            # 이후 미디어에 폐기돼 선언 자체를 안 한다(insight_metrics에 없음) —
            # "쟀는데 0"이 아니라 "이 채널이 이 지표를 안 준다"(null≠0 원칙).
            assert snap.normalized["impressions"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_instagram_insights_metric_param_excludes_impressions_includes_views():
    """페드루 PO REQUIRED(2026-09-06, #3874 리뷰) — impressions가 2024-07-02
    이후 미디어에 폐기돼 요청 파라미터에 들어가면 실계정 첫 호출이 400난다
    (#3872의 graph.facebook.com 호스트 오류와 같은 클래스: sandbox는 이
    파라미터를 실제로 안 쳐서 통과하고 실계정에서만 드러남). 되돌리면(mutation)
    이 테스트가 RED."""
    from app.services.insight_snapshots import _INSTAGRAM_INSIGHTS_METRICS

    requested = _INSTAGRAM_INSIGHTS_METRICS.split(",")
    assert "impressions" not in requested
    assert "views" in requested


@pytest.mark.anyio
async def test_instagram_insights_uses_graph_instagram_com_host(monkeypatch):
    """페드루 PO REQUIRED(2026-09-06, #3872 PASS 철회) — insights 엔드포인트도
    graph.instagram.com이어야 한다. 호스트를 facebook.com으로 되돌리면 RED
    (real HTTP 왕복 없이 MockTransport의 request.url로 실제 나간 호스트를 본다)."""
    import httpx

    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="instagram")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="instagram", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            captured = {}

            def _handler(request):
                captured["url"] = str(request.url)
                return httpx.Response(200, json={"data": []})

            _patch_transport(monkeypatch, _handler)
            await process_due_insight_snapshots(s)

            assert captured["url"].startswith("https://graph.instagram.com/"), captured["url"]
            assert "facebook.com" not in captured["url"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_instagram_insights_401_promotes_connection(monkeypatch):
    import httpx

    from app.models.channel_connection import ChannelConnection
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="instagram")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="instagram", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_transport(monkeypatch, lambda request: httpx.Response(401, json={"error": {"message": "expired"}}))
            counts = await process_due_insight_snapshots(s)
            assert counts["failed"] == 2, counts

            refreshed = await s.get(ChannelConnection, connection.id)
            assert refreshed.status == "expired"
    finally:
        await engine.dispose()

"""story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06) — Facebook Page 채널 동형 완성:
댓글 조회·새로고침·승인 답변(Threads/Instagram 동형) + 인사이트 1일·7일 스냅샷
(insight_metrics 선언) + facebook_sandbox 미러. 그라운딩④의 본체 — `channel_post_
comments.py::_fetch_replies_raw`의 채널별 if/elif(threads/instagram이 연결 조회·
토큰 복호화·에러 매핑을 그대로 중복 구현하던 것)를 해체하고 `publication_command.py
:577`의 답변 발송 duck-typing과 같은 형으로 통일한 뒤, facebook은 그 위에 `fetch_
replies`/`reply`만 얹는다.

세팅 헬퍼는 test_3497_insight_snapshots.py·test_e4fc29fa_site_post_orchestration.py
재사용(중복 재발명 금지) — test_3320_instagram_piece3.py와 동형 관례."""
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


# ─── ChannelAdapterConfig: 댓글/인사이트 선언 ────────────────────────────────


def test_facebook_adapter_declares_fetch_replies_reply_and_insight_metrics():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    fb = CHANNEL_ADAPTERS["facebook"]
    assert fb.supports_fetch_replies is True
    assert fb.supports_reply is True
    assert fb.reply_required_scope == "pages_manage_engagement"
    assert fb.insight_metrics == ("impressions", "reach", "engagements", "clicks", "views")
    assert "pages_manage_engagement" in fb.scope


def test_facebook_sandbox_adapter_declares_same_capabilities_as_facebook():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    fb, fb_sandbox = CHANNEL_ADAPTERS["facebook"], CHANNEL_ADAPTERS["facebook_sandbox"]
    assert fb_sandbox.supports_fetch_replies is True
    assert fb_sandbox.supports_reply is True
    assert fb_sandbox.insight_metrics == fb.insight_metrics


# ─── facebook_publish.py::fetch_replies ──────────────────────────────────────


@pytest.mark.anyio
async def test_facebook_fetch_replies_normalizes_message_from_created_time_to_top_level():
    """channel_post_comments.py::collect_comments_for_publication이 raw.get("text")/
    raw.get("username")/raw.get("timestamp")를 top-level에서 읽는 계약(sandbox/threads
    raw 모양과 동일) — Facebook Page 댓글 원시 응답은 message/from.name/created_time
    이라 fetch_replies가 이걸 끌어올려야 한다."""
    from app.services.facebook_publish import fetch_replies

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {
                "data": [
                    {"id": "c1", "message": "댓글1", "created_time": "2026-09-06T00:00:00+0000",
                     "from": {"id": "u1", "name": "스프린터블 데모"}},
                ],
                "paging": {},
            }

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    items, complete = await fetch_replies(_FakeClient(), access_token="tok", media_id="post-1")
    assert complete is True
    assert items[0]["text"] == "댓글1"
    assert items[0]["username"] == "스프린터블 데모"
    assert items[0]["from_id"] == "u1"
    assert items[0]["timestamp"] == "2026-09-06T00:00:00+0000"
    assert items[0]["from"] == {"id": "u1", "name": "스프린터블 데모"}  # 원본 보존.
    assert items[0]["message"] == "댓글1"  # 원본 필드도 유실 없음.


@pytest.mark.anyio
async def test_facebook_fetch_replies_follows_cursor_until_exhausted():
    from app.services.facebook_publish import fetch_replies

    pages = [
        {"data": [{"id": "c1", "message": "a", "from": {"name": "u1"}}], "paging": {"cursors": {"after": "cursor2"}}},
        {"data": [{"id": "c2", "message": "b", "from": {"name": "u2"}}], "paging": {}},
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

    items, complete = await fetch_replies(_FakeClient(), access_token="tok", media_id="post-1")
    assert [i["id"] for i in items] == ["c1", "c2"]
    assert complete is True
    assert call_count["n"] == 2


@pytest.mark.anyio
async def test_facebook_fetch_replies_failure_raises_threads_publish_error():
    from app.services.facebook_publish import fetch_replies
    from app.services.threads_publish import ThreadsPublishError

    class _FakeResponse:
        status_code = 400
        text = "bad request"

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    with pytest.raises(ThreadsPublishError) as exc_info:
        await fetch_replies(_FakeClient(), access_token="tok", media_id="post-1")
    assert exc_info.value.code == "FACEBOOK_FETCH_REPLIES_FAILED"


# ─── facebook_publish.py::reply ──────────────────────────────────────────────


@pytest.mark.anyio
async def test_facebook_reply_posts_to_comment_comments_endpoint_not_replies():
    """PO 確定 — Facebook은 Instagram의 전용 /replies와 달리 같은 /comments
    엔드포인트가 대상이 post든 댓글이든 그 밑에 새 댓글을 단다."""
    from app.services.facebook_publish import reply

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
        _FakeClient(), access_token="tok", threads_user_id="page-1", reply_to_id="c1", text="답변합니다",
    )
    assert external_reply_id == "reply-1"
    assert permalink is None  # FB 댓글엔 permalink 개념이 없음.
    assert captured["url"].endswith("/c1/comments")
    assert not captured["url"].endswith("/c1/replies")
    assert captured["params"]["message"] == "답변합니다"


@pytest.mark.anyio
async def test_facebook_reply_failure_raises():
    from app.services.facebook_publish import reply
    from app.services.threads_publish import ThreadsPublishError

    class _FakeResponse:
        status_code = 403
        text = "forbidden"

    class _FakeClient:
        async def post(self, url, *, params):
            return _FakeResponse()

    with pytest.raises(ThreadsPublishError) as exc_info:
        await reply(_FakeClient(), access_token="tok", threads_user_id="page-1", reply_to_id="c1", text="x")
    assert exc_info.value.code == "FACEBOOK_REPLY_FAILED"


# ─── facebook_sandbox_publish.py: 결정적 댓글+답변 ───────────────────────────


@pytest.mark.anyio
async def test_facebook_sandbox_fetch_replies_deterministic_two_comments():
    from app.services.facebook_sandbox_publish import fetch_replies

    items, complete = await fetch_replies(None, access_token="x", media_id="post-1")
    assert complete is True
    assert [i["id"] for i in items] == ["sandbox-fb-comment-post-1-1", "sandbox-fb-comment-post-1-2"]

    items2, _ = await fetch_replies(None, access_token="x", media_id="post-1")
    assert items == items2, "결정적이어야 함(같은 media_id는 매번 같은 값)"


@pytest.mark.anyio
async def test_facebook_sandbox_reply_returns_id_without_permalink():
    from app.services.facebook_sandbox_publish import reply

    external_reply_id, permalink = await reply(
        None, access_token="x", threads_user_id="page-1", reply_to_id="c1", text="답변",
    )
    assert external_reply_id.startswith("sandbox-fb-reply-")
    assert permalink is None


# ─── channel_post_comments.py::_fetch_replies_raw dispatch(facebook/facebook_sandbox) ─


@pytest.mark.anyio
async def test_collect_comments_for_publication_dispatches_facebook(monkeypatch):
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.facebook_publish as facebook_publish
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="fb-post-1",
            )

            async def _fake_fetch(client, *, access_token, media_id):
                return [{"id": "c1", "text": "댓글", "username": "u1", "timestamp": datetime.now(timezone.utc).isoformat()}], True

            monkeypatch.setattr(facebook_publish, "fetch_replies", _fake_fetch)
            await collect_comments_for_publication(
                s, org_id=org_id, publication_id=pub.id, channel="facebook", external_id="fb-post-1",
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
async def test_collect_comments_for_publication_dispatches_facebook_sandbox():
    """facebook_sandbox는 instagram_sandbox/sandbox와 달리 credential_kind="oauth"
    (channel_adapters.py::facebook_sandbox 주석 — 페이지 수 마커를 진짜 authorize→
    callback 라우터로 나른다)라, 이 dispatch는 여전히 실 ChannelConnection/
    ChannelPublication 조회 경로(공용 블록)를 탄다 — facebook_sandbox_publish.py
    ::fetch_replies 자체가 결정적 값을 낼 뿐, "연결 불요" 축은 sandbox/
    instagram_sandbox 전용이다."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id="fb-sandbox-post-1",
            )

            await collect_comments_for_publication(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="fb-sandbox-post-1",
            )
            await s.commit()

            rows = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 2, "sandbox는 결정적 2건을 upsert해야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_comments_facebook_token_expired_maps_to_channel_token_expired(monkeypatch):
    from app.services.channel_post_comments import CommentFetchError, collect_comments_for_publication
    import app.services.facebook_publish as facebook_publish
    from app.services.threads_publish import ThreadsPublishError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="fb-post-1",
            )

            async def _fake_fetch_401(client, *, access_token, media_id):
                raise ThreadsPublishError("FACEBOOK_FETCH_REPLIES_FAILED", "expired", status_code=401)

            monkeypatch.setattr(facebook_publish, "fetch_replies", _fake_fetch_401)
            with pytest.raises(CommentFetchError) as exc_info:
                await collect_comments_for_publication(
                    s, org_id=org_id, publication_id=pub.id, channel="facebook", external_id="fb-post-1",
                )
            assert exc_info.value.error_code == "CHANNEL_TOKEN_EXPIRED"
    finally:
        await engine.dispose()


# ─── insight_snapshots.py::_fetch_facebook(MockTransport) ────────────────────


@pytest.mark.anyio
async def test_facebook_insights_maps_5_keys_spend_conversions_stay_none(monkeypatch):
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="facebook")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="facebook")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="facebook", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            # 영상 게시물 표본 — post_video_views가 응답에 실제로 온다(views 채워짐).
            _patch_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": [
                {"name": "post_impressions", "values": [{"value": 1000}]},
                {"name": "post_impressions_unique", "values": [{"value": 700}]},
                {"name": "post_engaged_users", "values": [{"value": 50}]},
                {"name": "post_clicks", "values": [{"value": 20}]},
                {"name": "post_video_views", "values": [{"value": 300}]},
            ]}))
            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.normalized["impressions"] == 1000
            assert snap.normalized["reach"] == 700
            assert snap.normalized["engagements"] == 50
            assert snap.normalized["clicks"] == 20
            assert snap.normalized["views"] == 300
            # 광고 축(Phase 3) — 대응 후보 자체가 없어 요청도 안 함, 항상 미제공.
            assert snap.normalized["spend"] is None
            assert snap.normalized["conversions"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_insights_non_video_post_views_stays_none_not_zero():
    """비영상(텍스트/이미지) 게시물은 post_video_views가 응답에 아예 안 실린다 —
    0으로 지어내지 않고 null="미제공"이어야 한다(이 스토리의 척추, _normalize의
    "선언은 했지만 이번 fetch가 값을 못 줌" 경로)."""
    from app.services.insight_snapshots import _fetch_facebook

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"data": [
                {"name": "post_impressions", "values": [{"value": 100}]},
                {"name": "post_impressions_unique", "values": [{"value": 80}]},
                {"name": "post_engaged_users", "values": [{"value": 5}]},
                {"name": "post_clicks", "values": [{"value": 1}]},
                # post_video_views 없음(비영상 게시물).
            ]}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    result = await _fetch_facebook(_FakeClient(), access_token="tok", media_id="post-1")
    assert "views" not in result["values"], "응답에 없으면 values에도 없어야 _normalize가 null로 채운다"


@pytest.mark.anyio
async def test_facebook_insights_metric_name_present_but_values_empty_list_stays_absent_not_zero():
    """페드루 PO 리뷰(2026-09-06) — name은 응답에 왔지만 그 values가 빈 목록인
    경우(예: 그 회차에 실제로 안 잡힘)도 0으로 지어내면 안 된다 — "값이 실제로
    있을 때만 싣는다" 원칙은 name 유무가 아니라 values 유무로 판정한다."""
    from app.services.insight_snapshots import _fetch_facebook

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"data": [
                {"name": "post_impressions", "values": [{"value": 100}]},
                {"name": "post_clicks", "values": []},  # name은 있지만 값이 빈 목록.
            ]}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    result = await _fetch_facebook(_FakeClient(), access_token="tok", media_id="post-1")
    assert "clicks" not in result["values"], "values가 빈 목록이면 0을 지어내지 않고 키 자체가 없어야 한다"
    assert result["values"]["impressions"] == 100


@pytest.mark.anyio
async def test_facebook_insights_metric_param_excludes_spend_and_conversions():
    from app.services.insight_snapshots import _FACEBOOK_INSIGHTS_METRICS

    requested = _FACEBOOK_INSIGHTS_METRICS.split(",")
    assert "spend" not in requested
    assert "conversions" not in requested
    assert "post_video_views" in requested  # 조건부(영상만)라도 요청 목록엔 포함.


@pytest.mark.anyio
async def test_facebook_insights_token_expired_maps_correctly(monkeypatch):
    import httpx

    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from app.models.insight_snapshot import InsightSnapshot
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="facebook")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="facebook")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="facebook", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_transport(monkeypatch, lambda request: httpx.Response(401, text="expired"))
            await process_due_insight_snapshots(s)

            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.status == "failed"
            assert snap.error_code == "CHANNEL_TOKEN_EXPIRED"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_sandbox_insights_dispatch_reuses_sandbox_decisive_values_filtered_to_5_keys():
    """PO 確定③ — facebook_sandbox는 _fetch_sandbox()의 기존 결정값을 재사용하되,
    facebook_sandbox의 insight_metrics(5키, facebook과 동형) 밖인 spend/conversions
    는 sandbox 원시값에 있어도 null이어야 한다(어댑터 선언이 안전망 역할)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="facebook_sandbox")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=connection.id, channel="facebook_sandbox", external_id="fb-sandbox-post-1",
            )
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="facebook_sandbox", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)
            assert counts["captured"] == 2, counts

            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.normalized["impressions"] is not None
            assert snap.normalized["reach"] is not None
            assert snap.normalized["engagements"] is not None
            assert snap.normalized["clicks"] is not None
            assert snap.normalized["views"] is not None
            assert snap.normalized["spend"] is None, "선언 밖 키는 sandbox 원시값에 있어도 null"
            assert snap.normalized["conversions"] is None
    finally:
        await engine.dispose()

"""story #3808(Phase3·3-3 PR2, 페드루 PO 確定 2026-09-11) — X 발행(텍스트·미디어
3단계·스레드 N건)·`channel_publications.sequence`·`x_sandbox` 결정적 마커 4종.
AC2 담당 파일 — 4단:
① `channel_publications` sequence 컬럼/제약 — 실DB 뮤테이션 pin.
② `x_publish.py::publish_x_thread` 프리미티브 계약(3세그먼트·reply 체인·sequence
  1~3) — 단위(FakeClient), 실 네트워크 0.
③ 실 호출부(N=1) 회귀 — `publish_channel_post_draft`가 `x_sandbox` 채널을 실제로
  통과시켜 sequence=1 행을 남기는지(서비스 계층 통합, x_sandbox_publish.py 사용).
④ `x_sandbox_publish.py` 결정적 마커 4종."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest

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


# ─── ① channel_publications sequence 컬럼/제약 — 실DB 뮤테이션 pin ─────────────

def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="X Publish Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="owner")
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="X 발행 테스트"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


@pytest.mark.anyio
async def test_channel_publications_allows_multiple_sequences_per_gate_version_but_rejects_duplicate_sequence():
    """⭐뮤테이션 대상 — 이 제약을 옛 (gate_id, version_id) 2열로 되돌리면 sequence=1
    저장 뒤 sequence=2 저장이 IntegrityError로 RED(스레드 2번째 세그먼트를 못 남김).
    같은 sequence 중복(1,1)은 새 제약에서도 여전히 막혀야 한다(양성대조)."""
    from sqlalchemy.exc import IntegrityError
    from app.models.channel_publication import ChannelPublication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
        gate_id, version_id, connection_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        async with Session() as s:
            s.add(ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
                connection_id=connection_id, channel="x_sandbox", sequence=1,
            ))
            await s.commit()

        # 같은 gate+version, 다른 sequence(2) — 새 제약이면 통과(스레드 2번째 세그먼트).
        async with Session() as s:
            s.add(ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
                connection_id=connection_id, channel="x_sandbox", sequence=2,
            ))
            await s.commit()

        # 같은 gate+version+sequence(1) 중복 — 여전히 막혀야 한다(양성대조).
        async with Session() as s:
            s.add(ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
                connection_id=connection_id, channel="x_sandbox", sequence=1,
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


# ─── ② x_publish.py::publish_x_thread — 3세그먼트 reply 체인 계약(FakeClient) ────

class _FakeXClient:
    def __init__(self, tweet_ids: list[str]):
        self._tweet_ids = list(tweet_ids)
        self.post_calls: list[dict] = []
        self.get_calls: list[str] = []

    async def post(self, url, *, json=None, headers=None, data=None, files=None):
        if url == "https://api.x.com/2/tweets":
            self.post_calls.append(json)
            tweet_id = self._tweet_ids[len(self.post_calls) - 1]
            return httpx.Response(201, json={"data": {"id": tweet_id, "text": json["text"]}})
        raise AssertionError(f"unexpected POST {url}")

    async def get(self, url, *, params=None, headers=None):
        self.get_calls.append(url)
        tweet_id = params.get("expansions") and url.rsplit("/", 1)[-1]
        return httpx.Response(200, json={
            "data": {"id": tweet_id}, "includes": {"users": [{"username": "sprintable_x"}]},
        })


@pytest.mark.anyio
async def test_publish_x_thread_three_segments_chain_replies_and_returns_sequence_1_to_3():
    from app.services.x_publish import publish_x_thread

    client = _FakeXClient(["tw-1", "tw-2", "tw-3"])
    results = await publish_x_thread(
        client, access_token="at-1", texts=["세그먼트 1", "세그먼트 2", "세그먼트 3"],
    )
    assert [r["sequence"] for r in results] == [1, 2, 3]
    assert [r["external_id"] for r in results] == ["tw-1", "tw-2", "tw-3"]
    assert all(r["permalink"] == "https://x.com/sprintable_x/status/" + r["external_id"] for r in results)

    # reply 체인 — 세그먼트 1은 in_reply_to 없음, 2는 1을 참조, 3은 2를 참조.
    assert "reply" not in client.post_calls[0]
    assert client.post_calls[1]["reply"]["in_reply_to_tweet_id"] == "tw-1"
    assert client.post_calls[2]["reply"]["in_reply_to_tweet_id"] == "tw-2"


@pytest.mark.anyio
async def test_publish_x_thread_head_media_id_attached_only_to_first_segment():
    from app.services.x_publish import publish_x_thread

    client = _FakeXClient(["tw-1", "tw-2"])
    await publish_x_thread(client, access_token="at-1", texts=["헤드", "두번째"], media_id="media-99")
    assert client.post_calls[0]["media"]["media_ids"] == ["media-99"]
    assert "media" not in client.post_calls[1]


@pytest.mark.anyio
async def test_publish_x_thread_partial_failure_carries_already_published_segments():
    """⭐부분 성공 정직성 — 2번째 세그먼트에서 provider 실패 시 예외에 1번째 세그먼트
    (이미 실제로 게시됨)를 실어 호출부가 그 사실을 잃지 않게 한다."""
    from app.services.threads_publish import ThreadsPublishError
    from app.services.x_publish import publish_x_thread

    class _FailingClient(_FakeXClient):
        async def post(self, url, *, json=None, headers=None, data=None, files=None):
            if len(self.post_calls) == 1:
                self.post_calls.append(json)
                return httpx.Response(429, text="rate limited")
            return await super().post(url, json=json, headers=headers, data=data, files=files)

    client = _FailingClient(["tw-1", "tw-2"])
    with pytest.raises(ThreadsPublishError) as exc_info:
        await publish_x_thread(client, access_token="at-1", texts=["헤드", "두번째"])
    assert len(exc_info.value.published_segments) == 1
    assert exc_info.value.published_segments[0]["external_id"] == "tw-1"


# ─── ③ 실 호출부(N=1) 회귀 — publish_channel_post_draft가 x_sandbox를 통과시킨다 ───

@pytest.mark.anyio
async def test_publish_channel_post_draft_x_sandbox_writes_sequence_one_row():
    """⭐실 호출부 — draft 생성→상신→승인→publish_channel_post_draft(서비스 계층,
    router 우회 0) 전 구간을 x_sandbox로 왕복해 sequence=1이 실제로 찍히는지 확認
    (N=1은 오늘부터 실 서비스라는 카드 決定의 재현)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.gate import Gate
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_posts import (
        create_channel_post_draft_version, publish_channel_post_draft, submit_channel_post_draft,
    )
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_default_role(s, org_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-user-1",
                account_label="sandbox_x_user", credential_kind="oauth",
                access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=owner_id,
            )
            connection_id = connection.id

            version, _channel, _images = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="X sandbox 단일 발행 테스트", link_url=None,
                author_member_id=owner_id, author_kind="human",
            )
            draft_id = version.draft_id

            gate, _ = await submit_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, version_id=version.id, requester_member_id=owner_id,
            )
            gate_row = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
            gate_row.status = "approved"
            gate_row.resolver_id = uuid.uuid4()
            gate_row.resolved_at = datetime.now(timezone.utc)
            await s.commit()

            row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )

        assert row.channel == "x_sandbox"
        assert row.sequence == 1
        assert row.status == "published"
        assert row.external_id is not None and row.external_id.startswith("sandbox-x-tweet-")
        assert row.permalink == f"https://sandbox.invalid/x/{row.external_id}"
    finally:
        await engine.dispose()


# ─── ④ x_sandbox_publish.py 결정적 마커 4종 ───────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize(
    "marker,expected_code,expected_status",
    [
        ("[sandbox:429]", "SANDBOX_X_RATE_LIMITED", 429),
        ("[sandbox:provider-error]", "SANDBOX_X_PROVIDER_ERROR", 502),
        ("[sandbox:expired-token]", "SANDBOX_X_TOKEN_EXPIRED", 401),
        ("[sandbox:duplicate-post]", "SANDBOX_X_DUPLICATE_POST", 400),
    ],
)
async def test_x_sandbox_create_container_markers_are_deterministic(marker, expected_code, expected_status):
    from app.services.threads_publish import ThreadsPublishError
    from app.services.x_sandbox_publish import create_container

    with pytest.raises(ThreadsPublishError) as exc_info:
        await create_container(
            httpx.AsyncClient(), access_token="at", threads_user_id="u", text=f"본문 {marker} 끝",
        )
    assert exc_info.value.code == expected_code
    assert exc_info.value.status_code == expected_status
    assert marker in exc_info.value.message


@pytest.mark.anyio
async def test_x_sandbox_create_container_without_marker_succeeds_deterministically():
    from app.services.x_sandbox_publish import create_container

    creation_id = await create_container(httpx.AsyncClient(), access_token="at", threads_user_id="u", text="정상 본문")
    assert creation_id.startswith("sandbox-x-post-")

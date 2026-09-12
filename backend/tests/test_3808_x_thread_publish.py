"""story #3808(Phase3·3-3 PR5b-1, 페드루 PO 確定 2026-09-12) — X 스레드(N세그먼트)
발행 오케스트레이터. PR2가 만든 `publish_x_thread` 프리미티브(N지원)는 그대로 두고,
`publish_channel_post_draft`의 실 호출부가 처음으로 N≥2를 통과시킨다.

계약값 5종(카드 확定):
① N=3 정상 — 행 3·permalink 3·evidence 3·인사이트 스케줄은 헤드(seq=1) 1건만.
② k=2 실패 — 행 2(1=published·2=failed)·재시도 시 3번째까지 이어 완주(같은 seq=2
  행을 갱신, 새 행 추가 아님).
③ thread_max_segments(10) 초과(11개) → 422(저장 시점).
④ 예산 부족(N×unit_cost) → 422(발행 시점, 재시도 시 "남은 수"만으로 재계산).
⑤ 뮤테이션 셀프체크 각 1(②·③·④ 축마다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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

    org = Organization(id=uuid.uuid4(), name="X Thread Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_story(session, org_id, project_id, *, title="X 스레드 발행 테스트"):
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


async def _seed_ready_thread_draft(
    session, *, thread: list[str], head_text: str = "헤드 세그먼트",
):
    """org·human·story·역할·x_sandbox 연결까지 세팅한 뒤 승인 완료 상태의 스레드
    초안을 하나 만들어 (org_id, owner_id, draft_id, gate_id, version) 반환한다 —
    5종 테스트가 전부 이 상태(발행 직전)에서 시작한다."""
    from app.models.gate import Gate
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_posts import (
        create_channel_post_draft_version, submit_channel_post_draft,
    )
    from sqlalchemy import select

    org_id, project_id = await _seed_org(session)
    owner_id = await _seed_human(session, org_id)
    story_id = await _seed_story(session, org_id, project_id)
    await _seed_default_role(session, org_id)
    connection = await upsert_channel_connection(
        session, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-thread-1",
        account_label="sandbox_x_thread_user", credential_kind="oauth",
        access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
        token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
        scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=owner_id,
    )
    version, _channel, _violations = await create_channel_post_draft_version(
        session, org_id=org_id, work_item_id=story_id, connection_id=connection.id,
        text=head_text, link_url=None, author_member_id=owner_id, author_kind="human",
        channel_payload={"thread": thread} if thread else None,
    )
    draft_id = version.draft_id

    gate, _ = await submit_channel_post_draft(
        session, org_id=org_id, draft_id=draft_id, version_id=version.id, requester_member_id=owner_id,
    )
    gate_row = (await session.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
    gate_row.status = "approved"
    gate_row.resolver_id = uuid.uuid4()
    gate_row.resolved_at = datetime.now(timezone.utc)
    await session.commit()

    return org_id, owner_id, draft_id, gate.id, version


# ─── ① N=3 정상 ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_thread_publish_n3_creates_three_rows_three_evidence_one_insight_schedule():
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from app.models.evidence import Evidence
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )

            head_row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )
            assert head_row.sequence == 1
            assert head_row.status == "published"

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            assert [r.sequence for r in rows] == [1, 2, 3]
            assert all(r.status == "published" for r in rows)
            assert all(r.permalink is not None for r in rows)
            assert len({r.external_id for r in rows}) == 3, "세그먼트마다 서로 다른 tweet id"

            evidence_rows = list((await s.execute(
                select(Evidence).where(Evidence.org_id == org_id, Evidence.type == "metric")
            )).scalars().all())
            assert len(evidence_rows) == 3, "세그먼트마다 evidence 1건씩(publication_id+sequence 멱등 축)"

            snapshots = list((await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.org_id == org_id)
            )).scalars().all())
            head_publication_id = rows[0].id
            assert all(snap.publication_id == head_publication_id for snap in snapshots), (
                "인사이트 스케줄은 헤드(seq=1) 행에만 — 다른 세그먼트는 스케줄 0건"
            )
            assert len(snapshots) == 2, "헤드 1건에 대해 1d·7d 두 행(schedule_insight_snapshots 계약)"
    finally:
        await engine.dispose()


# ─── ② k=2 실패 → 재시도 완주 ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_thread_publish_partial_failure_at_k2_then_retry_completes():
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            # 2번째 세그먼트에 sandbox 429 마커 — 정확히 그 자리에서 멈춰야 한다(양성대조).
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["[sandbox:429] 실패 유발", "세그먼트 3"],
            )

            from app.services.channel_posts import ChannelRateLimitedError
            with pytest.raises(ChannelRateLimitedError):
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                )

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            assert [r.sequence for r in rows] == [1, 2], "3번째는 아예 행이 없어야 한다(시도 자체를 안 함)"
            assert rows[0].status == "published"
            assert rows[1].status == "failed"
            assert rows[1].error_code == "CHANNEL_RATE_LIMITED"
            failed_row_id = rows[1].id

        # 재시도 — 같은 함수 재호출. 실 서비스에선 초안 텍스트를 고쳐 마커를 없애고
        # 재상신하지만, 이 테스트는 "이미 승인된 같은 gate/version"으로 그대로 재호출해
        # 오케스트레이터의 이어달리기 로직만 격리 검증한다(channel_payload를 직접
        # 마커 없는 값으로 바꿔치기).
        async with Session() as s:
            from app.models.channel_post_version import ChannelPostVersion
            v = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == version.id)
            )).scalar_one()
            v.channel_payload = {"thread": ["재시도 성공", "세그먼트 3"]}
            await s.commit()

            head_row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )
            assert head_row.sequence == 1
            assert head_row.status == "published"

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            assert [r.sequence for r in rows] == [1, 2, 3], "3번째까지 완주"
            assert all(r.status == "published" for r in rows)
            assert rows[1].id == failed_row_id, "실패했던 2번 행을 재사용(새 행 추가 아님)"
            assert rows[1].error_code is None, "재시도 성공 후 실패 마커가 지워져야 한다"
    finally:
        await engine.dispose()


# ─── ③ thread_max_segments(10) 초과 → 422(저장 시점) ──────────────────────

@pytest.mark.anyio
async def test_thread_segment_count_over_cap_rejected_at_save_time():
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_posts import ChannelThreadSegmentLimitExceededError, create_channel_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-cap-1",
                account_label="cap_user", credential_kind="oauth",
                access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=owner_id,
            )
            eleven_segments = [f"세그먼트 {i}" for i in range(11)]
            with pytest.raises(ChannelThreadSegmentLimitExceededError) as exc_info:
                await create_channel_post_draft_version(
                    s, org_id=org_id, work_item_id=story_id, connection_id=connection.id,
                    text="헤드", link_url=None, author_member_id=owner_id, author_kind="human",
                    channel_payload={"thread": eleven_segments},
                )
            assert exc_info.value.max_segments == 10
            assert exc_info.value.current_count == 11
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_thread_segment_count_at_exactly_cap_is_fine():
    """양성대조 — 정확히 10개(상한)는 통과해야 한다(위 11개 초과 테스트와 대비되는 경계)."""
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_posts import create_channel_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-cap-2",
                account_label="cap_user_2", credential_kind="oauth",
                access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=owner_id,
            )
            ten_segments = [f"세그먼트 {i}" for i in range(10)]
            version, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection.id,
                text="헤드", link_url=None, author_member_id=owner_id, author_kind="human",
                channel_payload={"thread": ten_segments},
            )
            assert version.channel_payload == {"thread": ten_segments}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_thread_cap_check_removed_lets_11_segments_through():
    """⭐뮤테이션 셀프체크 — `_validate_thread_segments()`의 상한 검사를 무력화하면
    11개짜리 저장이 그대로 통과해야(=이 가드가 실제로 그 시나리오를 잡는다는 증명)."""
    import app.services.channel_posts as channel_posts_module

    original = channel_posts_module._validate_thread_segments

    def _mutated_no_cap_check(*, channel, thread):
        pass  # MUTATION-SELFCHECK-3808: 상한/미지원/길이 검사 전부 무력화

    channel_posts_module._validate_thread_segments = _mutated_no_cap_check
    try:
        engine, Session = await _session_factory()
        try:
            async with Session() as s:
                org_id, project_id = await _seed_org(s)
                owner_id = await _seed_human(s, org_id)
                story_id = await _seed_story(s, org_id, project_id)
                from app.services.channel_connection import upsert_channel_connection

                connection = await upsert_channel_connection(
                    s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-cap-3",
                    account_label="cap_user_3", credential_kind="oauth",
                    access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                    token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                    scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=owner_id,
                )
                eleven_segments = [f"세그먼트 {i}" for i in range(11)]
                version, _channel, _violations = await channel_posts_module.create_channel_post_draft_version(
                    s, org_id=org_id, work_item_id=story_id, connection_id=connection.id,
                    text="헤드", link_url=None, author_member_id=owner_id, author_kind="human",
                    channel_payload={"thread": eleven_segments},
                )
                assert len(version.channel_payload["thread"]) == 11, "가드 무력화 시 11개가 그대로 통과(RED 재현)"
        finally:
            await engine.dispose()
    finally:
        channel_posts_module._validate_thread_segments = original


# ─── ④ 예산 부족(N×unit_cost) → 422(발행 시점) ─────────────────────────────

@pytest.mark.anyio
async def test_thread_publish_insufficient_budget_for_n_segments_rejected():
    """한도가 딱 2세그먼트분만 남아 있는데 3세그먼트를 발행하려 하면 422(예산 초과) —
    실제로 provider 호출(publish_x_thread) 자체가 0건이어야 한다(발행 前 재검사)."""
    from app.services.content_rules import put_org_content_rules
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.x_publish_budget import get_api_usage_unit_cost_minor

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )
            unit_cost = get_api_usage_unit_cost_minor(None)
            await put_org_content_rules(
                s, org_id=org_id,
                rules={"api_usage_budget": {"limit_minor": unit_cost * 2, "currency": "KRW", "period": "month"}},
                expected_version=0, updated_by_member_id=owner_id,
            )

            from app.services.channel_posts import publish_channel_post_draft
            with pytest.raises(GenerationBudgetExceededError) as exc_info:
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                )
            assert exc_info.value.limit_minor == unit_cost * 2
            assert exc_info.value.estimated_cost_minor == unit_cost * 3

            from sqlalchemy import select
            from app.models.channel_publication import ChannelPublication
            rows = list((await s.execute(
                select(ChannelPublication).where(
                    ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id,
                )
            )).scalars().all())
            assert rows == [], "예산 재검사가 provider 호출보다 먼저라 행이 하나도 안 생겨야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_thread_publish_retry_budget_check_uses_remaining_count_not_full_n():
    """⭐재시도 시 예산 재검사가 "남은 세그먼트 수"만 본다 — 이미 1개(헤드) 발행 뒤
    남은 한도가 1세그먼트분뿐이어도(전체 재검사면 3세그먼트분 요구해 거부되겠지만)
    남은 2개(2·3번)분만 있으면 통과해야 한다."""
    from app.services.content_rules import put_org_content_rules
    from app.services.x_publish_budget import get_api_usage_unit_cost_minor

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["[sandbox:429] 실패 유발", "세그먼트 3"],
            )
            unit_cost = get_api_usage_unit_cost_minor(None)
            # 한도=3세그먼트분(헤드+실패한 2번째까지 소진 예정 — 실은 실패라 2번째는
            # evidence가 안 남는다). 헤드 1건 소진 뒤 재시도 시점엔 「남은 2개」만
            # 검사해야 하므로 한도를 "헤드 1건 + 2개"에 딱 맞춰 둔다(3세그먼트분).
            await put_org_content_rules(
                s, org_id=org_id,
                rules={"api_usage_budget": {"limit_minor": unit_cost * 3, "currency": "KRW", "period": "month"}},
                expected_version=0, updated_by_member_id=owner_id,
            )

            from app.services.channel_posts import ChannelRateLimitedError
            from app.services.channel_posts import publish_channel_post_draft
            with pytest.raises(ChannelRateLimitedError):
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                )

        async with Session() as s:
            from sqlalchemy import select
            from app.models.channel_post_version import ChannelPostVersion
            v = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == version.id)
            )).scalar_one()
            v.channel_payload = {"thread": ["재시도 성공", "세그먼트 3"]}
            await s.commit()

            from app.services.channel_posts import publish_channel_post_draft
            head_row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )
            assert head_row.status == "published"
            # 헤드(1건, 성공 evidence 기록됨)+재시도 2개(성공) = 실제로 소비된 evidence는
            # 3건(헤드 1+재시도 2, 실패했던 2번째 시도는 evidence 미기록) — 한도 3세그먼트분
            # 안에 정확히 들어맞는다는 것이 이 테스트의 핵심(재시도 재검사가 "3개 전체"를
            # 다시 요구했다면 총 필요량이 1(헤드,이미소비)+3(전체 재검사)=4가 되어 거부됐을
            # 것).
    finally:
        await engine.dispose()




# ─── PR5b-2 그라운딩 — thread_max_segments 연결 응답 노출 ──────────────────────

@pytest.mark.anyio
async def test_channel_connection_response_exposes_thread_max_segments_for_x():
    """story #3808(PR5b-2, 페드루 PO 確定 2026-09-12) — image_max_count와 동형
    관례로 어댑터 선언이 코드 변경 0으로 연결 응답에 자동 노출돼야 한다(FE가
    「스레드 이어쓰기」 목록 UI 노출 여부를 이 값으로 판단, 채널 이름 하드코딩
    금지)."""
    from tests.test_3471_org_content_rules_lint import _client_for, _setup_org_scoped_app
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            from app.services.channel_connection import upsert_channel_connection
            await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-thread-cap-1",
                account_label="cap_user", credential_kind="oauth",
                access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=owner_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
            assert r.status_code == 200, r.text
            row = r.json()[0]
            assert row["thread_max_segments"] == 10
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_connection_response_thread_max_segments_zero_for_unsupported_channel():
    """양성대조 — 스레드 이어쓰기 미선언 채널(threads)은 0(미지원, image_max_count=0과
    동형 관례 — null이 아니다)."""
    from tests.test_3471_org_content_rules_lint import _client_for, _setup_org_scoped_app
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            from app.services.channel_connection import upsert_channel_connection
            await upsert_channel_connection(
                s, org_id=org_id, channel="threads", account_id="threads-1",
                account_label="threads_user", credential_kind="oauth",
                access_token="plain-access-token", refresh_token=None, token_expires_at=None,
                refresh_mode="reissue_from_access_token", scopes=[], connected_by=owner_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
            assert r.status_code == 200, r.text
            row = r.json()[0]
            assert row["thread_max_segments"] == 0
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── PR5b-2 — thread_segments 배열 노출(부분 실패 상태) ────────────────────────

@pytest.mark.anyio
async def test_draft_detail_exposes_thread_segments_array_for_n3_all_published():
    """story #3808(PR5b-2, 페드루 PO 確定 2026-09-12) — N=3 전부 발행 성공하면
    thread_segments 배열이 sequence 1..3 전부(published)를 담고, 기존 단일값
    4필드(publication_status 등)는 헤드(seq=1) 값 그대로(하위호환)."""
    from tests.test_3471_org_content_rules_lint import _client_for, _setup_org_scoped_app
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )
            head_row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )
            assert head_row.status == "published"

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r.status_code == 200, r.text
            body = r.json()
            segments = body["thread_segments"]
            assert segments is not None
            assert [seg["sequence"] for seg in segments] == [1, 2, 3]
            assert all(seg["status"] == "published" for seg in segments)
            assert body["publication_status"] == "published", "기존 단일값은 헤드 그대로(하위호환)"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_exposes_thread_segments_array_for_partial_failure():
    """k=2에서 실패하면 thread_segments가 [seq1=published, seq2=failed]만 담고
    3번째(시도 자체를 안 함)는 배열에 없다(지어내지 않는다)."""
    from tests.test_3471_org_content_rules_lint import _client_for, _setup_org_scoped_app
    from app.main import app
    from app.services.channel_posts import ChannelRateLimitedError, publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["[sandbox:429] 실패 유발", "세그먼트 3"],
            )
            with pytest.raises(ChannelRateLimitedError):
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r.status_code == 200, r.text
            body = r.json()
            segments = body["thread_segments"]
            assert [seg["sequence"] for seg in segments] == [1, 2]
            assert segments[0]["status"] == "published"
            assert segments[1]["status"] == "failed"
            assert segments[1]["error_code"] == "CHANNEL_RATE_LIMITED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_thread_segments_null_for_non_thread_draft():
    """양성대조 — 스레드가 아닌(channel_payload.thread 없는) 단일 발행은
    thread_segments가 null(빈 배열 아님)."""
    from tests.test_3471_org_content_rules_lint import _client_for, _setup_org_scoped_app
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(s, thread=[])
            row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )
            assert row.status == "published"

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r.status_code == 200, r.text
            assert r.json()["thread_segments"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── PR5b-2 이월(카디르 QA①, #4218 계약①) — 발행 직전 재검증(②) 자체 테스트 ──

@pytest.mark.anyio
async def test_thread_publish_rejects_when_adapter_cap_lowered_after_save():
    """story #3808(PR5b-1, 페드루 PO 確定 2026-09-12 — ②) — `_validate_thread_segments`
    는 저장 시점·발행 시점 둘 다에서 호출된다("승인 뒤 어댑터 선언이 바뀌었을 가능성에
    대한 방어", ChannelTextTooLongError 헤드 재검증과 동형). 저장 시점엔 그 테스트가
    있었지만(test_thread_segment_count_over_cap_rejected_at_save_time) 발행 시점(두
    번째 호출)은 카디르 QA 실측까지 테스트 0건이었다 — 여기서 처음 pin한다.

    저장 시점엔 상한 10으로 valid(이어쓰기 2개)했던 draft를, 승인 뒤·발행 前 어댑터
    선언이 1로 낮아진 상태에서 발행 시도 — 재검증이 잡아 422(ChannelThreadSegmentLimit
    ExceededError)를 내야 하고, publish_x_thread(실 provider 호출) 자체가 0건이어야
    한다(예산 부족 테스트와 같은 "재검사 실패 시 provider 왕복 자체가 없다" 계약)."""
    import dataclasses
    import app.services.channel_adapters as adapters_mod
    from app.services.channel_posts import ChannelThreadSegmentLimitExceededError, publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )

        original_x_sandbox = adapters_mod.CHANNEL_ADAPTERS["x_sandbox"]
        lowered = dataclasses.replace(original_x_sandbox, thread_max_segments=1)
        adapters_mod.CHANNEL_ADAPTERS["x_sandbox"] = lowered
        try:
            publish_calls: list[object] = []
            import app.services.x_sandbox_publish as x_sandbox_publish_module
            original_publish_x_thread = x_sandbox_publish_module.publish_x_thread

            async def _counting_publish_x_thread(*args, **kwargs):
                publish_calls.append((args, kwargs))
                return await original_publish_x_thread(*args, **kwargs)

            x_sandbox_publish_module.publish_x_thread = _counting_publish_x_thread
            try:
                async with Session() as s:
                    with pytest.raises(ChannelThreadSegmentLimitExceededError) as exc_info:
                        await publish_channel_post_draft(
                            s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                        )
                    assert exc_info.value.max_segments == 1
                    assert exc_info.value.current_count == 2
            finally:
                x_sandbox_publish_module.publish_x_thread = original_publish_x_thread
            assert publish_calls == [], "재검증에 걸리면 provider 호출 자체가 없어야 한다(예산 부족 축과 동형 계약)"
        finally:
            adapters_mod.CHANNEL_ADAPTERS["x_sandbox"] = original_x_sandbox
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_publish_time_thread_revalidation_removed_lets_lowered_cap_through():
    """⭐뮤테이션 셀프체크 — `_publish_x_thread_draft`의 발행 직전 `_validate_thread_
    segments` 호출을 제거하면(승인 뒤 어댑터가 낮아진 상태에서도) 발행이 그대로
    통과해야(=이 재검증이 실제로 그 시나리오를 잡는다는 증명)."""
    import dataclasses
    import app.services.channel_adapters as adapters_mod
    import app.services.channel_posts as channel_posts_module

    original_validate = channel_posts_module._validate_thread_segments
    call_count = {"n": 0}

    def _mutated_skip_second_call(*, channel, thread):
        call_count["n"] += 1
        if call_count["n"] >= 2:
            return  # 발행 시점(두 번째 호출)만 무력화 — 저장 시점(①) 가드는 그대로.
        return original_validate(channel=channel, thread=thread)

    channel_posts_module._validate_thread_segments = _mutated_skip_second_call
    try:
        from app.services.channel_posts import publish_channel_post_draft

        engine, Session = await _session_factory()
        try:
            async with Session() as s:
                org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                    s, thread=["세그먼트 2", "세그먼트 3"],
                )

            original_x_sandbox = adapters_mod.CHANNEL_ADAPTERS["x_sandbox"]
            adapters_mod.CHANNEL_ADAPTERS["x_sandbox"] = dataclasses.replace(original_x_sandbox, thread_max_segments=1)
            try:
                async with Session() as s:
                    row = await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                    )
                    assert row.status == "published", "가드 무력화 시 상한 위반이 그대로 통과(RED 재현)"
            finally:
                adapters_mod.CHANNEL_ADAPTERS["x_sandbox"] = original_x_sandbox
        finally:
            await engine.dispose()
    finally:
        channel_posts_module._validate_thread_segments = original_validate


# ─── PR5d(페드루 PO 確定 2026-09-12, 배포 80 라이브 회차 갭) — [sandbox:429-once] ──
# 「같은 버전(같은 세그먼트 텍스트)을 고치지 않고 재시도만으로 성공」 시나리오를
# sandbox로 증명한다 — 기존 [sandbox:429]는 텍스트에 마커가 남아 있는 한 영원히
# 실패해 이 경로를 재현할 수 없었다(라이브 회차 "못 잰 것 1").

@pytest.mark.anyio
async def test_thread_publish_429_once_marker_fails_first_then_succeeds_on_unedited_retry():
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from app.models.evidence import Evidence
    from app.services.channel_posts import ChannelRateLimitedError, publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["[sandbox:429-once] 첫 시도만 실패", "세그먼트 3"],
            )

            with pytest.raises(ChannelRateLimitedError):
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                )

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            assert [r.sequence for r in rows] == [1, 2]
            assert rows[0].status == "published"
            assert rows[1].status == "failed"
            head_external_id = rows[0].external_id
            failed_row_id = rows[1].id

            evidence_after_first_call = len((await s.execute(
                select(Evidence).where(Evidence.org_id == org_id, Evidence.type == "metric")
            )).scalars().all())
            assert evidence_after_first_call == 1, "헤드 1건만 실제로 성공 — 실패분은 evidence 없음"

        # 재시도 — channel_payload를 «전혀 안 건드리고» 같은 함수를 다시 부른다
        # (기존 [sandbox:429] 테스트와 다른 지점 — 여기가 이 마커의 존재 이유다).
        async with Session() as s:
            head_row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
            )
            assert head_row.sequence == 1
            assert head_row.status == "published"
            assert head_row.external_id == head_external_id, "헤드는 재발행되지 않는다(그대로)"

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            assert [r.sequence for r in rows] == [1, 2, 3], "3번째까지 완주"
            assert all(r.status == "published" for r in rows)
            assert rows[1].id == failed_row_id, "실패했던 2번 행을 재사용(새 행 추가 아님)"
            assert rows[1].error_code is None

            evidence_after_retry = len((await s.execute(
                select(Evidence).where(Evidence.org_id == org_id, Evidence.type == "metric")
            )).scalars().all())
            assert evidence_after_retry == 3, "1(첫 호출 헤드) + 2(재시도 seq2·seq3) — remaining_count 단위만 청구"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_thread_publish_429_once_marker_still_fails_on_fresh_first_attempt_at_other_sequence():
    """양성대조 — 재개 자리(index 0)가 아닌 세그먼트에 이 마커가 있으면(첫 시도이므로)
    그대로 실패한다(무조건 통과가 아니라 "그 자리의 두 번째 시도"만 통과)."""
    from app.services.channel_posts import ChannelRateLimitedError, publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "[sandbox:429-once] 첫 시도"],
            )
            with pytest.raises(ChannelRateLimitedError):
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_429_once_retry_pass_removed_makes_unedited_retry_fail_forever():
    """⭐뮤테이션 셀프체크 — 호출부가 넘기는 `is_retry` 신호를 무력화(항상 False로
    덮어씀)하면, 마커를 안 지운 재시도가 [sandbox:429] 옛 마커처럼 영원히 실패해야
    한다(=이 처방이 실제로 그 시나리오를 가른다는 증명)."""
    # publish_x_thread_fn 호출부 자체를 패치하기보다, 더 정확히 처방 지점만 겨냥한다 —
    # _publish_x_thread_draft가 넘기는 is_retry 인자를 sandbox 쪽에서 무시하도록
    # x_sandbox_publish.publish_x_thread를 감싼다(실제 처방 라인은 channel_posts.py의
    # `is_retry=resume_row is not None`이지만, 함수 내부 지역변수라 몽키패치 대상이
    # 아니다 — 같은 효과를 내는 소비측 무력화로 검증).
    import app.services.x_sandbox_publish as x_sandbox_publish_module
    original_publish_x_thread = x_sandbox_publish_module.publish_x_thread

    async def _mutated_always_first_attempt(*args, **kwargs):
        kwargs["is_retry"] = False
        return await original_publish_x_thread(*args, **kwargs)

    x_sandbox_publish_module.publish_x_thread = _mutated_always_first_attempt
    try:
        from app.services.channel_posts import ChannelRateLimitedError, publish_channel_post_draft

        engine, Session = await _session_factory()
        try:
            async with Session() as s:
                org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                    s, thread=["[sandbox:429-once] 첫 시도만 실패", "세그먼트 3"],
                )
                with pytest.raises(ChannelRateLimitedError):
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                    )

            async with Session() as s:
                with pytest.raises(ChannelRateLimitedError):
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
                    )
        finally:
            await engine.dispose()
    finally:
        x_sandbox_publish_module.publish_x_thread = original_publish_x_thread

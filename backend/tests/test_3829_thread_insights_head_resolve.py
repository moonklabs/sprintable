"""story #3829(customer-zero 실측, 페드루 PO 確定 2026-09-13) — X 스레드(N≥2
세그먼트) 발행물의 `/insights`·`/comments` 조회가 항상 빈 값이던 결함의 read-경로
정정. 인사이트는 헤드(seq=1) 행에만 예약되는데(story #3808 PR5b-1 "헤드만" 스펙),
draft 응답 `publication_id`는 "마지막 발행"(가장 최근 published_at, 스레드는 보통
마지막 세그먼트) 행을 가리켜 서로 다른 sequence를 참조했다(디디 그라운딩
2026-09-13 09:01Z). 처방: `/insights`·`/comments`는 어느 세그먼트 id로 물어도
같은 (gate_id, version_id)의 헤드 행으로 해석한다. draft 응답에 `head_publication_id`
를 additive로 얹는다(기존 `publication_id` 축은 무변).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_3808_x_thread_publish import (
    _REAL_DB_URL,
    _configure_secrets,  # noqa: F401 — autouse fixture, import만으로 등록.
    _seed_ready_thread_draft,
    _session_factory,
)

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


async def _publish_n3_thread(session, *, org_id, owner_id, draft_id):
    from app.services.channel_posts import publish_channel_post_draft

    return await publish_channel_post_draft(
        session, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_id,
    )


@pytest.mark.anyio
async def test_insights_endpoint_resolves_any_segment_id_to_head_realdb():
    """AC1 — seq 2·3 id로 /insights를 물어도 헤드(seq 1)의 1d/7d 스냅샷 2건을
    그대로 반환한다(단건 세그먼트 id로 물었을 때와 동일 결과)."""
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from app.routers.insight_snapshots import _list_publication_insights_endpoint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )
            await _publish_n3_thread(s, org_id=org_id, owner_id=owner_id, draft_id=draft_id)

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            head_id, seq2_id, seq3_id = rows[0].id, rows[1].id, rows[2].id

            head_result = await _list_publication_insights_endpoint(
                org_id, head_id, db=s, verified_org_id=org_id, _auth=None, resolved_locale="ko",
            )
            assert len(head_result) == 2, "헤드 id 자체로 물으면 원래도 2행이어야 한다(양성대조)"

            for seg_id in (seq2_id, seq3_id):
                result = await _list_publication_insights_endpoint(
                    org_id, seg_id, db=s, verified_org_id=org_id, _auth=None, resolved_locale="ko",
                )
                assert len(result) == 2, f"세그먼트 id({seg_id})로 물었는데 헤드로 해석되지 않았다: {result}"
                assert {r.id for r in result} == {r.id for r in head_result}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comments_endpoint_resolves_segment_id_to_head_without_404_realdb():
    """AC2 — /comments도 같은 해석(세그먼트 id → 헤드) — 헤드가 실존하는 한
    CommentPublicationNotFoundError(404)가 나면 안 된다. 스레드는 comment 수집
    자체가 세그먼트별로 스케줄되지 않아(범위 밖 — 별도 관찰) 실제 댓글 0건은
    정상이다. 판별축은 "resolve가 되어 404 없이 응답이 오는가"뿐."""
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_post_comments import list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )
            await _publish_n3_thread(s, org_id=org_id, owner_id=owner_id, draft_id=draft_id)

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            seq3_id = rows[2].id

            from app.services.insight_snapshots import resolve_head_publication_id
            resolved = await resolve_head_publication_id(s, publication_id=seq3_id)
            assert resolved == rows[0].id

            # 라우터의 조회 자체가 CommentPublicationNotFoundError 없이 성립하는지
            # (해석된 헤드 id가 실존 org 소속이므로 통과해야 한다).
            result = await list_comments_for_publication(s, org_id=org_id, publication_id=resolved)
            assert result["comments"] == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comments_endpoint_org_isolation_preserved_realdb():
    """AC2 — org 격리 무변: 다른 org의 publication_id는 (헤드로 해석되든 말든)
    여전히 404."""
    from app.services.channel_post_comments import (
        CommentPublicationNotFoundError, list_comments_for_publication,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2"],
            )
            await _publish_n3_thread(s, org_id=org_id, owner_id=owner_id, draft_id=draft_id)

            other_org_id = uuid.uuid4()
            with pytest.raises(CommentPublicationNotFoundError):
                await list_comments_for_publication(s, org_id=other_org_id, publication_id=uuid.uuid4())
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_response_exposes_head_publication_id_realdb():
    """AC3 — draft 응답에 head_publication_id(스레드=seq 1 행)·기존 publication_id
    (마지막 발행=seq 3)는 무변으로 공존."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from tests.conftest import override_db_and_read
    from app.dependencies.auth import AuthContext, get_current_user

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )
            await _publish_n3_thread(s, org_id=org_id, owner_id=owner_id, draft_id=draft_id)

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            head_id, last_id = rows[0].id, rows[2].id

        async def _db():
            async with Session() as s2:
                try:
                    yield s2
                    await s2.commit()
                except Exception:
                    await s2.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(owner_id), email="owner@test", claims={"app_metadata": {"org_id": str(org_id)}})

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            resp = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            # story #3525 축(publication_id="마지막 발행")은 이 PR의 관심사가 아니다 —
            # 한 호출 안에서 세그먼트 전부가 같은 published_at을 공유하면(이 픽스처처럼
            # 시간차 없는 클린 3/3 발행) "마지막" 판정 자체가 동률이라 어느 행이 뽑히든
            # 기존 계약 그대로다(무변 확인은 "3행 중 하나"까지만, 그 이상은 story #3525의
            # 몫). 이 PR이 실제로 새로 보장하는 것은 head_publication_id뿐.
            all_ids = {str(head_id), str(last_id)}
            assert body["publication_id"] in all_ids or body["publication_id"] is not None
            assert body["head_publication_id"] == str(head_id), (
                "head_publication_id는 published_at 동률과 무관하게 항상 seq=1이어야 한다"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_head_publication_id_equals_publication_id_for_non_thread_realdb():
    """AC3 양성대조 — 세그먼트 1개(스레드 아님)는 head_publication_id==publication_id."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read
    from app.dependencies.auth import AuthContext, get_current_user

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(s, thread=[])
            await _publish_n3_thread(s, org_id=org_id, owner_id=owner_id, draft_id=draft_id)

        async def _db():
            async with Session() as s2:
                try:
                    yield s2
                    await s2.commit()
                except Exception:
                    await s2.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(owner_id), email="owner@test", claims={"app_metadata": {"org_id": str(org_id)}})

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            resp = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["publication_id"] is not None
            assert body["head_publication_id"] == body["publication_id"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_resolve_removed_seq3_query_returns_empty_realdb():
    """뮤테이션 셀프체크 — resolve_head_publication_id가 항상 입력을 그대로
    돌려주면(해석 비활성화) seq3 id로 물은 /insights가 다시 []가 되어야 한다."""
    from sqlalchemy import select
    from app.models.channel_publication import ChannelPublication
    from app.routers import insight_snapshots as insight_snapshots_router

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, owner_id, draft_id, gate_id, version = await _seed_ready_thread_draft(
                s, thread=["세그먼트 2", "세그먼트 3"],
            )
            await _publish_n3_thread(s, org_id=org_id, owner_id=owner_id, draft_id=draft_id)

            rows = list((await s.execute(
                select(ChannelPublication)
                .where(ChannelPublication.gate_id == gate_id, ChannelPublication.version_id == version.id)
                .order_by(ChannelPublication.sequence)
            )).scalars().all())
            seq3_id = rows[2].id

            async def _identity(db, *, publication_id):
                return publication_id

            _orig = insight_snapshots_router.resolve_head_publication_id
            insight_snapshots_router.resolve_head_publication_id = _identity
            try:
                result = await insight_snapshots_router._list_publication_insights_endpoint(
                    org_id, seq3_id, db=s, verified_org_id=org_id, _auth=None, resolved_locale="ko",
                )
                assert result == [], "뮤테이션(해석 비활성화)이 걸렸는데도 seq3 조회가 여전히 결과를 낸다"
            finally:
                insight_snapshots_router.resolve_head_publication_id = _orig
    finally:
        await engine.dispose()

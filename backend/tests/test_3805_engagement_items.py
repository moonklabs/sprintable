"""story #3805(Phase3·3-1·PR 1[BE], 페드루 PO 確定 2026-09-11·낱말 정정 08:14Z) —
「반응」(Engagement) 화면. 그라운딩 ①③④⑤ 그대로: org 단위 큐(GET .../engagement/items)
·배정/상태(PATCH)·연결별 수집 현황(GET .../engagement/collection-status)·「작업으로
전환」 양방향(linked_story_id). 상태 4번째 값은 `skipped`(ko 「넘김」·en Skipped).

세팅 헬퍼는 기존 댓글 계열 테스트(test_3516_channel_post_comments.py)와 동형 재사용
(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory
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


async def _seed_comment(
    session, *, org_id, publication_id, channel, triage_status="open", captured_at=None, text="댓글",
):
    from app.models.channel_post_comment import ChannelPostComment

    c = ChannelPostComment(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_comment_id=f"ext-{uuid.uuid4().hex[:8]}", text=text,
        text_sha256=uuid.uuid4().hex, captured_at=captured_at or datetime.now(timezone.utc),
        triage_status=triage_status,
    )
    session.add(c)
    await session.commit()
    return c


# ─── AC1 — 목록: 정렬(open 우선→captured_at desc)·필터·cursor 경계 ─────────────


@pytest.mark.anyio
async def test_list_sorts_open_before_others_then_captured_at_desc():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")

            # 순서(등재 시각)와 무관하게 open이 먼저, 같은 그룹 안에선 최신순.
            c_done_new = await _seed_comment(
                s, org_id=org_id, publication_id=pub.id, channel="threads",
                triage_status="done", captured_at=now,
            )
            c_open_old = await _seed_comment(
                s, org_id=org_id, publication_id=pub.id, channel="threads",
                triage_status="open", captured_at=now - timedelta(hours=2),
            )
            c_open_new = await _seed_comment(
                s, org_id=org_id, publication_id=pub.id, channel="threads",
                triage_status="open", captured_at=now - timedelta(hours=1),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?limit=50")
        assert r.status_code == 200, r.text
        ids = [item["id"] for item in r.json()["items"]]
        assert ids == [str(c_open_new.id), str(c_open_old.id), str(c_done_new.id)]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_cursor_pagination_no_overlap_no_gap():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")

            seeded = []
            for i in range(5):
                c = await _seed_comment(
                    s, org_id=org_id, publication_id=pub.id, channel="threads",
                    triage_status="open", captured_at=now - timedelta(minutes=i),
                )
                seeded.append(c.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?limit=2")
            assert r1.status_code == 200, r1.text
            body1 = r1.json()
            assert len(body1["items"]) == 2
            assert body1["has_more"] is True
            assert body1["next_cursor"] is not None

            r2 = await client.get(
                f"/api/v2/organizations/{org_id}/engagement/items?limit=2&cursor={body1['next_cursor']}"
            )
            assert r2.status_code == 200, r2.text
            body2 = r2.json()
            assert len(body2["items"]) == 2

        page1_ids = [item["id"] for item in body1["items"]]
        page2_ids = [item["id"] for item in body2["items"]]
        assert set(page1_ids).isdisjoint(page2_ids), "페이지 경계에서 중복/누락 없어야 함"
        all_ids = [str(x) for x in seeded]
        assert page1_ids == all_ids[:2]
        assert page2_ids == all_ids[2:4]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_filters_by_status_and_channel():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn_threads = await _seed_channel_connection(s, org_id, channel="threads")
            pub_threads = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn_threads.id, channel="threads",
            )
            conn_ig = await _seed_channel_connection(s, org_id, channel="instagram")
            pub_ig = await _seed_channel_publication(s, org_id=org_id, connection_id=conn_ig.id, channel="instagram")

            c_open_threads = await _seed_comment(
                s, org_id=org_id, publication_id=pub_threads.id, channel="threads", triage_status="open",
            )
            await _seed_comment(s, org_id=org_id, publication_id=pub_threads.id, channel="threads", triage_status="done")
            await _seed_comment(s, org_id=org_id, publication_id=pub_ig.id, channel="instagram", triage_status="open")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?status=open&channel=threads")
        assert r.status_code == 200, r.text
        ids = [item["id"] for item in r.json()["items"]]
        assert ids == [str(c_open_threads.id)]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_agent_key_can_read():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, _project_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items")
        assert r.status_code == 200, r.text
        assert len(r.json()["items"]) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC1 — PATCH: 4상태 전이·필드 생략/명시 null·에이전트 403·404 ──────────────


@pytest.mark.anyio
async def test_patch_transitions_through_four_statuses():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            for status in ("in_progress", "done", "skipped", "open"):
                r = await client.patch(
                    f"/api/v2/organizations/{org_id}/engagement/items/{comment.id}",
                    json={"triage_status": status},
                )
                assert r.status_code == 200, r.text
                assert r.json()["triage_status"] == status
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_invalid_status_is_422_and_unknown_value_not_persisted():
    """뮤테이션: 허용목록 검사를 걷으면 이 테스트가 200/오타 값 저장으로 RED가 된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{comment.id}",
                json={"triage_status": "resolved"},
            )
        assert r.status_code == 422, r.text

        async with Session() as s:
            from app.models.channel_post_comment import ChannelPostComment

            refreshed = await s.get(ChannelPostComment, comment.id)
            assert refreshed.triage_status == "open"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_assignee_set_then_explicit_null_clears_it():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            other_human = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{comment.id}",
                json={"assignee_member_id": str(other_human)},
            )
            assert r1.status_code == 200, r1.text
            # 생략 필드(triage_status)는 유지 — 응답에 open 그대로.
            assert r1.json()["triage_status"] == "open"

            r2 = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{comment.id}",
                json={"assignee_member_id": None},
            )
            assert r2.status_code == 200, r2.text
            assert r2.json()["assignee_member_id"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_agent_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, _project_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{comment.id}",
                json={"triage_status": "done"},
            )
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_unknown_comment_is_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{uuid.uuid4()}",
                json={"triage_status": "done"},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC1(⑤) — 연결별 수집 현황: null≠0 ──────────────────────────────────────


@pytest.mark.anyio
async def test_collection_status_null_for_never_captured_value_for_captured():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn_captured = await _seed_channel_connection(s, org_id, channel="threads")
            pub_captured = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn_captured.id, channel="threads",
            )
            conn_never = await _seed_channel_connection(s, org_id, channel="instagram")

            from app.models.channel_post_comment import CommentCollectionSchedule

            s.add(CommentCollectionSchedule(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub_captured.id, channel="threads",
                due_at=now, captured_at=now, status="captured",
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/collection-status")
        assert r.status_code == 200, r.text
        by_id = {c["connection_id"]: c for c in r.json()["connections"]}
        assert by_id[str(conn_captured.id)]["last_collected_at"] is not None
        assert by_id[str(conn_never.id)]["last_collected_at"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC2 — 「작업으로 전환」 양방향(linked_story_id) ────────────────────────


@pytest.mark.anyio
async def test_create_comment_follow_up_fills_linked_story_id():
    """뮤테이션: `comment.linked_story_id = new_story.id` 줄을 걷으면 이 assertion이
    RED가 된다(create_comment_follow_up이 story_id는 여전히 반환하므로 반환값만
    보는 테스트로는 못 잡는 자리 — comment 행 자체를 재조회해서 검증하는 이유)."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.channel_post_comment_replies import create_comment_follow_up

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")

            story = Story(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="원문 스토리",
                description="", status="in-review",
            )
            s.add(story)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="external_publish", status="approved",
            )
            s.add(gate)
            await s.commit()
            pub.gate_id = gate.id
            await s.commit()

            result = await create_comment_follow_up(
                s, org_id=org_id, comment_id=comment.id, title="[댓글] 후속", note=None,
                requested_by_member_id=owner_id,
            )
            new_story_id = result["story_id"]

        async with Session() as s:
            refreshed = await s.get(ChannelPostComment, comment.id)
            assert refreshed.linked_story_id == new_story_id
    finally:
        await engine.dispose()

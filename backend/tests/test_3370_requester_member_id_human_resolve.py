"""story #3370(유나 실측·페드루 정정 2026-09-10) — 「상신자 포함」(AC1)이 휴먼 상신에서
깨지던 결함의 회귀 pin. `auth.user_id`는 휴먼(JWT)이면 `users.id`다(auth.py:146 계약) —
org 멤버 id(org_member.id/team_member.id)가 아니다. 여러 라우터가 이 값을 **영속되는**
member-id 컬럼(author_member_id·created_by_member_id·requested_by_member_id)에 원시로
넣고 있었다 — site_posts.py:671과 같은 클래스가 site_posts.py 자신의 :356(페드루 2차
리뷰 지적, is_agent_caller 원시-id 조합이 boolean 체크뿐인 :298/:838과 달리 :356은
author_member_id를 실제로 영속한다)·channel_posts.py 계열 6곳·channel_post_comment_
replies.py 1곳·activity_logs.py EE RBAC 필터에 번져 있었다(전수 grep, PR 본문 참고).
전부 `resolve_member(auth, org_id, db)`(API키=team_member.id·JWT=org_member.id, auth.py
계약 그대로)로 정정 — 새 해소 기전 발명 0, 기존 site_posts.py 처방 재사용뿐.

기존 테스트가 전부 에이전트 상신만 다뤄 GREEN이었던 게 이 갭이다(에이전트는 auth.user_id
가 이미 team_member.id라 원시로 넘겨도 우연히 맞았다) — 이 파일은 **휴먼** 호출자로 같은
경로를 왕복해 정확히 그 자리만 잰다.

세팅 헬퍼는 test_3374_channel_posts.py(channel_posts 계열)·test_3516_comment_reply.py
(comment reply 계열) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3374_channel_posts import (
    _client_for,
    _draft_body,
    _seed_connection,
    _seed_default_role,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)
from tests.test_3367_site_post_submit_gate_seal import (
    _draft_body as _site_draft_body,
)

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


async def _seed_human_org_member(session, org_id, *, role="owner"):
    """test_3374_channel_posts.py::_seed_human과 동형(role 기본만 owner — 이 파일의
    관심사는 authz가 아니라 member-id 축 정합이라 project 접근권 갭에 안 걸리게)."""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id, om.id


@pytest.mark.anyio
async def test_submit_channel_post_draft_human_requester_resolves_to_org_member_id():
    """뮤테이션 대상 — submit_channel_post_draft_endpoint의 resolve_member() 호출을
    `uuid.UUID(auth.user_id)` 원시값으로 되돌리면 이 테스트가 RED여야 한다(gate.
    neutral_facts.requested_by_member_id가 org_member.id가 아니라 users.id로 떨어짐)."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            user_id, org_member_id = await _seed_human_org_member(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 200, r_submit.text
        gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(gate_id)))).scalar_one()
        # 상신자는 org_member.id로 봉인돼야 한다 — users.id(user_id)와는 반드시 달라야
        # (OrgMember.id는 User.id와 별도 uuid로 발급된다) 이 회귀가 정확히 잡힌다.
        assert gate.neutral_facts["requested_by_member_id"] == str(org_member_id)
        assert gate.neutral_facts["requested_by_member_id"] != str(user_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_post_channel_post_draft_version_human_author_resolves_to_org_member_id():
    """뮤테이션 대상 — post_channel_post_draft_version의 resolve_member() 호출을 되돌리면
    RED(ChannelPostVersion.author_member_id가 users.id로 떨어짐)."""
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human_org_member(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
        assert r_draft.status_code == 201, r_draft.text
        payload = r_draft.json()
        assert payload["author_kind"] == "human"
        version_id = payload["version_id"]

        async with Session() as s:
            version = (
                await s.execute(select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(version_id)))
            ).scalar_one()
        assert version.author_member_id == org_member_id
        assert version.author_member_id != user_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_post_site_post_draft_version_human_author_resolves_to_org_member_id():
    """뮤테이션 대상 — post_site_post_draft_version의 resolve_member_db_verified() 호출을
    되돌리면 RED(SitePostVersion.author_member_id가 users.id로 떨어짐). 페드루 2차 리뷰
    지적(2026-09-10) — channel_posts.py 형제는 고쳤으나 site_posts.py 자신의 :356이
    빠져 있었다."""
    from app.main import app
    from app.models.site_post_version import SitePostVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human_org_member(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_site_draft_body(work_item_id=story_id),
            )
        assert r_draft.status_code == 201, r_draft.text
        payload = r_draft.json()
        assert payload["author_kind"] == "human"
        version_id = payload["version_id"]

        async with Session() as s:
            version = (
                await s.execute(select(SitePostVersion).where(SitePostVersion.id == uuid.UUID(version_id)))
            ).scalar_one()
        assert version.author_member_id == org_member_id
        assert version.author_member_id != user_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_comment_reply_draft_human_author_resolves_to_org_member_id():
    """뮤테이션 대상 — create_comment_reply_draft_endpoint의 resolve_member() 호출을
    되돌리면 RED(CommentReply.created_by_member_id가 users.id로 떨어짐)."""
    from app.main import app
    from app.models.channel_post_comment import ChannelPostComment, ChannelPostCommentReply
    from sqlalchemy import select
    import hashlib
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human_org_member(s, org_id)
            text = "원 댓글"
            comment = ChannelPostComment(
                id=uuid.uuid4(), org_id=org_id, publication_id=uuid.uuid4(), channel="sandbox",
                external_comment_id="c1", author_display_name="user1", text=text,
                text_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                external_created_at=datetime.now(timezone.utc), captured_at=datetime.now(timezone.utc), raw={},
            )
            s.add(comment)
            await s.commit()
            comment_id = comment.id

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r_reply = await client.post(
                f"/api/v2/organizations/{org_id}/comments/{comment_id}/replies", json={"text": "답변 초안"},
            )
        assert r_reply.status_code == 201, r_reply.text
        reply_id = r_reply.json()["id"]

        async with Session() as s:
            reply = (
                await s.execute(
                    select(ChannelPostCommentReply).where(ChannelPostCommentReply.id == uuid.UUID(reply_id))
                )
            ).scalar_one()
        assert reply.created_by_member_id == org_member_id
        assert reply.created_by_member_id != user_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_activity_logs_ee_rbac_filters_grant_only_human_member_to_own_actor_id():
    """유나 라이브 재현(2026-09-10) — activity_logs.py의 EE RBAC 필터가 `TeamMember.id
    == auth.user_id`로 caller를 직접 조회했다. grant-only 휴먼(org_member 경유, 레거시
    TeamMember 행 없음)은 이 조회가 항상 None이라 `ee_applied`가 False로 남아 role=
    member 축의 「본인 행위만」 필터가 **통째로 스킵**됐다(org 전체 flat 로그 노출 —
    fail-open 권한 무력화).

    `_ee_rbac_filter`는 모듈 최상단에서 `settings.is_ee_enabled`(license_consent 환경
    변수) 시에만 로드된다 — 로컬 pytest 프로세스가 그 값 없이 이미 import됐을 수 있어,
    라이선스 게이트를 우회해 실 필터 함수(`ee.services.audit_rbac.filter_activity_by_
    role`)를 직접 monkeypatch로 꽂는다(정정 대상 로직 자체는 그대로 — 게이트만 우회).

    뮤테이션 대상 — activity_logs.py의 resolve_member() 호출을 되돌려 `TeamMember.id ==
    auth.user_id` 직접조회로 복구하면 이 테스트가 RED여야 한다(member 역할 휴먼이 다른
    사람의 activity까지 봄)."""
    from app.main import app
    from app.services.activity_log import ActivityLogService
    from app.dependencies.auth import AuthContext, get_current_user
    from ee.services.audit_rbac import filter_activity_by_role
    import app.routers.activity_logs as activity_logs_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            # grant-only 휴먼(member 역할) — 레거시 TeamMember 행 없음(핵심 조건).
            member_user_id, member_org_member_id = await _seed_human_org_member(s, org_id, role="member")
            other_user_id, other_org_member_id = await _seed_human_org_member(s, org_id, role="member")

            # 두 사람의 activity를 각자 이름으로 기록 — member 필터가 실제로 걸러내는지
            # 관측하려면 caller 자신의 행위 vs 남의 행위가 둘 다 있어야 한다.
            log_service = ActivityLogService(s)
            await log_service.record(
                org_id=org_id, action="story_created", actor_id=member_org_member_id, actor_type="human",
            )
            await log_service.record(
                org_id=org_id, action="story_created", actor_id=other_org_member_id, actor_type="human",
            )
            await s.commit()

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(
                user_id=str(member_user_id), email="caller@test",
                claims={"app_metadata": {"org_id": str(org_id)}},
            )

        from tests.conftest import override_db_and_read
        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth

        from unittest.mock import patch
        try:
            with patch.object(activity_logs_mod, "_ee_rbac_filter", filter_activity_by_role):
                from httpx import AsyncClient, ASGITransport
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                    resp = await client.get("/api/v2/activity-logs")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            actor_ids = {item["actor_id"] for item in body["items"]}
            # member 역할은 본인 행위만 — 남(other_org_member_id)의 행이 안 보여야 한다.
            assert actor_ids == {str(member_org_member_id)}
            assert str(other_org_member_id) not in actor_ids
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()

"""story #2349 AC3 — 1:1 사용자 차단(user_blocks). Play UGC 정책이 요구하는 block.

실측(2026-08-02, 디디, 스레드 7256d5cc): PO 원계약("team_members.id로 FK")은 실행 불가였다 —
`team_members`가 실제로는 VIEW(members ⋈ project_access)라 FK 제약을 못 건다(프레시 DB 마이그
시도 → "referenced relation team_members is not a table"로 실패, 이 파일 작성 前에 실측).
`ConversationParticipant.member_id`와 동일 패턴(ORM엔 FK 선언, 실 DB엔 없음)으로 맞췄다 — 값의
출처는 team_members.id(=members.id) 그대로, 실 제약만 없다. PO 정정 승인 후 진행.

커버:
  ①user_blocks CRUD(POST/DELETE/GET) — 자기차단 거부·cross-org 404·idempotent·조회 orphan 필터
  ②_msg_payload.is_blocked_sender — 읽기 경로(list_messages/get_message)에서 차단 여부 반영
  ③알림 감산 — conversations.py::send_message의 3개 제외 체인(SSE dispatch·mention_targets·
    candidate_targets)이 차단한 수신자에게 알림을 안 보낸다(실 HTTP POST로 실증)

send_message 배달 경로 «전수» (2026-08-03, 카디르 QA 뮤테이션 재발견 후 정정):
  ①Event/SSE          events 테이블                     → test_blocker_gets_no_notification_for_blocked_sender_plain_message·
                                                            test_blocker_gets_no_notification_for_blocked_sender_mention(둘 다 events 직접 쿼리)
  ②webhook targets    conversation_webhook_deliveries   → test_send_message_webhook_delivery_excludes_blocker
  ③인앱 알림          notifications                      → test_blocker_gets_no_notification_for_blocked_sender_plain_message
  ④ws 브로드캐스트     «테이블 없음»(순수 인메모리 WS)    → test_send_message_ws_chat_broadcast_excludes_blocker

⛔inbox_items는 이 표에 «없다» — InboxItem 생성자 호출이 코드베이스 전체 0건(에이전트 의사결정용
별개 기능, grep 확認).
⭐⭐「저장소 축(DB를 훑는 법)」은 ④를 «원리상 못 본다» — DB row를 안 남기는지라. ④는 «코드 축
(호출 그래프)»으로만 보인다 — 두 축이 서로의 사각을 덮는다.
⛔send_message에 dispatch를 더하면 이 표에 «줄을 먼저 더하라».
⛔표에 «이름만» 거는 것을 조심 — 각 줄은 「그 테스트가 «그 저장소»를 실제로 쿼리하는가」로
검산한다(카디르 뮤테이션: ①의 user_blocker_ids exclusion을 죽여도 처음엔 0/18 RED였다 — 이름만
걸려 있고 실제로 events 테이블을 쿼리하는 assertion이 없었기 때문. 지금은 events를 직접
쿼리하고, 뮤테이션으로 정확히 그 테스트만 RED가 되는 것까지 재확認했다).

⚠️events=0을 「차단이 먹었다」로 읽지 말 것 — 수신자가 webhook 커버면 SSE는 skip되어(E-EVENT-
1CONFIG, webhook_covered_ids) events는 «원래» 0이다. 실측(2026-08-03, 페드루, dev DB 직접
조회): 차단 中 발송 두 건(be57a797·d8745bca) 모두 events=0·webhook_deliveries=1 — events=0은
차단의 증거가 아니라 그 수신자가 애초에 webhook 채널로 커버된다는 뜻일 뿐이다. 양성대조(차단
없는 메시지 3건: 45fe87f7 events=0/webhook=1, 215ea7c1 events=1/webhook=0, 3febd22a events=0/
webhook=1)가 events↔webhook 배타 관계(둘 중 하나만 1)를 보여준다 — 라이브 재검증 1차에서
「events/pending 0건 → 차단이 막혔다」로 읽은 판단이 바로 이 오독이었다. 차단 여부는 반드시
webhook_deliveries로 재라.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _add_message,
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _revoke_project_access(session, member_id, project_id):
    """멤버를 org에서 「빠진 것처럼」 만든다 — user_blocks 조회 orphan-필터 테스트용.
    team_members VIEW는 project_access join이라 이 행을 지우면 그 멤버가 뷰에서 사라진다."""
    from sqlalchemy import delete
    from app.models.project_access import ProjectAccess
    await session.execute(delete(ProjectAccess).where(
        ProjectAccess.member_id == member_id, ProjectAccess.project_id == project_id,
    ))
    await session.commit()


# ═══════════════════════════════════════════════════════════════════════════
# ① user_blocks CRUD
# ═══════════════════════════════════════════════════════════════════════════

async def test_create_user_block_success():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, _ = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                resp = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)})
            app.dependency_overrides.clear()

            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["blocker_member_id"] == str(a_id)
            assert body["blocked_member_id"] == str(b_id)
    finally:
        await engine.dispose()


async def test_create_user_block_self_400():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                resp = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(a_id)})
            app.dependency_overrides.clear()

            assert resp.status_code == 400, resp.text
    finally:
        await engine.dispose()


async def test_create_user_block_cross_org_404():
    """IDOR — 다른 org 멤버를 차단 대상으로 지정하면 404(존재 자체를 노출하지 않는다)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org_a = await _make_org(session)
            project_a = await _make_project(session, org_a.id)
            a_id, a_user = await _make_human_member(session, org_a.id, project_a.id)

            org_b = await _make_org(session)
            project_b = await _make_project(session, org_b.id)
            b_id, _ = await _make_human_member(session, org_b.id, project_b.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org_a.id)
            async with _client_for(app) as client:
                resp = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)})
            app.dependency_overrides.clear()

            assert resp.status_code == 404, resp.text
    finally:
        await engine.dispose()


async def test_create_user_block_idempotent():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, _ = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                first = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)})
                second = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)})
            app.dependency_overrides.clear()

            assert first.status_code == 201
            assert second.status_code == 201
            assert first.json()["id"] == second.json()["id"]

            from sqlalchemy import func, select
            from app.models.user_block import UserBlock
            async with Session() as session:
                count = (await session.execute(
                    select(func.count()).select_from(UserBlock).where(UserBlock.blocker_member_id == a_id)
                )).scalar_one()
            assert count == 1, "중복 POST가 새 행을 만들면 안 됨(UNIQUE 위반 대신 기존 행 반환)"
    finally:
        await engine.dispose()


async def test_delete_user_block_and_idempotent():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, _ = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)})
                first_delete = await client.delete(f"/api/v2/user-blocks/{b_id}")
                second_delete = await client.delete(f"/api/v2/user-blocks/{b_id}")
                listing = await client.get("/api/v2/user-blocks")
            app.dependency_overrides.clear()

            assert first_delete.status_code == 204
            assert second_delete.status_code == 204, "존재하지 않는 것을 다시 지워도 에러 아님(idempotent)"
            assert listing.json() == []
    finally:
        await engine.dispose()


async def test_delete_user_block_cannot_delete_other_callers_block():
    """authz coverage 가드(id-mutation 축)의 allowlist 등재 근거 — DELETE /user-blocks/{member_id}는
    path의 member_id가 「내가 지울 대상(blocked)」이지 「지울 행을 소유한 사람」이 아니다. WHERE
    절이 항상 blocker_member_id=caller로 스코프되므로, b가 a의 차단행을 member_id로 지정해
    지우려 해도 그건 b 자신의(존재하지 않는) 차단행을 지우는 것으로 해석돼 a의 행은 살아남는다
    — cross-user 삭제가 원리적으로 불가능(구조적 self-scope, project 접근권 검증이 필요 없는
    이유)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, b_user = await _make_human_member(session, org.id, project.id)
            c_id, _ = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(c_id)})
            app.dependency_overrides.clear()

            # b가 a의 차단행을 지우려 시도 — path엔 c_id(a가 차단한 대상)를 넣어 봄.
            await _setup_app_human(app, Session, b_user, org.id)
            async with _client_for(app) as client:
                cross_delete = await client.delete(f"/api/v2/user-blocks/{c_id}")
            app.dependency_overrides.clear()
            assert cross_delete.status_code == 204  # no-op(b 소유 행이 애초에 없음) — 에러 아님, 하지만도 안 지움

            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                a_listing = await client.get("/api/v2/user-blocks")
            app.dependency_overrides.clear()
            assert len(a_listing.json()) == 1, "b의 시도가 a의 차단행을 지웠으면 안 됨(cross-user 삭제 불가 실증)"
    finally:
        await engine.dispose()


async def test_list_user_blocks_scoped_to_caller():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, b_user = await _make_human_member(session, org.id, project.id)
            c_id, _ = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(c_id)})
            app.dependency_overrides.clear()

            # b는 아무도 차단 안 함 — b의 목록은 비어야 함(a의 차단이 안 새야 함)
            await _setup_app_human(app, Session, b_user, org.id)
            async with _client_for(app) as client:
                resp = await client.get("/api/v2/user-blocks")
            app.dependency_overrides.clear()

            assert resp.json() == []
    finally:
        await engine.dispose()


async def test_list_user_blocks_filters_orphan_member():
    """PO 판정(2026-08-02) ① — 실 FK가 없어 멤버가 조직에서 빠져도 user_blocks 행은 고아로
    남는다. 정리는 안 하되 조회에서는 거른다(지금 org에 실존하는 멤버만 목록에 뜬다)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, _ = await _make_human_member(session, org.id, project.id)

            from app.main import app
            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                create_resp = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)})
                before = await client.get("/api/v2/user-blocks")
            app.dependency_overrides.clear()
            assert create_resp.status_code == 201
            assert len(before.json()) == 1

            async with Session() as session:
                await _revoke_project_access(session, b_id, project.id)

            await _setup_app_human(app, Session, a_user, org.id)
            async with _client_for(app) as client:
                after = await client.get("/api/v2/user-blocks")
            app.dependency_overrides.clear()
            assert after.json() == [], "멤버가 org에서 빠졌으면 목록에서 안 보여야 함(고아 행은 남되 안 보임)"

            from sqlalchemy import func, select
            from app.models.user_block import UserBlock
            async with Session() as session:
                row_still_exists = (await session.execute(
                    select(func.count()).select_from(UserBlock).where(UserBlock.blocked_member_id == b_id)
                )).scalar_one()
            assert row_still_exists == 1, "행 자체는 고아로 남아야 함(정리는 이 스토리 스코프 밖)"
    finally:
        await engine.dispose()


# ═══════════════════════════════════════════════════════════════════════════
# ② _msg_payload.is_blocked_sender — 읽기 경로
# ═══════════════════════════════════════════════════════════════════════════

async def test_get_messages_marks_is_blocked_sender_true_when_blocked():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            viewer_id, viewer_user = await _make_human_member(session, org.id, project.id)
            sender_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [viewer_id, sender_id], viewer_id)
            await _add_message(session, conv_id, sender_id, "hello", datetime.now(timezone.utc))

            from app.main import app
            await _setup_app_human(app, Session, viewer_user, org.id)
            async with _client_for(app) as client:
                await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)})
                resp = await client.get(f"/api/v2/conversations/{conv_id}/messages")
            app.dependency_overrides.clear()

            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["is_blocked_sender"] is True
            # tombstone(#2319)과 다르다 — 마스킹이지 삭제가 아니므로 content는 여전히 내려온다.
            assert data[0]["content"] == "hello"
    finally:
        await engine.dispose()


async def test_get_messages_is_blocked_sender_false_when_not_blocked():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            viewer_id, viewer_user = await _make_human_member(session, org.id, project.id)
            sender_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [viewer_id, sender_id], viewer_id)
            await _add_message(session, conv_id, sender_id, "hi", datetime.now(timezone.utc))

            from app.main import app
            await _setup_app_human(app, Session, viewer_user, org.id)
            async with _client_for(app) as client:
                resp = await client.get(f"/api/v2/conversations/{conv_id}/messages")
            app.dependency_overrides.clear()

            data = resp.json()["data"]
            assert data[0]["is_blocked_sender"] is False
    finally:
        await engine.dispose()


async def test_get_message_single_marks_is_blocked_sender():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            viewer_id, viewer_user = await _make_human_member(session, org.id, project.id)
            sender_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [viewer_id, sender_id], viewer_id)
            msg = await _add_message(session, conv_id, sender_id, "single", datetime.now(timezone.utc))

            from app.main import app
            await _setup_app_human(app, Session, viewer_user, org.id)
            async with _client_for(app) as client:
                await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)})
                resp = await client.get(f"/api/v2/conversations/{conv_id}/messages/{msg.id}")
            app.dependency_overrides.clear()

            assert resp.json()["is_blocked_sender"] is True
    finally:
        await engine.dispose()


# ═══════════════════════════════════════════════════════════════════════════
# ③ 알림 감산 — 실 HTTP POST(send_message)로 실증
# ═══════════════════════════════════════════════════════════════════════════

async def _notification_count_for(session, user_id, event_type):
    from sqlalchemy import func, select
    from app.models.notification import Notification
    return (await session.execute(
        select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id, Notification.type == event_type,
        )
    )).scalar_one()


async def _event_count_for(session, recipient_id, event_type):
    """카디르 QA 뮤테이션 재발견(2026-08-03) — ①Event/SSE 자리는 표에 테스트 «이름만» 걸려
    있었다(그 테스트는 Notification만 보고 events는 안 봄, _dispatch_conversation_event의
    user_blocker_ids exclusion을 죽여도 0/18 RED였다). 이 헬퍼로 events 테이블을 직접 쿼리한다."""
    from sqlalchemy import func, select
    from app.models.event import Event
    return (await session.execute(
        select(func.count()).select_from(Event).where(
            Event.recipient_id == recipient_id, Event.event_type == event_type,
        )
    )).scalar_one()


async def test_blocker_gets_no_notification_for_blocked_sender_plain_message():
    """candidate_targets 축(conversation.message 알림) — 차단한 발신자의 평범한 메시지에는
    알림이 안 간다. 양성대조로 미차단 3자는 정상 수신하는지도 같은 사건에서 본다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_id, blocker_user = await _make_human_member(session, org.id, project.id)
            other_id, other_user = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [blocker_id, other_id, sender_id], sender_id,
            )

        from app.main import app
        await _setup_app_human(app, Session, blocker_user, org.id)
        async with _client_for(app) as client:
            block_resp = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)})
        app.dependency_overrides.clear()
        assert block_resp.status_code == 201

        await _setup_app_human(app, Session, sender_user, org.id)
        async with _client_for(app) as client:
            send_resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages", json={"content": "plain message, no mention"},
            )
        app.dependency_overrides.clear()
        assert send_resp.status_code == 201, send_resp.text

        async with Session() as session:
            blocker_count = await _notification_count_for(session, blocker_user, "conversation.message")
            other_count = await _notification_count_for(session, other_user, "conversation.message")
        assert blocker_count == 0, "차단한 발신자의 메시지 알림이 갔음 — 감산 실패"
        assert other_count == 1, "미차단 3자는 정상 수신해야 함(양성대조 — 전체가 죽은 게 아님을 확認)"

        # ①Event/SSE 자리 — _dispatch_conversation_event의 user_blocker_ids exclusion을 events
        # 테이블에서 직접 검산(카디르 QA 뮤테이션 재발견, 위 Notification assertion만으로는 이
        # 지점을 안 지켰다: 그 exclusion을 죽여도 이 테스트를 포함한 18건 전부 GREEN이었다).
        async with Session() as session:
            blocker_events = await _event_count_for(session, blocker_id, "conversation.message_created")
            other_events = await _event_count_for(session, other_id, "conversation.message_created")
        assert blocker_events == 0, "차단한 발신자의 메시지 Event가 남음 — _dispatch_conversation_event 감산 실패"
        assert other_events == 1, "미차단 3자는 Event도 정상 생성돼야 함(양성대조)"
    finally:
        await engine.dispose()


async def test_blocker_gets_no_notification_for_blocked_sender_mention():
    """mention_targets 축(conversation.mention 알림 + SSE) — 차단한 발신자가 나를 멘션해도
    알림이 안 간다. other_id를 같이 멘션해 events 테이블 양성대조까지 같은 사건에서 본다
    (카디르 QA 뮤테이션 재발견 — _dispatch_mention_events도 events를 직접 쿼리해 검산)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_id, blocker_user = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [blocker_id, other_id, sender_id], sender_id,
            )

        from app.main import app
        await _setup_app_human(app, Session, blocker_user, org.id)
        async with _client_for(app) as client:
            block_resp = await client.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)})
        app.dependency_overrides.clear()
        assert block_resp.status_code == 201

        await _setup_app_human(app, Session, sender_user, org.id)
        async with _client_for(app) as client:
            send_resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": "hey @you @other", "mentioned_ids": [str(blocker_id), str(other_id)]},
            )
        app.dependency_overrides.clear()
        assert send_resp.status_code == 201, send_resp.text

        async with Session() as session:
            mention_count = await _notification_count_for(session, blocker_user, "conversation.mention")
        assert mention_count == 0, "차단한 발신자의 멘션 알림이 갔음 — 감산 실패(mention_targets 축)"

        # ①Event/SSE 형제 경로(_dispatch_mention_events) — events 테이블 직접 검산.
        async with Session() as session:
            blocker_mention_events = await _event_count_for(session, blocker_id, "conversation:mention")
            other_mention_events = await _event_count_for(session, other_id, "conversation:mention")
        assert blocker_mention_events == 0, "차단한 발신자의 멘션 Event가 남음 — _dispatch_mention_events 감산 실패"
        assert other_mention_events == 1, "미차단 3자는 멘션 Event도 정상 생성돼야 함(양성대조)"
    finally:
        await engine.dispose()


async def test_unblocked_sender_mention_still_notifies():
    """음성대조 — 차단하지 않은 발신자의 멘션은 정상적으로 알림이 간다(감산 로직이 전체를
    죽이지 않았는지)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            viewer_id, viewer_user = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [viewer_id, sender_id], sender_id)

        from app.main import app
        await _setup_app_human(app, Session, sender_user, org.id)
        async with _client_for(app) as client:
            send_resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": "hey @you", "mentioned_ids": [str(viewer_id)]},
            )
        app.dependency_overrides.clear()
        assert send_resp.status_code == 201, send_resp.text

        async with Session() as session:
            mention_count = await _notification_count_for(session, viewer_user, "conversation.mention")
        assert mention_count == 1
    finally:
        await engine.dispose()


# ═══════════════════════════════════════════════════════════════════════════
# ④ route_message(channel_router.py) — webhook/채널 결정 축 (2026-08-03 라이브에서 발견된 갭)
#
# 실측(PO+디디, 라이브, 스레드 7256d5cc): send_message의 user_blocker_ids exclusion은
# _dispatch_conversation_event/mention_targets/candidate_targets 3곳만 잡았고, route_message는
# 별개 쿼리로 recipient_ids를 다시 뽑아 그 exclusion이 안 닿았다 — webhook-covered 수신자
# (에이전트 대다수의 실제 수신 경로)에게는 차단이 «전혀 안 먹는» 상태로 머지됐었다. 이 절이
# 그 갭을 직접 재현·고정한다.
# ═══════════════════════════════════════════════════════════════════════════

async def test_route_message_excludes_recipient_who_blocked_sender():
    """route_message가 발신자를 차단한 수신자를 decisions에서 뺀다(discord든 sse든 무관 —
    recipient_ids 상류 한 곳에서 걸러지므로 채널 무관하게 빠져야 한다)."""
    from app.services.channel_router import route_message

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_id, _ = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)
            sender_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [blocker_id, other_id, sender_id], sender_id,
            )
            msg = await _add_message(session, conv_id, sender_id, "hello", datetime.now(timezone.utc))

            from app.models.user_block import UserBlock
            session.add(UserBlock(id=uuid.uuid4(), blocker_member_id=blocker_id, blocked_member_id=sender_id))
            await session.commit()

        async with Session() as session:
            decisions = await route_message(msg.id, session)

        decided_ids = {d.member_id for d in decisions}
        assert blocker_id not in decided_ids, "차단한 수신자가 route_message decisions에 남아 있음 — #2349 갭 재발"
        assert other_id in decided_ids, "차단 안 한 3자까지 같이 빠짐(양성대조 실패 — 전체가 죽은 것)"
    finally:
        await engine.dispose()


async def test_route_message_no_block_all_recipients_present():
    """양성대조 — 차단 관계가 전혀 없으면 route_message가 참가자 전원을 그대로 낸다."""
    from app.services.channel_router import route_message

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, _ = await _make_human_member(session, org.id, project.id)
            b_id, _ = await _make_human_member(session, org.id, project.id)
            sender_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [a_id, b_id, sender_id], sender_id)
            msg = await _add_message(session, conv_id, sender_id, "hi all", datetime.now(timezone.utc))

        async with Session() as session:
            decisions = await route_message(msg.id, session)

        assert {d.member_id for d in decisions} == {a_id, b_id}
    finally:
        await engine.dispose()


# ═══════════════════════════════════════════════════════════════════════════
# ⑤ 실 webhook 배달 SSOT(resolve_conversation_webhook_targets) + ws_chat WS 브로드캐스트
#
# 라이브 재검증(2026-08-03, PO+디디, 스레드 7256d5cc) 후속 — ④(route_message)를 고친 뒤에도
# 실 agent 게이트웨이 webhook 배달(ConversationWebhookDelivery의 SSOT인
# conversation_webhook.py::resolve_conversation_webhook_targets)엔 exclusion이 안 걸려
# 있었다(디디 발견) + ws_chat WebSocket 브로드캐스트(agent 참가자 room에 msg.content 원문
# 실시간 전달)도 필터가 아예 없었다(카디르 QA 재발견). 둘 다 실 HTTP POST(send_message)로
# 직접 재현·고정한다.
# ═══════════════════════════════════════════════════════════════════════════

async def test_send_message_webhook_delivery_excludes_blocker():
    """resolve_conversation_webhook_targets가 실제 webhook 배달 대상에서 sender를 차단한
    수신자를 뺀다 — send_message가 자체 계산한 webhook_targets를 통해 실증(HTTP POST 경유)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_agent = await _make_agent_member(session, org.id, project.id)
            other_agent = await _make_agent_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [blocker_agent, other_agent, sender_id], sender_id,
            )
            from app.models.user_block import UserBlock
            session.add(UserBlock(id=uuid.uuid4(), blocker_member_id=blocker_agent, blocked_member_id=sender_id))
            await session.commit()

            from app.models.webhook_config import WebhookConfig
            session.add(WebhookConfig(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, member_id=blocker_agent,
                url=f"https://example.invalid/{uuid.uuid4()}", is_active=True, events=["conversation.message_created"],
            ))
            session.add(WebhookConfig(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, member_id=other_agent,
                url=f"https://example.invalid/{uuid.uuid4()}", is_active=True, events=["conversation.message_created"],
            ))
            await session.commit()

        captured: list = []

        async def _fake_deliver(*args, **kwargs):
            captured.append(kwargs.get("targets"))

        from app.services import conversation_webhook as conversation_webhook_module
        original_deliver = conversation_webhook_module.deliver_conversation_message_webhook
        conversation_webhook_module.deliver_conversation_message_webhook = _fake_deliver
        # conversations.py는 함수 내부에서 `from app.services.conversation_webhook import
        # deliver_conversation_message_webhook`을 매 호출 직전 새로 임포트하므로(top-level
        # 캐시 없음) 모듈 속성만 바꿔도 background_tasks.add_task가 이 fake를 받는다.
        try:
            from app.main import app
            await _setup_app_human(app, Session, sender_user, org.id)
            async with _client_for(app) as client:
                send_resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages", json={"content": "webhook 배달 실증"},
                )
            app.dependency_overrides.clear()
            assert send_resp.status_code == 201, send_resp.text
        finally:
            conversation_webhook_module.deliver_conversation_message_webhook = original_deliver

        assert captured, "deliver_conversation_message_webhook이 호출 안 됨 — 테스트 배선 확認 필요"
        target_member_ids = {t.member_id for t in captured[0]}
        assert blocker_agent not in target_member_ids, "sender를 차단한 수신자의 webhook이 배달 대상에 남음"
        assert other_agent in target_member_ids, "차단 안 한 agent까지 같이 빠짐(양성대조 실패)"
    finally:
        await engine.dispose()


async def test_send_message_ws_chat_broadcast_excludes_blocker():
    """ws_chat WebSocket 브로드캐스트(agent room에 msg.content 원문 실시간 전달)가 sender를
    차단한 agent 수신자를 뺀다 — _rooms/_broadcast를 실 WebSocket 없이 in-process로 실증
    (모듈 전역 dict·함수라 conversations.py의 지연 import가 같은 객체를 참조한다)."""
    from unittest.mock import AsyncMock

    from app.routers import ws_chat as ws_chat_module

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_agent = await _make_agent_member(session, org.id, project.id)
            other_agent = await _make_agent_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [blocker_agent, other_agent, sender_id], sender_id,
            )
            from app.models.user_block import UserBlock
            session.add(UserBlock(id=uuid.uuid4(), blocker_member_id=blocker_agent, blocked_member_id=sender_id))
            await session.commit()

        blocker_key, other_key = str(blocker_agent), str(other_agent)
        ws_chat_module._rooms[blocker_key] = {object()}
        ws_chat_module._rooms[other_key] = {object()}
        original_broadcast = ws_chat_module._broadcast
        ws_chat_module._broadcast = AsyncMock()
        try:
            from app.main import app
            await _setup_app_human(app, Session, sender_user, org.id)
            async with _client_for(app) as client:
                send_resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages", json={"content": "ws 브로드캐스트 실증"},
                )
            app.dependency_overrides.clear()
            assert send_resp.status_code == 201, send_resp.text

            broadcast_targets = {call.args[0] for call in ws_chat_module._broadcast.call_args_list}
            assert blocker_key not in broadcast_targets, "sender를 차단한 agent의 room에 WS 브로드캐스트가 감"
            assert other_key in broadcast_targets, "차단 안 한 agent까지 같이 빠짐(양성대조 실패)"
        finally:
            ws_chat_module._broadcast = original_broadcast
            ws_chat_module._rooms.pop(blocker_key, None)
            ws_chat_module._rooms.pop(other_key, None)
    finally:
        await engine.dispose()

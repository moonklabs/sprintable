"""S37: conversations 테이블 + Chat API 전환 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
CONV_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_member(
    member_id: uuid.UUID = MEMBER_ID, member_type: str = "human", avatar_url: str | None = None,
) -> MagicMock:
    m = MagicMock()
    m.id = member_id
    m.name = "테스트 멤버"
    m.type = member_type
    m.org_id = ORG_ID
    m.user_id = uuid.uuid4()
    m.avatar_url = avatar_url
    return m


def _make_conv(conv_id: uuid.UUID = CONV_ID, conv_type: str = "group") -> MagicMock:
    c = MagicMock()
    c.id = conv_id
    c.org_id = ORG_ID
    c.project_id = PROJECT_ID
    c.type = conv_type
    c.title = "테스트 대화"
    c.created_by = MEMBER_ID
    c.updated_at = datetime(2026, 5, 14, tzinfo=timezone.utc)
    return c


def _make_msg(msg_id: uuid.UUID | None = None) -> MagicMock:
    m = MagicMock()
    m.id = msg_id or uuid.uuid4()
    m.conversation_id = CONV_ID
    m.sender_id = MEMBER_ID
    m.content = "테스트 메시지"
    m.mentioned_ids = []
    m.created_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    return m




@pytest.fixture(autouse=True)
def _skip_agent_policy(monkeypatch):
    """기존 conversations 테스트는 에이전트 인가 불변식을 별도 테스트에서 검증 — 여기서 skip."""
    async def _noop(*args, **kwargs):
        pass
    monkeypatch.setattr("app.routers.conversations._enforce_agent_creator_policy", _noop)

async def _make_client(session=None):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    if session is None:
        session = AsyncMock()
        session.add = MagicMock()
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = AsyncMock()
        nested_cm = AsyncMock()
        nested_cm.__aenter__ = AsyncMock(return_value=None)
        nested_cm.__aexit__ = AsyncMock(return_value=False)
        session.begin_nested = MagicMock(return_value=nested_cm)

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def _db():
        yield session

    async def _auth():
        return ctx

    async def _org():
        return ORG_ID

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), session, app


# ─── e2608901: 알림 카피 summary 생성 ────────────────────────────────────────

def test_build_message_summary_formats():
    from app.routers.conversations import _build_message_summary as f
    # 정상: "{발신자}: {내용}"
    assert f("Hello team", "디디", False) == "디디: Hello team"
    # 80자 초과 → 절삭 + … (이름+": " 접두 제외 본문만 80)
    long = f("x" * 100, "A", False)
    assert long.startswith("A: ") and long.endswith("…") and len(long.split(": ", 1)[1]) == 81
    # 개행/연속공백 정규화
    assert f("line1\n\nline2   x", "D", False) == "D: line1 line2 x"
    # 내용 없음 + 첨부 → 📎 마커
    assert f("", "B", True) == "B: 📎"
    # 내용 없음 + 첨부 없음 → 발신자명만 (raw event_type 노출 방지)
    assert f("", "C", False) == "C"
    # 발신자 미상 폴백
    assert f("hi", None, False) == "Someone: hi"


def test_msg_payload_includes_summary():
    """_msg_payload(message_created·mention 공통)에 summary 동봉 — notification-bell raw 노출 차단."""
    from app.routers.conversations import _msg_payload
    msg = _make_msg()
    sender = _make_member()
    payload = _msg_payload(msg, sender)
    assert "summary" in payload
    assert payload["summary"].startswith(f"{sender.name}: ")


def test_msg_payload_sender_includes_avatar_url():
    """story #2901 — sender dict에 avatar_url 동봉(read+SSE+POST 응답 전부의 SSOT인
    _msg_payload 한 지점만 고치면 되는 이유 — 호출부 7곳이 전부 이 함수를 거친다)."""
    from app.routers.conversations import _msg_payload
    msg = _make_msg()
    sender = _make_member(avatar_url="https://cdn.test/member.png")
    payload = _msg_payload(msg, sender)
    assert payload["sender"]["avatar_url"] == "https://cdn.test/member.png"


def test_msg_payload_sender_avatar_url_none_when_sender_has_none():
    """avatar_url 미보유 sender(예: 레거시 org_member 전용 휴먼)는 None으로 정직하게 떨어짐
    (없는 값을 지어내지 않음)."""
    from app.routers.conversations import _msg_payload
    msg = _make_msg()
    sender = _make_member()  # avatar_url 기본값 None
    payload = _msg_payload(msg, sender)
    assert payload["sender"]["avatar_url"] is None


def test_msg_payload_sender_none_when_no_sender():
    """sender 자체가 없으면(orphan 등) payload["sender"]는 None 그대로 — avatar_url 키를
    억지로 만들지 않음(기존 계약 무변경 확認)."""
    from app.routers.conversations import _msg_payload
    msg = _make_msg()
    payload = _msg_payload(msg, None)
    assert payload["sender"] is None


def test_msg_payload_exposes_approval_target_when_present():
    """story #2604 P2: msg_metadata['approval_target']가 있으면 payload top-level에 그대로
    노출된다(_activation_payload와 동형 additive 패턴) — 카드 렌더(FE)가 이 필드로 붙는다."""
    from app.routers.conversations import _msg_payload
    msg = _make_msg()
    gate_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    msg.msg_metadata = {
        "activation": {"kind": "request", "expects_response": True},
        "approval_target": {
            "work_item_type": "doc", "work_item_id": str(doc_id),
            "gate_id": str(gate_id), "actions": ["approve", "reject"],
        },
    }
    sender = _make_member()
    payload = _msg_payload(msg, sender)
    assert payload["message_kind"] == "request"
    assert payload["approval_target"] == {
        "work_item_type": "doc", "work_item_id": str(doc_id),
        "gate_id": str(gate_id), "actions": ["approve", "reject"],
    }


def test_msg_payload_approval_target_none_when_absent():
    """기존(activation 없는) 메시지 — approval_target 키는 있되 값은 None(additive·회귀 없음)."""
    from app.routers.conversations import _msg_payload
    msg = _make_msg()
    sender = _make_member()
    payload = _msg_payload(msg, sender)
    assert payload["approval_target"] is None


# ─── AC1: Alembic migration 파일 + 테이블 확인 ───────────────────────────────

def test_migration_file_exists():
    """0030_add_conversations.py migration 존재 확인."""
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0030_add_conversations.py")
    assert os.path.exists(path)


def test_migration_has_correct_tables():
    """migration에 3개 테이블 정의 확인."""
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0030_add_conversations.py")
    src = open(path).read()
    for tbl in ("conversations", "conversation_participants", "conversation_messages"):
        assert tbl in src, f"{tbl} 없음"


# ─── AC2: 모델 임포트 확인 ───────────────────────────────────────────────────

def test_models_importable():
    """conversation 모델 임포트 가능 확인."""
    from app.models.conversation import Conversation, ConversationParticipant, ConversationMessage
    assert Conversation.__tablename__ == "conversations"
    assert ConversationParticipant.__tablename__ == "conversation_participants"
    assert ConversationMessage.__tablename__ == "conversation_messages"


# ─── AC3: POST /conversations — group 생성 ──────────────────────────────────

@pytest.mark.anyio
async def test_create_group_conversation():
    """POST /api/v2/conversations — group 대화 생성 201."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member
        session.execute = AsyncMock(return_value=member_result)

        async def _refresh(obj):
            obj.id = CONV_ID
            obj.type = "group"
            obj.title = "테스트"

        session.refresh.side_effect = _refresh

        async with client as c:
            # 179db213: 2-member 는 DM 강제이므로 group 은 ≥3 member(참가자 2명+sender)
            resp = await c.post("/api/v2/conversations", json={
                "type": "group",
                "title": "테스트",
                "participant_ids": [str(uuid.uuid4()), str(uuid.uuid4())],
                "project_id": str(PROJECT_ID),
            })

        assert resp.status_code == 201
        body = resp.json()
        assert "id" in body
        assert body["type"] == "group"
        assert body["existing"] is False
    finally:
        app.dependency_overrides.clear()


# ─── 179db213: 1-pair=1-DM enforce ──────────────────────────────────────────

@pytest.mark.anyio
async def test_group_request_2members_coerced_to_dm():
    """CP1: type=group 으로 2-member(참가자 1+sender) 요청해도 DM 으로 강제(1-pair=1-DM)."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member
        none_result = MagicMock()
        none_result.scalar_one_or_none.return_value = None  # 기존 DM 없음
        # execute: member resolve → _find_existing_dm(None) → 신규 DM 생성
        session.execute = AsyncMock(side_effect=[member_result, none_result])

        async def _refresh(obj):
            obj.id = CONV_ID
            obj.type = "dm"   # 핸들러가 is_dm 으로 type='dm' 세팅
            obj.title = None
        session.refresh.side_effect = _refresh

        # E-SECURITY SEC-S3: create_conversation이 먼저 participant_ids를 org 필터한다 — 이
        # 테스트는 DM 강제 로직 검증이 목적이라 필터 자체는 통과-그대로(bypass)로 패치.
        with patch(
            "app.routers.conversations.filter_org_member_ids",
            new=AsyncMock(side_effect=lambda ids, *a, **kw: ids),
        ):
            async with client as c:
                resp = await c.post("/api/v2/conversations", json={
                    "type": "group",   # label 은 group 이지만 2-member → DM 강제
                    "participant_ids": [str(uuid.uuid4())],
                    "project_id": str(PROJECT_ID),
                })
        assert resp.status_code == 201
        body = resp.json()
        assert body["type"] == "dm", f"2-member group → DM 강제 실패: {body}"
        assert body["existing"] is False
    finally:
        app.dependency_overrides.clear()


# ─── AC4: POST /conversations — DM 중복 방지 ────────────────────────────────

@pytest.mark.anyio
async def test_create_dm_no_dedup_creates_new_session():
    """db75ecd0(EF-S2) AC1: 같은 pair여도 dedup 없이 매 호출 신규 conversation(existing False).

    179db213 의 1-DM-per-pair dedup 회귀 — _find_existing_dm 제거로 항상 신규 세션 생성.
    """
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        other_id = uuid.uuid4()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member
        # _find_existing_dm 제거 → member resolve 만(2번째는 안전 여분)
        session.execute = AsyncMock(side_effect=[member_result, MagicMock()])

        async def _refresh(obj):
            obj.id = CONV_ID
            obj.type = "dm"
            obj.title = None
        session.refresh.side_effect = _refresh

        with patch(
            "app.routers.conversations.filter_org_member_ids",
            new=AsyncMock(side_effect=lambda ids, *a, **kw: ids),
        ):
            async with client as c:
                resp = await c.post("/api/v2/conversations", json={
                    "type": "dm",
                    "participant_ids": [str(other_id)],
                    "project_id": str(PROJECT_ID),
                })

        assert resp.status_code == 201
        body = resp.json()
        assert body["existing"] is False  # dedup 제거 — 기존방 다이렉트 없이 항상 신규
        assert body["type"] == "dm"
    finally:
        app.dependency_overrides.clear()


# ─── AC5: GET /conversations — 목록 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_list_conversations():
    """GET /api/v2/conversations → data 배열 반환."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_conv = _make_conv()
        mock_msg = _make_msg()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        conv_ids_result = MagicMock()
        # 270c87e6: conv_ids 쿼리가 (conversation_id, muted_at) 2컬럼 반환 — Row 속성 접근 정합.
        # story #1976: last_read_at 3번째 컬럼 편승(같은 배치 쿼리, 신규 쿼리 아님).
        conv_ids_result.all.return_value = [
            MagicMock(conversation_id=CONV_ID, muted_at=None, last_read_at=None)
        ]

        total_result = MagicMock()
        total_result.scalar_one.return_value = 1

        convs_result = MagicMock()
        convs_result.scalars.return_value.all.return_value = [mock_conv]

        p_rows_result = MagicMock()
        p_rows_result.all.return_value = []

        # story #1976: unread_count 배치 쿼리(단일 JOIN+GROUP BY) — 빈 결과=전 대화 unread 0.
        unread_result = MagicMock()
        unread_result.all.return_value = []

        latest_msg_result = MagicMock()
        latest_msg_result.scalar_one_or_none.return_value = mock_msg

        session.execute = AsyncMock(side_effect=[
            member_result, conv_ids_result, total_result,
            convs_result, p_rows_result, unread_result, latest_msg_result,
        ])

        async with client as c:
            resp = await c.get(f"/api/v2/conversations?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert "data" in body
        assert len(body["data"]) == 1
        assert body["data"][0]["id"] == str(CONV_ID)
        assert body["data"][0]["latest_message"]["content"] == "테스트 메시지"
    finally:
        app.dependency_overrides.clear()


# ─── AC6: GET /conversations/{id}/messages — cursor 페이지네이션 ─────────────

@pytest.mark.anyio
async def test_list_messages_response_shape():
    """GET /conversations/{id}/messages → { data, meta } 반환."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_member.role = "owner"  # skip participant check branch
        mock_msg = _make_msg()

        conv_project_result = MagicMock()
        conv_project_result.scalar_one_or_none.return_value = PROJECT_ID

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        msgs_result = MagicMock()
        msgs_result.scalars.return_value.all.return_value = [mock_msg]

        sender_result = MagicMock()
        sender_result.scalars.return_value.all.return_value = [mock_member]

        # #1262: admin-bypass=agent-only 한정 — 휴먼 판별 헬퍼가 참가자/agent 조회.
        # agent-only 대화로 두어 owner org-level messages 접근(우회 허용)을 검증.
        agent_id = uuid.uuid4()
        pids_result = MagicMock()
        pids_result.scalars.return_value.all.return_value = [agent_id]
        agents_result = MagicMock()
        agents_result.scalars.return_value.all.return_value = [agent_id]

        # story #2263 AC6: list_messages가 페이지 전체 참조를 쿼리 1회로 배치 조회
        # (fetch_stored_references) — `.all()`(scalars 아님) 결과, 빈 페이지 가정.
        refs_result = MagicMock()
        refs_result.all.return_value = []

        # story #2349: list_messages가 마지막에 _viewer_blocked_sender_ids(viewer 차단 목록)를
        # 1회 더 조회한다(_resolve_member의 TeamMember lookup) — 여기 mock_member는 실제
        # TeamMember 인스턴스가 아니라 MagicMock이라 isinstance 체크가 실패해 빈 집합으로
        # 즉시 리턴(추가 쿼리 없음), 그래도 이 첫 execute 1회는 소비된다.
        blocked_sender_result = MagicMock()
        # mock_member는 MagicMock이지 실제 TeamMember 인스턴스가 아니라 isinstance 체크가
        # False로 나와 _viewer_blocked_sender_ids가 빈 집합으로 즉시 리턴한다(None을 주면
        # _resolve_member가 grant-only 휴먼 폴백 경로(resolve_member)로 빠져 쿼리가 하나 더
        # 필요해진다 — non-None으로 그 분기를 막는다).
        blocked_sender_result.scalars.return_value.first.return_value = mock_member

        session.execute = AsyncMock(side_effect=[
            conv_project_result, member_result, pids_result, agents_result, msgs_result, sender_result,
            refs_result, blocked_sender_result,
        ])

        async with client as c:
            resp = await c.get(f"/api/v2/conversations/{CONV_ID}/messages")

        assert resp.status_code == 200
        body = resp.json()
        assert "data" in body
        assert "meta" in body
        assert "next_cursor" in body["meta"]
        assert "has_more" in body["meta"]
    finally:
        app.dependency_overrides.clear()


# ─── 03fe1663: GET /conversations/{id} — 단독 메타(project_id server-side 도출용) ──

@pytest.mark.anyio
async def test_get_conversation_200_returns_project_id():
    """GET /conversations/{id} → 단독 메타(project_id 포함). owner org-level 접근."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_member.role = "owner"  # _effective_org_role owner → participant 체크 skip
        mock_conv = _make_conv()
        mock_conv.status = "open"
        mock_conv.created_at = datetime(2026, 5, 14, tzinfo=timezone.utc)

        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = mock_conv
        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        # story #2697: get_conversation이 _can_read_conversation(conversation_readable_predicate
        # SSOT)로 통일된 후의 실 쿼리 순서 — ①_resolve_member(project_id=None, SSOT 내부)
        # ②has_project_access(project_access_valid atom) ③predicate 자체(admin_bypass_eligible이
        # agent-only 대화라 True로 correlate) ④_resolve_member 재해소(gate 통과 後, project_id=
        # conv.project_id) ⑤muted/read-state ⑥participants 배치.
        access_valid_result = MagicMock()
        access_valid_result.scalar_one_or_none.return_value = True  # has_project_access(owner 4-branch)
        predicate_result = MagicMock()
        predicate_result.scalar_one.return_value = True  # agent-only 대화 + owner → predicate True

        # 270c87e6: detail이 caller (muted_at, last_read_at) 조회 1건 추가(story #1976: last_read_at
        # 편승) — 비참여(agent-only)면 row 자체가 None(=미mute·unread_count 계산 스킵).
        muted_result = MagicMock()
        muted_result.one_or_none.return_value = None

        # story #2009: get_conversation이 `_fetch_conversation_participants`(list_conversations와
        # 공유하는 배치 헬퍼)를 마지막에 1회 더 호출 — participant 행 0건으로 모킹(단순화, 이
        # 테스트의 검증 대상은 project_id이지 participants shape 자체는 아래 shape parity 테스트가
        # 커버)하면 후속 lookup_members_by_ids/runtime_type 쿼리도 스킵된다(all_member_ids 공집합).
        participants_result = MagicMock()
        participants_result.all.return_value = []

        session.execute = AsyncMock(side_effect=[
            conv_result, member_result, access_valid_result, predicate_result,
            member_result, muted_result, participants_result,
        ])

        async with client as c:
            resp = await c.get(f"/api/v2/conversations/{CONV_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(CONV_ID)
        assert body["project_id"] == str(PROJECT_ID)  # 업로드 path server-side 도출의 근거
        assert body["participants"] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_conversation_404():
    """존재하지 않는 conversation → 404."""
    client, session, app = await _make_client()
    try:
        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(side_effect=[conv_result])

        async with client as c:
            resp = await c.get(f"/api/v2/conversations/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── AC7: POST /conversations/{id}/messages — 전송 ──────────────────────────

@pytest.mark.anyio
async def test_send_message_201():
    """POST /conversations/{id}/messages → 201 + data."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_conv = _make_conv()
        mock_msg = _make_msg()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = mock_conv

        participant_result = MagicMock()
        participant_result.scalar_one_or_none.return_value = uuid.uuid4()

        # story #2349: send_message가 「발신자를 차단한 수신자」 집합을 1회 조회한다
        # (user_blocker_ids, _command_capability_gate 이후·SSE dispatch 이전).
        user_blocker_result = MagicMock()
        user_blocker_result.scalars.return_value.all.return_value = []

        session.execute = AsyncMock(
            side_effect=[member_result, conv_result, participant_result, user_blocker_result]
        )

        async def _refresh(obj):
            obj.id = mock_msg.id
            obj.conversation_id = CONV_ID
            obj.sender_id = MEMBER_ID
            obj.content = "안녕"
            obj.mentioned_ids = []
            obj.created_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)

        session.refresh.side_effect = _refresh

        with patch("app.routers.conversations._dispatch_conversation_event", new_callable=AsyncMock):
            async with client as c:
                resp = await c.post(f"/api/v2/conversations/{CONV_ID}/messages", json={"content": "안녕"})

        assert resp.status_code == 201
        body = resp.json()
        assert "data" in body
        assert body["data"]["content"] == "안녕"
    finally:
        app.dependency_overrides.clear()


# ─── AC8: 비참여자 메시지 전송 → 403 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_send_message_403_non_participant():
    """비참여자 POST /messages → 403."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_conv = _make_conv()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = mock_conv

        participant_result = MagicMock()
        participant_result.scalar_one_or_none.return_value = None  # 비참여자

        session.execute = AsyncMock(side_effect=[member_result, conv_result, participant_result])

        async with client as c:
            resp = await c.post(f"/api/v2/conversations/{CONV_ID}/messages", json={"content": "테스트"})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── QA B1 회귀: cross-org 멘션 저장·발송 필터 (DM fork 외 group 공통 경로) ─────

@pytest.mark.anyio
async def test_send_message_filters_cross_org_mentions_group():
    """group 대화에서 cross-org 멘션이 저장·발송 양쪽에서 제거된다 (QA B1)."""
    from app.models.conversation import ConversationMessage

    client, session, app = await _make_client()
    try:
        valid_id = uuid.uuid4()
        cross_org_id = uuid.uuid4()

        mock_member = _make_member()
        mock_conv = _make_conv(conv_type="group")

        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = mock_conv
        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member
        participant_result = MagicMock()
        participant_result.scalar_one_or_none.return_value = uuid.uuid4()

        # story #2349: user_blocker_ids(발신자를 차단한 수신자) 1회 조회 추가.
        user_blocker_result = MagicMock()
        user_blocker_result.scalars.return_value.all.return_value = []

        # story #2889: insert_chat_mentions 직후 fetch_stored_references가 1회 추가(SSE/POST
        # 응답에 방금 저장된 references를 즉시 싣기 위함) — .all() 사용, 이 테스트는 멘션
        # cross-org 필터링만 검증하므로 빈 결과로 충분.
        fetch_refs_result = MagicMock()
        fetch_refs_result.all.return_value = []

        # 실제 코드 순서: conv → _resolve_member(TM) → participant → user_blocker_ids → fetch_stored_references
        session.execute = AsyncMock(
            side_effect=[conv_result, member_result, participant_result, user_blocker_result, fetch_refs_result]
        )

        captured = {}
        def _capture_add(obj):
            if isinstance(obj, ConversationMessage):
                captured["mentioned_ids"] = list(obj.mentioned_ids or [])
        session.add.side_effect = _capture_add

        async def _refresh(obj):
            obj.id = uuid.uuid4()
            obj.conversation_id = CONV_ID
            obj.sender_id = MEMBER_ID
            obj.content = "안녕"
            obj.created_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
        session.refresh.side_effect = _refresh

        mention_calls = {}
        async def _capture_mention(db, conversation, msg, org_id, sender, mention_targets,
                                   webhook_covered_ids=None, references=None):
            mention_calls["targets"] = set(mention_targets)
            return []

        with patch("app.routers.conversations.filter_org_member_ids",
                   new=AsyncMock(return_value={valid_id})), \
             patch("app.services.conversation_webhook.resolve_conversation_webhook_targets",
                   new=AsyncMock(return_value=[])), \
             patch("app.routers.conversations._dispatch_conversation_event",
                   new=AsyncMock(return_value=[])), \
             patch("app.routers.conversations._dispatch_mention_events",
                   side_effect=_capture_mention), \
             patch("app.services.channel_router.route_message",
                   new=AsyncMock(return_value=[])), \
             patch("app.services.workflow_pipeline.process_event", new=AsyncMock()):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/conversations/{CONV_ID}/messages",
                    json={"content": "안녕", "mentioned_ids": [str(valid_id), str(cross_org_id)]},
                )

        assert resp.status_code == 201
        # 저장: cross-org 제거, org 소속만 + 순서 보존
        assert captured["mentioned_ids"] == [valid_id]
        # 멘션 이벤트 발송: cross-org 미포함, valid만
        assert mention_calls.get("targets") == {valid_id}
    finally:
        app.dependency_overrides.clear()

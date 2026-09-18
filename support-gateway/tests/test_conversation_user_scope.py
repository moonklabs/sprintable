"""story #3276(지원v1·후속) — 상담 대화 사용자 단위 분리+수명주기. 「의미론 선택 문장마다
반대 구현을 red로 만드는 pin」 규율(story #3662/#3663 클래스) — AC 다섯 축을 각각 직접
겨냥한다."""
from __future__ import annotations

import uuid

from sqlalchemy import select

import app.execution_tasks as execution_tasks_module
from app.metrics import compute_resolution_metrics
from app.models import SupportConversation
from tests.conftest import OTHER_ORG_ID, make_token


async def _create_session(client, org_id, user_id):
    headers = {"Authorization": f"Bearer {make_token(org_id, user_id=user_id)}"}
    resp = await client.post("/api/v1/sessions", headers=headers)
    return headers, resp.json()["id"]


# --- AC1: 대화 스코프=(org_id, external_user_id) --------------------------------------


async def test_same_org_different_users_get_independent_conversations(client, fake_llm):
    """핵심 회귀 — 선생님이 실측한 그 증상 그대로: 같은 org 안 서로 다른 external_user_id는
    절대 같은 대화를 공유하지 않는다(구 코드는 org_id만 봐서 공유했다)."""
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    headers_a, session_a = await _create_session(client, OTHER_ORG_ID, user_a)
    headers_b, session_b = await _create_session(client, OTHER_ORG_ID, user_b)

    await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "A만의 비밀 문의"}, headers=headers_a)

    resp_b = await client.get(f"/api/v1/sessions/{session_b}/messages", headers=headers_b)
    assert resp_b.status_code == 200
    assert resp_b.json()["messages"] == []  # B는 A의 흔적을 절대 못 본다.

    resp_a = await client.get(f"/api/v1/sessions/{session_a}/messages", headers=headers_a)
    assert any(m["content"] == "A만의 비밀 문의" for m in resp_a.json()["messages"])


async def test_session_id_scoped_to_owning_user_not_just_org(client, fake_llm):
    """story #3276 보강 pin — 같은 org의 타 사용자 session_id를 안다고 해도(추측·유출)
    자기 토큰으로는 그 세션을 조작할 수 없다(404 — 존재 노출 없음)."""
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    _, session_a = await _create_session(client, OTHER_ORG_ID, user_a)
    headers_b, _ = await _create_session(client, OTHER_ORG_ID, user_b)

    resp = await client.post(
        f"/api/v1/sessions/{session_a}/messages", json={"content": "hijack 시도"}, headers=headers_b
    )
    assert resp.status_code == 404


async def test_cross_org_isolation_still_holds(client, fake_llm):
    """#3264 자산(교차 org 격리 pin) 불변 확認 — story #3276이 사용자 축을 추가했다고 org
    축이 느슨해지면 안 된다."""
    from tests.conftest import MOONKLABS_ORG_ID

    user = uuid.uuid4()
    headers_a, session_a = await _create_session(client, OTHER_ORG_ID, user)
    await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "org A 비밀"}, headers=headers_a)

    # 같은 external_user_id라도 org가 다르면 완전 별개(우연 일치조차 없어야 함).
    headers_b, session_b = await _create_session(client, MOONKLABS_ORG_ID, user)
    resp = await client.get(f"/api/v1/sessions/{session_b}/messages", headers=headers_b)
    assert resp.json()["messages"] == []


# --- AC2: 수명주기(새 상담·종료) --------------------------------------------------------


async def test_start_new_conversation_ends_previous_and_isolates_messages(client, fake_llm):
    user = uuid.uuid4()
    headers, session_id = await _create_session(client, OTHER_ORG_ID, user)

    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "첫 상담"}, headers=headers)

    start_resp = await client.post(f"/api/v1/sessions/{session_id}/conversations/start", headers=headers)
    assert start_resp.status_code == 200
    new_conv = start_resp.json()
    assert new_conv["ended_at"] is None

    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "둘째 상담"}, headers=headers)

    active = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    contents = [m["content"] for m in active.json()["messages"] if m["role"] == "customer"]
    assert contents == ["둘째 상담"]  # 첫 상담 메시지는 새 활성 대화에 안 섞인다.
    assert active.json()["conversation_id"] == new_conv["id"]


async def test_end_conversation_makes_it_read_only_history_next_message_opens_fresh_one(client, fake_llm):
    user = uuid.uuid4()
    headers, session_id = await _create_session(client, OTHER_ORG_ID, user)

    post1 = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "종료 전"}, headers=headers)
    conv_id = post1.json()["customer_message"]["conversation_id"]

    end_resp = await client.post(f"/api/v1/sessions/{session_id}/conversations/{conv_id}/end", headers=headers)
    assert end_resp.status_code == 200
    assert end_resp.json()["ended_at"] is not None

    # 종료된 대화를 굳이 재활용하지 않는다 — 다음 메시지는 자동으로 새 상담을 연다.
    post2 = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "종료 후"}, headers=headers)
    assert post2.json()["customer_message"]["conversation_id"] != conv_id

    # 종료된 대화는 conversation_id로 명시 조회하면 그대로 읽힌다(읽기 전용 이력).
    history = await client.get(
        f"/api/v1/sessions/{session_id}/messages", params={"conversation_id": conv_id}, headers=headers
    )
    assert history.status_code == 200
    assert history.json()["ended_at"] is not None
    assert any(m["content"] == "종료 전" for m in history.json()["messages"])


async def test_ending_conversation_does_not_touch_open_escalation_status(client, fake_llm):
    """종료≠에스컬 해소 — 별개 축(AC2 명시 요구사항) pin."""
    user = uuid.uuid4()
    headers, session_id = await _create_session(client, OTHER_ORG_ID, user)

    fake_llm.classify_text = "needs_human"
    post1 = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "사람 필요"}, headers=headers)
    assert post1.json()["escalation_status"] == "open"
    conv_id = post1.json()["customer_message"]["conversation_id"]

    end_resp = await client.post(f"/api/v1/sessions/{session_id}/conversations/{conv_id}/end", headers=headers)
    assert end_resp.status_code == 200
    assert end_resp.json()["escalation_status"] == "open"  # 종료가 에스컬 상태를 안 건드림.


async def test_end_conversation_is_idempotent(client, fake_llm):
    user = uuid.uuid4()
    headers, session_id = await _create_session(client, OTHER_ORG_ID, user)
    post1 = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "hi"}, headers=headers)
    conv_id = post1.json()["customer_message"]["conversation_id"]

    r1 = await client.post(f"/api/v1/sessions/{session_id}/conversations/{conv_id}/end", headers=headers)
    r2 = await client.post(f"/api/v1/sessions/{session_id}/conversations/{conv_id}/end", headers=headers)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["ended_at"] == r2.json()["ended_at"]  # 최초 종료 시각 보존, 재호출로 안 밀림.


async def test_cannot_end_another_users_conversation(client, fake_llm):
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    headers_a, session_a = await _create_session(client, OTHER_ORG_ID, user_a)
    headers_b, session_b = await _create_session(client, OTHER_ORG_ID, user_b)

    post1 = await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "A의 상담"}, headers=headers_a)
    conv_a = post1.json()["customer_message"]["conversation_id"]

    resp = await client.post(f"/api/v1/sessions/{session_b}/conversations/{conv_a}/end", headers=headers_b)
    assert resp.status_code == 404


# --- AC3: 위젯 대화 목록(자기 것만) ------------------------------------------------------


async def test_list_conversations_returns_only_own_conversations(client, fake_llm):
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    headers_a, session_a = await _create_session(client, OTHER_ORG_ID, user_a)
    headers_b, session_b = await _create_session(client, OTHER_ORG_ID, user_b)

    await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "A"}, headers=headers_a)
    await client.post(f"/api/v1/sessions/{session_a}/conversations/start", headers=headers_a)
    await client.post(f"/api/v1/sessions/{session_b}/messages", json={"content": "B"}, headers=headers_b)

    list_a = await client.get(f"/api/v1/sessions/{session_a}/conversations", headers=headers_a)
    assert list_a.status_code == 200
    assert len(list_a.json()["conversations"]) == 2  # A의 상담 2개(원본+새로 시작한 것)

    list_b = await client.get(f"/api/v1/sessions/{session_b}/conversations", headers=headers_b)
    assert len(list_b.json()["conversations"]) == 1
    assert list_b.json()["conversations"][0]["id"] != list_a.json()["conversations"][0]["id"]


# --- AC4: 기존 데이터 처분(레거시 봉인) ---------------------------------------------------


async def test_legacy_org_scoped_conversation_is_sealed_unreachable_by_any_user(client, fake_llm, db_engine):
    """레거시 행(external_user_id=NULL, 마이그 前 생성분 시뮬레이션)은 신규 조회 경로 어디서도
    안 걸린다 — backfill 안 함(봉인), 삭제도 안 함(DB엔 남아 감사 가능)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    legacy_id = uuid.uuid4()
    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        legacy = SupportConversation(id=legacy_id, org_id=OTHER_ORG_ID, session_id=uuid.uuid4(), external_user_id=None)
        session.add(legacy)
        await session.commit()

    user = uuid.uuid4()
    headers, session_id = await _create_session(client, OTHER_ORG_ID, user)

    # 활성 상담 조회(자동 get-or-create)는 레거시 행을 절대 재사용하지 않는다 — 새 것을 만든다.
    resp = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "hi"}, headers=headers)
    assert resp.json()["customer_message"]["conversation_id"] != legacy_id

    # 목록에도 안 뜬다.
    listing = await client.get(f"/api/v1/sessions/{session_id}/conversations", headers=headers)
    assert legacy_id not in {c["id"] for c in listing.json()["conversations"]}

    # 명시 conversation_id로 찔러봐도 404(소유권 없음 — external_user_id 불일치).
    peek = await client.get(
        f"/api/v1/sessions/{session_id}/messages", params={"conversation_id": str(legacy_id)}, headers=headers
    )
    assert peek.status_code == 404

    # 데이터 자체는 DB에 그대로 남아있다(삭제 아님, 감사 가능).
    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        still_there = await session.get(SupportConversation, legacy_id)
        assert still_there is not None
        assert still_there.external_user_id is None


# --- AC5: 계측 정합 ---------------------------------------------------------------------


async def test_metrics_total_turns_unaffected_by_per_user_conversation_split(client, fake_llm, db_engine):
    """story #3264 metrics는 SupportMessage/SupportEscalation row count 기반(org_id만
    필터, conversation 무관) — 대화가 org당 1개든 사용자별로 N개로 쪼개지든 turn 카운트는
    똑같아야 한다. 이 반례가 깨지면(예: 미래에 누군가 conversation 단위로 잘못 재집계하면)
    이 pin이 red가 된다."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    headers_a, session_a = await _create_session(client, OTHER_ORG_ID, user_a)
    headers_b, session_b = await _create_session(client, OTHER_ORG_ID, user_b)

    await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "A1"}, headers=headers_a)
    await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "A2"}, headers=headers_a)
    await client.post(f"/api/v1/sessions/{session_b}/messages", json={"content": "B1"}, headers=headers_b)

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        metrics = await compute_resolution_metrics(session, org_id=OTHER_ORG_ID)
    assert metrics.total_turns == 3  # 대화 2개(사용자별)에 걸쳐 있어도 agent 메시지 3건 그대로.


async def test_escalation_status_is_per_conversation_not_leaked_across_users_in_same_org(client, fake_llm):
    """#3263 AC4 escalation_status 함수 자체는 무변경이지만, 스코프가 올바르게 좁혀졌으니
    자동으로 per-user가 되어야 한다 — B의 에스컬레이션이 A의 escalation_status에 안 새는지."""
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    headers_a, session_a = await _create_session(client, OTHER_ORG_ID, user_a)
    headers_b, session_b = await _create_session(client, OTHER_ORG_ID, user_b)

    fake_llm.classify_text = "needs_human"
    await client.post(f"/api/v1/sessions/{session_b}/messages", json={"content": "B가 사람 필요"}, headers=headers_b)

    fake_llm.classify_text = "inquiry"
    resp_a = await client.post(f"/api/v1/sessions/{session_a}/messages", json={"content": "A는 그냥 문의"}, headers=headers_a)
    assert resp_a.json()["escalation_status"] is None  # B의 에스컬레이션이 A에게 안 보임.

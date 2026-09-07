"""story #3379(에이전트 온보딩·오도, 페드루 PO 確定 2026-09-07, 담롱·댄 실사고
2026-09-03) — 「기본 침묵」: draft doc이 채팅에서 참조됐다는 사실만으로 상신을 권하지
않는다. "draft 제외"가 아니라 "논의 성격을 읽을 수 없으면 권하지 않는다"(댄·담롱
프레이밍, PO 채택).

`maybe_nudge_draft_doc_shared_in_chat`의 신규 억제 3종(⑤최근 편집·⑥content 신호·
⑦superseded)을 d1f4afcb류 harness(create_all + system-publisher 인덱스, 새 관례
발명 0)로 실 PG 검증한다. `_message_signals_doc_still_being_revised` 순수함수 표본은
DB가 필요 없어 별도 파일(test_3379_doc_nudge_signal_words.py, non-destructive)로 뺐다
— 이 파일은 destructive_schema만 담는다(파일 하나=순수 destructive 전제로 도는 CI
shard 러너와 정합, story #3186/8236bbc3 가드 회귀).

PO 確定② — 신호(a)(b)(c)는 트리거 메시지 자신의 content만 본다(대화 이력 스캔 X).
잃는 것: 이 메시지 "전"에 오간 논의 문맥은 못 본다 — 범위 밖으로 명시 선언.

PO 確定① — 기존 (org, doc) 전역 1회 reservation(`DocChatNudgeDispatch`)은 그대로 —
더 엄격한 쪽이 이긴다. 이 스토리의 AC(d)"같은 대화·같은 doc 최대 1회"는 그 축에
자동 포함되는 상위 제약이라 새 표·새 인덱스 0 — 여기서는 그 전역 축이 여전히 서
있다는 것만 회귀로 재확認한다(2d314c36류 회귀 방지, 같은 (org,doc) 두 번째 호출은
신규 억제 3종과 무관하게 0건이어야 한다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_d1f4afcb_draft_nudge_gate_and_event_suppress import (
    _count_nudge_messages,
    _seed_doc,
    _seed_human_member,
    _seed_org_project,
    _session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(
        not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요",
    ),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


_STALE_ENOUGH_UPDATED_AT = datetime.now(timezone.utc) - timedelta(hours=1)
_NEUTRAL_CONTENT = "이 문서 확인 부탁드립니다"


@pytest.mark.anyio
async def test_recently_edited_doc_suppresses_nudge():
    """⑤ — doc_updated_at이 억제선(30분) 안이면 넛지가 안 뜬다."""
    from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="방금 편집한 문서")

        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="방금 편집한 문서", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
                doc_updated_at=datetime.now(timezone.utc) - timedelta(minutes=5),
                doc_superseded_by=None, trigger_message_content=_NEUTRAL_CONTENT,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0, f"최근 편집된 doc인데 넛지가 남: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_content_signal_suppresses_nudge():
    """⑥ — 트리거 메시지 자신에 수정/정정/교체/폐기 신호가 있으면 넛지가 안 뜬다."""
    from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="논의 중인 문서")

        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="논의 중인 문서", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
                doc_updated_at=_STALE_ENOUGH_UPDATED_AT, doc_superseded_by=None,
                trigger_message_content="이 조항은 이제 폐기하는 게 맞을 것 같아요",
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0, f"트리거 메시지에 폐기 신호가 있는데 넛지가 남: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_superseded_doc_suppresses_nudge():
    """⑦ — doc_superseded_by가 설정돼 있으면(이미 다른 doc으로 대체) 넛지가 안 뜬다."""
    from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="구버전 문서")
            replacement_id = await _seed_doc(s, org_id, project_id, author_id, title="신버전 문서")

        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="구버전 문서", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
                doc_updated_at=_STALE_ENOUGH_UPDATED_AT, doc_superseded_by=replacement_id,
                trigger_message_content=_NEUTRAL_CONTENT,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0, f"이미 superseded된 doc인데 넛지가 남: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_signal_still_nudges_regression():
    """음성대조(회귀 0) — 셋 다 해당 없는 일반 draft doc은 기존대로 넛지가 뜬다(신규
    억제 3종이 과잉 침묵으로 기능 자체를 죽이지 않았는지 확認)."""
    from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="평범한 draft")

        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="평범한 draft", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
                doc_updated_at=_STALE_ENOUGH_UPDATED_AT, doc_superseded_by=None,
                trigger_message_content=_NEUTRAL_CONTENT,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"억제 신호 0건인데 넛지가 안 뜸(과도한 침묵): {len(rows)}건"
            # 두 갈래 문구 확認(AC — 단정형 대신 "확정본이면 검토 요청 / 고칠 게 있으면 편집").
            assert "확정본이면" in rows[0].content and "고칠 게 있으면" in rows[0].content
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_global_once_per_org_doc_reservation_still_holds_regression():
    """PO 確定① 회귀 — AC(d)"같은 대화·같은 doc 최대 1회"는 기존 (org, doc) 전역 1회
    reservation에 자동 포함된다(2d314c36류 회귀 방지). 신규 억제 3종과 무관하게, 억제
    신호가 전혀 없는 두 번째 호출도 전역 reservation 때문에 0건이어야 한다."""
    from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_a = await _seed_human_member(s, org_id, project_id, name="SenderA")
            sender_b = await _seed_human_member(s, org_id, project_id, name="SenderB")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="전역 1회 문서")

        async def _call(sender_id):
            async with Session() as s:
                await maybe_nudge_draft_doc_shared_in_chat(
                    s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                    doc_title="전역 1회 문서", doc_status="draft",
                    doc_author_id=author_id, sender_id=sender_id,
                    doc_updated_at=_STALE_ENOUGH_UPDATED_AT, doc_superseded_by=None,
                    trigger_message_content=_NEUTRAL_CONTENT,
                )
                await s.commit()

        await _call(sender_a)
        await _call(sender_b)

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"작성자당 전역 1회가 깨짐: {len(rows)}건"
    finally:
        await engine.dispose()

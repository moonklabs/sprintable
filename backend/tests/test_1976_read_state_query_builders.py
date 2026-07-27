"""story #1976 (E-CHAT-REALTIME 트랙A): read state 쿼리 조립 순수 단위 테스트(DB 미기동).

doc chat-realtime-track-a-read-state-design §3(mark-read GREATEST 래칫)/§4(unread_count
JOIN+GROUP BY, sender IS DISTINCT FROM). `_mark_read_update_stmt`/`_unread_count_stmt`/
`_list_unread_counts_stmt`는 SQLAlchemy 문(Statement) 조립만 하는 순수 함수 — compile()로
생성 SQL을 직접 검증(DB 라운드트립 불요, 실PG 없어도 실행 가능).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.dialects import postgresql

from app.routers.conversations import (
    _EPOCH,
    _list_unread_counts_stmt,
    _mark_read_update_stmt,
    _unread_count_stmt,
)

_CONV_ID = uuid.uuid4()
_MEMBER_ID = uuid.uuid4()
_UP_TO = datetime(2026, 7, 17, 9, 0, 0, tzinfo=timezone.utc)


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect()))


# ─── _mark_read_update_stmt: GREATEST 래칫 ───────────────────────────────────

def test_mark_read_uses_greatest_ratchet():
    sql = _sql(_mark_read_update_stmt(_CONV_ID, _MEMBER_ID, _UP_TO))
    assert "greatest(" in sql.lower()


def test_mark_read_coalesces_null_last_read_at_to_epoch():
    """last_read_at NULL(한 번도 안 읽음)이어도 GREATEST가 안전하게 up_to로 세팅되도록
    COALESCE(last_read_at, epoch) 사용 — 설계 doc §3-4 그대로."""
    sql = _sql(_mark_read_update_stmt(_CONV_ID, _MEMBER_ID, _UP_TO))
    assert "coalesce(conversation_participants.last_read_at" in sql.lower()
    assert "epoch" in sql.lower()


def test_mark_read_scoped_to_conversation_and_member():
    sql = _sql(_mark_read_update_stmt(_CONV_ID, _MEMBER_ID, _UP_TO))
    assert "conversation_participants.conversation_id" in sql
    assert "conversation_participants.member_id" in sql


def test_mark_read_returns_last_read_at_for_403_detection():
    """WHERE 매치 0행(비참여자) 시 RETURNING이 빈 결과 → 호출부가 None 판정으로 403."""
    stmt = _mark_read_update_stmt(_CONV_ID, _MEMBER_ID, _UP_TO)
    sql = _sql(stmt)
    assert "returning conversation_participants.last_read_at" in sql.lower()


# ─── _unread_count_stmt: IS DISTINCT FROM(3-값 논리 함정 회피) ───────────────

def test_unread_count_uses_is_distinct_from_not_noteq():
    """핵심 함정 회피: sender_id nullable(발신자 탈퇴 시 SET NULL) — `!=`는 3-값 논리상
    NULL != x → NULL(제외)이 돼 발신자소실 메시지가 unread에서 누락된다. IS DISTINCT FROM만
    NULL을 올바르게 '나와 다름'으로 취급한다."""
    sql = _sql(_unread_count_stmt(_CONV_ID, _MEMBER_ID, _UP_TO))
    assert "is distinct from" in sql.lower()
    # 정확히 IS DISTINCT FROM만 써야 — 동시에 순수 `!=`(<>) 비교로도 sender를 거르면 안 된다.
    assert "sender_id !=" not in sql.lower()
    assert "sender_id <>" not in sql.lower()


def test_unread_count_filters_by_created_at_after_since():
    sql = _sql(_unread_count_stmt(_CONV_ID, _MEMBER_ID, _UP_TO))
    assert "conversation_messages.created_at >" in sql


def test_unread_count_since_none_uses_epoch_baseline():
    """last_read_at=NULL(한 번도 안 읽음) 케이스 — since=None이면 _EPOCH 기준선을 바인딩."""
    stmt = _unread_count_stmt(_CONV_ID, _MEMBER_ID, None)
    compiled = stmt.compile(dialect=postgresql.dialect())
    bound = compiled.params
    assert any(v == _EPOCH for v in bound.values())


def test_unread_count_scoped_to_single_conversation():
    sql = _sql(_unread_count_stmt(_CONV_ID, _MEMBER_ID, _UP_TO))
    assert "conversation_messages.conversation_id =" in sql


# ─── _list_unread_counts_stmt: 단일 JOIN+GROUP BY(N+1 방지) ─────────────────

def test_list_unread_counts_is_single_join_not_subquery_per_conv():
    """대화마다 개별 쿼리(N+1) 대신 JOIN 조건에 기준시각 비교를 박아 단일 쿼리로 해결(§4-2)."""
    sql = _sql(_list_unread_counts_stmt(_MEMBER_ID, [_CONV_ID]))
    assert "join conversation_messages" in sql.lower()
    assert "group by conversation_participants.conversation_id" in sql.lower()


def test_list_unread_counts_join_condition_carries_per_row_baseline():
    """JOIN 조건 자체에 coalesce(last_read_at, epoch) 비교가 들어가야 대화별로 다른 기준
    시각을 단일 쿼리로 처리할 수 있다 — 순수 IN 배치만으론 불가능한 이유."""
    sql = _sql(_list_unread_counts_stmt(_MEMBER_ID, [_CONV_ID]))
    assert "coalesce(conversation_participants.last_read_at" in sql.lower()


def test_list_unread_counts_uses_is_distinct_from():
    sql = _sql(_list_unread_counts_stmt(_MEMBER_ID, [_CONV_ID]))
    assert "is distinct from" in sql.lower()


def test_list_unread_counts_filters_member_and_conv_id_list():
    sql = _sql(_list_unread_counts_stmt(_MEMBER_ID, [_CONV_ID]))
    assert "conversation_participants.member_id =" in sql
    assert "conversation_participants.conversation_id in" in sql.lower()

"""story #3646 카디르 qa:changes(PR #4004, 2026-09-07) — `mark_connection_failed`
(graph_api_errors.py)이 `if message is not None:`일 때만 last_error를 썼다. 지운 인라인
3곳(channel_post_comments.py·insight_snapshots.py·publication_command.py)은 전부
`(message or "")[:2000]`으로 항상 덮어쓰던 것이라, message=None으로 이 헬퍼를 부르면
그 연결의 옛(무관한) last_error가 그대로 남는다 — 「틀린 진단문구 표시」 회귀.

`mark_connection_failed`는 `connection`을 속성 읽기/쓰기로만 다뤄(status/last_error/
last_error_code/last_error_at) DB가 필요 없다 — 순수 단위 테스트(마커 없음)."""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace


def _fake_connection(**overrides):
    base = dict(status="active", last_error=None, last_error_code=None, last_error_at=None)
    base.update(overrides)
    return SimpleNamespace(**base)


def test_message_none_clears_stale_last_error_but_still_updates_code_and_at():
    from app.services.graph_api_errors import mark_connection_failed

    conn = _fake_connection(
        status="error", last_error="옛 진단 문구(무관한 이전 실패)",
        last_error_code="CHANNEL_CONNECTION_AUTH_ERROR",
        last_error_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
    )
    now = datetime.now(timezone.utc)

    mark_connection_failed(conn, error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=None, now=now)

    assert conn.last_error == "", "message=None인데 옛 last_error가 남음 — 틀린 진단문구 표시 회귀"
    assert conn.last_error_code == "CHANNEL_PUBLISH_PROVIDER_ERROR"
    assert conn.last_error_at == now


def test_mutation_reintroducing_conditional_last_error_leaves_stale_text(monkeypatch):
    """뮤테이션 — `if message is not None:` 조건부로 되돌리면(원래 결함 재현) 옛
    last_error가 안 지워져 RED."""
    import app.services.graph_api_errors as mod

    def _buggy_mark_connection_failed(connection, *, error_code, message, now):
        connection.status = mod.connection_status_for_error_code(error_code, current_status=connection.status)
        if message is not None:
            connection.last_error = message[:2000]
        connection.last_error_code = error_code
        connection.last_error_at = now

    monkeypatch.setattr(mod, "mark_connection_failed", _buggy_mark_connection_failed)

    conn = _fake_connection(status="error", last_error="옛 진단 문구(무관한 이전 실패)")
    mod.mark_connection_failed(conn, error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=None, now=datetime.now(timezone.utc))

    assert conn.last_error == "옛 진단 문구(무관한 이전 실패)", "뮤테이션이 무력화됨 — 조건부 복원이 실제로 재현되지 않음"

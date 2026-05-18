"""S5-2: SseParser 유닛 테스트 — synthetic SSE stream으로 파싱 정확성 검증."""
from __future__ import annotations

import pytest

from sprintable_mcp.sse_bridge import SseEvent, SseParser


def _parse(lines: list[str]) -> list[SseEvent]:
    """헬퍼: 라인 목록을 SseParser에 통과시켜 이벤트 리스트 반환."""
    parser = SseParser()
    events: list[SseEvent] = []
    for line in lines:
        event = parser.feed(line)
        if event is not None:
            events.append(event)
    return events


def test_heartbeat_only_produces_no_event():
    """`:` prefix 라인(heartbeat/comment)은 이벤트 생성 안 함."""
    events = _parse([": heartbeat", ": keep-alive", ""])
    assert events == []


def test_single_event_basic():
    """event: + data: + blank line → 이벤트 1개 생성."""
    events = _parse([
        "event: memo_received",
        "data: hello",
        "",
    ])
    assert len(events) == 1
    assert events[0].event_type == "memo_received"
    assert events[0].data == "hello"


def test_multiline_data_joined_with_newline():
    """data: 여러 줄 → '\\n' 결합."""
    events = _parse([
        "event: update",
        "data: line1",
        "data: line2",
        "data: line3",
        "",
    ])
    assert len(events) == 1
    assert events[0].data == "line1\nline2\nline3"


def test_id_tracking_persists_across_events():
    """`id:` 필드가 last_event_id에 추적되고 이후 이벤트에도 유지됨."""
    parser = SseParser()
    events = []

    for line in ["id: abc-123", "data: first", ""]:
        e = parser.feed(line)
        if e:
            events.append(e)

    assert events[0].last_event_id == "abc-123"
    assert parser.last_event_id == "abc-123"

    # id 없는 두 번째 이벤트 — last_event_id 유지
    for line in ["data: second", ""]:
        e = parser.feed(line)
        if e:
            events.append(e)

    assert events[1].last_event_id == "abc-123"


def test_unknown_field_ignored():
    """알 수 없는 필드는 무시하고 알려진 필드만 처리."""
    events = _parse([
        "retry: 3000",
        "event: ping",
        "data: pong",
        "custom-field: value",
        "",
    ])
    assert len(events) == 1
    assert events[0].event_type == "ping"
    assert events[0].data == "pong"


def test_default_event_type_is_message():
    """`event:` 없으면 event_type = 'message'."""
    events = _parse(["data: no event field", ""])
    assert events[0].event_type == "message"


def test_blank_line_without_data_produces_no_event():
    """data 없이 blank line만 → 이벤트 없음."""
    events = _parse(["event: empty", ""])
    assert events == []


def test_leading_space_stripped_from_value():
    """SSE spec: field 값에서 선행 공백 1개 제거."""
    events = _parse(["event: test", "data: value with space", ""])
    assert events[0].data == "value with space"


def test_multiple_events_sequential():
    """연속 이벤트 여러 개 순서대로 반환."""
    events = _parse([
        "event: first",
        "data: 1",
        "",
        "event: second",
        "data: 2",
        "",
        ": heartbeat",
        "",
        "event: third",
        "data: 3",
        "",
    ])
    assert len(events) == 3
    assert [e.event_type for e in events] == ["first", "second", "third"]
    assert [e.data for e in events] == ["1", "2", "3"]

"""story #2787 — sprintable_list_backlog가 server.py의 `_TOOL_DEFS`에 핸들러 함수의 실제
입력 클래스(`ListBacklogInput`)가 아니라 베이스 `SprintableInput`으로 등록돼 있었다(story
#2428이 신설한 클래스를 배선에 반영 안 함). 등록 클래스에 `limit`/`cursor` 필드가 없으니
①MCP 스키마 자체가 그 인자를 노출 안 하고 ②핸들러가 `args.limit`을 접근하는 순간 즉시
`AttributeError`로 크래시했다(mcp SDK 버전 무관 — 순수 Python 배선 버그, 2772 이관과 무관).

PO 지시(2026-08-19, 2772 배포 직후 회귀 제보 판별) — ①사본 전수(같은 클래스의 다른 도구도
있는지) ②구조 가드(이 배선 누락이 다시는 조용히 못 들어오게).

①은 이 fix 자체(server.py)에서 `_TOOL_DEFS` 123개 전수를 `inspect.get_type_hints()`로 대조해
확認 완료(list_backlog 1건만 위반, 나머지 122건 전부 정확). 이 파일이 ②(그 대조를 상시
회귀 가드로 고정)."""
from __future__ import annotations

import inspect
from typing import get_type_hints


def test_every_registered_tool_input_class_matches_handler_signature():
    """`_TOOL_DEFS`의 (name, doc, input_cls, fn) 4-튜플마다, 등록된 input_cls가 fn의 실제
    시그니처가 요구하는 타입과 정확히 일치하는지 전수 검증.

    ⚠️`inspect.signature(fn).parameters[...].annotation`만 쓰면 이 레포의 모든 tools/*.py가
    `from __future__ import annotations`(PEP 563 postponed evaluation)를 쓰고 있어 어노테이션이
    **문자열**로 온다(클래스 객체가 아님) — 그러면 어떤 진짜 불일치도 "이름이 다른 문자열끼리
    비교"로 오검출되거나, 반대로 실제 클래스 객체 비교가 아니라서 아무 신호도 못 준다. 반드시
    `typing.get_type_hints(fn)`로 어노테이션을 실제 클래스 객체로 해소한 뒤 `is` 비교해야
    실측 가능(list_backlog 버그를 이 방식으로 처음 확認했다 — raw annotation 비교는 123개
    전부 "불일치"로 오검출해 무용했다)."""
    import sprintable_mcp.server as srv

    mismatches: list[str] = []
    for name, _doc, input_cls, fn in srv._TOOL_DEFS:
        sig = inspect.signature(fn)
        params = list(sig.parameters.values())
        assert params, f"{name}: 핸들러 {fn.__name__}에 파라미터가 없음 — 배선 자체가 이상함"

        hints = get_type_hints(fn)
        expected = hints.get(params[0].name)
        if expected is not input_cls:
            mismatches.append(
                f"{name}: _TOOL_DEFS 등록={input_cls.__name__} vs "
                f"핸들러({fn.__name__}) 실제 요구={getattr(expected, '__name__', expected)}"
            )

    assert not mismatches, (
        "등록된 input 클래스가 핸들러 시그니처와 다른 도구 발견 — 등록 클래스에 핸들러가 "
        "접근하는 필드가 없으면 즉시 AttributeError로 크래시한다(story #2787 list_backlog "
        "실사고와 동형):\n" + "\n".join(mismatches)
    )


def test_list_backlog_specifically_uses_list_backlog_input():
    """양성대조 pin — story #2787이 실제로 고친 그 자리가 계속 옳게 유지되는지 이름으로 직접
    확認(위 전수 테스트가 이 사실을 이미 포함하지만, 이 특정 회귀는 이름으로도 pin해 둔다)."""
    from sprintable_mcp.server import _TOOL_DEFS
    from sprintable_mcp.tools.stories import ListBacklogInput

    entry = next(e for e in _TOOL_DEFS if e[0] == "sprintable_list_backlog")
    _name, _doc, input_cls, _fn = entry
    assert input_cls is ListBacklogInput

"""story #2166(2026-07-25, 까심 QA) — `uvx sprintable` 첫 실행 시 SPRINTABLE_API_URL 미설정
에러 메시지가 "무엇을 설정해야 하는지·어디서 얻는지"를 실제로 알려주는지 고정한다.

이전엔 "환경변수가 필요하다"까지만 말하고 값·출처는 침묵해 OSS 사용자의 첫 명령이 안내 없이
죽었다(유입손실). self-host 예시값만 메시지에 박고 prod URL은 절대 하드코딩하지 않는다 —
그러면 self-host 사용자를 조용히 다른 백엔드로 연결시키는 더 나쁜 결함이 된다(story 본문 ①
기각 근거와 동일).
"""
from __future__ import annotations

import sys

import pytest


def test_missing_api_url_message_gives_next_step(monkeypatch, capsys):
    from sprintable_mcp import __main__ as main_mod
    from sprintable_mcp.config import settings

    monkeypatch.setattr(settings, "sprintable_api_url", "")

    with pytest.raises(SystemExit) as exc_info:
        main_mod.main()

    assert exc_info.value.code == 1
    err = capsys.readouterr().err
    # 값이 무엇인지(백엔드 base URL)를 설명해야
    assert "base URL" in err or "backend" in err
    # self-host 예시를 그 자리에서 바로 복붙 가능한 형태로 줘야
    assert "SPRINTABLE_API_URL=http://localhost:8000" in err
    # hosted 사용자는 어디를 보라는 안내가 있어야
    assert "pypi.org/project/sprintable" in err
    # ⛔prod 백엔드 URL을 메시지에 하드코딩하지 않는다(① 기각 근거 — self-host 사용자를
    # 조용히 다른 백엔드로 연결시키는 더 나쁜 결함 방지).
    assert "run.app" not in err
    assert "sprintable-backend-prod" not in err


def test_missing_api_url_exits_before_agent_key_check(monkeypatch, capsys):
    """SPRINTABLE_API_URL 체크가 AGENT_API_KEY 체크보다 먼저라 두 값 다 없어도 URL 메시지만
    나와야(한 번에 하나씩 안내 — 무회귀 고정)."""
    from sprintable_mcp import __main__ as main_mod
    from sprintable_mcp.config import settings

    monkeypatch.setattr(settings, "sprintable_api_url", "")
    monkeypatch.setattr(settings, "agent_api_key", "")

    with pytest.raises(SystemExit):
        main_mod.main()

    err = capsys.readouterr().err
    assert "AGENT_API_KEY" not in err

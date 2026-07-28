"""story #2274(C-1c) — 「테스트가 모듈 전역을 복원 없이 대입하는」 병의 재발 방지 가드.

⛔완벽하지 않다(오르테가군 지시대로 «못 잡는 것을 선언»한다) — 이 가드가 잡는 것과 못 잡는 것:

잡는 것:
  `app.routers.cron.CRON_SECRET`(오늘 실제로 사고 난 그 전역)에 monkeypatch를 거치지 않고
  직접 대입하는 코드가 tests/ 어딘가에 다시 생기면 이 테스트가 RED된다(정적 텍스트 스캔).
  이 전역을 골라 지킨 이유: verify_cron()이 읽고, cron.py 자신 + verdict_capture.py 둘 다
  소비하는 것을 오늘 확認했다(#2274 원인 규명) — 지금 아는 것 중 blast radius가 가장 넓다.

못 잡는 것(정직하게 남긴다):
  ①CRON_SECRET **이외의** 모듈 전역을 복원 없이 대입하는 새 사고 — 이 가드는 그 전역
    하나만 지킨다. 클래스 전체를 막는 가드가 아니다.
  ②`from x import y; y = something`처럼 **이름 재바인딩**(모듈 attribute 대입이 아닌) 형태의
    오염 — 문법적으로 로컬 변수 정의와 구분이 안 돼 정적 스캔으로 못 잡는다.
  ③런타임에 동적으로 생성된 문자열로 attribute를 대입하는 경우(`setattr(mod, name, val)`) —
    이 스캔은 `mod.ATTR = ` 리터럴 패턴만 본다.
  ④이미 monkeypatch로 감쌌지만 monkeypatch 자체를 잘못 쓴 경우(예: 잘못된 대상에 setattr) —
    이 가드는 "monkeypatch라는 단어가 근처에 있는가"만 보지 그 사용이 맞는지는 안 본다.

전수 스윕 결과(2026-07-28, #2274 AC1) — 훑은 범위: `import app.X as Y` 형태로 alias
import된 모듈에 대한 `Y.ATTR = ` 직접 대입 전수(34개 alias) + `os.environ[...] = `/`.pop`/
`.update` 직접 조작 전수 + `settings.attr = ` 직접 대입 전수. 못 훑은 범위: 위 ②③④ 그대로.
발견: 이 파일이 고친 `test_s0_2_chat_migration.py`(NEXT_PUBLIC_APP_URL, monkeypatch.setenv로
전환) 1건 제외 전부 이미 올바르게 복원됨(try/finally 또는 patch.dict/monkeypatch) — 오늘의
CRON_SECRET 건이 유일한 미복원 사례였다.
"""
from __future__ import annotations

import re
from pathlib import Path

_TESTS_DIR = Path(__file__).parent

# ⛔이 파일 자신은 스캔 대상에서 제외(가드 코드 자체가 이 패턴을 문서화하려고 언급할 수 있다).
_SELF = Path(__file__).name

# cron_module.CRON_SECRET = ... 또는 cron.CRON_SECRET = ... 형태(alias 무관, 변수명이
# "cron"을 포함하고 .CRON_SECRET = 로 끝나는 대입) — monkeypatch.setattr(...) 호출은 별도
# 문법(함수 호출이라 이 대입 패턴에 안 걸림)이라 오탐하지 않는다.
_DANGEROUS_PATTERN = re.compile(r"\bcron\w*\.CRON_SECRET\s*=(?!=)")


def test_no_unguarded_cron_secret_assignment_in_tests():
    """cron.CRON_SECRET(오늘 실제 사고 난 전역)을 직접 대입하는 코드가 tests/에 있으면 안
    된다 — monkeypatch.setattr(cron_module, "CRON_SECRET", ...)를 쓸 것(자동 복원)."""
    offenders: list[str] = []
    for path in sorted(_TESTS_DIR.glob("*.py")):
        if path.name == _SELF:
            continue
        text = path.read_text()
        for m in _DANGEROUS_PATTERN.finditer(text):
            line_no = text[:m.start()].count("\n") + 1
            offenders.append(f"{path.name}:{line_no}: {m.group(0)}")

    assert not offenders, (
        "tests/ 에 cron.CRON_SECRET 직접 대입(monkeypatch 미사용)이 발견됐다 — "
        "오늘(#2274) 실제로 CI를 전역 401로 깬 그 사고 클래스다. "
        "monkeypatch.setattr(cron_module, 'CRON_SECRET', ...)로 바꿀 것:\n"
        + "\n".join(offenders)
    )

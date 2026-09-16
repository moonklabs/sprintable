"""story #3933 — MCP 에러 응답 196건이 BE `detail` 원문을 합니다체 그대로 fleet
에이전트에게 통과시키던 구조 결함. 처방은 문장 전환이 아니라 `sprintable_mcp/response.py`
의 공통 `err()` 경로 재설계: `err(exc)`가 `SprintableApiError`면 `.code/.message/.detail`을
그대로 구조화하고, 그 밖 예외는 `code="UNKNOWN"`으로 조립한다.

`tools/*.py`의 123개 핸들러는 전부 같은 `except Exception as exc: return err(exc)` 리터럴
(예전엔 `err(str(exc))`)로 동일하다 — 개별 핸들러 로직은 안 건드리고(AC1 "핸들러 개별 편집
0") 기계적 sed 치환 한 번으로 바꿨다. 이 가드는 그 상태(①`err(str(`가 다시는 안 들어옴
②`except Exception as exc:` 바로 다음 실행문이 전부 `return err(exc)`)를 정적으로 고정한다
— 개별 핸들러가 나중에 실수로 `err(str(exc))`로 되돌리거나 다른 변종을 쓰면 이 테스트가
이름째 잡는다.
"""
from __future__ import annotations

import re
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent / "sprintable_mcp" / "tools"

_OLD_PATTERN_RE = re.compile(r"err\(str\(exc\)\)")
_EXCEPT_RE = re.compile(r"^(\s*)except Exception as exc:\s*$")
_EXPECTED_NEXT_RE = re.compile(r"^\s*return err\(exc\)\s*$")


def _tool_files() -> list[Path]:
    return sorted(TOOLS_DIR.glob("*.py"))


def test_no_tool_file_uses_the_old_err_str_exc_pattern():
    """AC — `err(str(exc))`(구조 소실 패턴) 재발 0건."""
    offenders: list[str] = []
    for path in _tool_files():
        content = path.read_text(encoding="utf-8")
        if _OLD_PATTERN_RE.search(content):
            offenders.append(path.name)

    assert not offenders, (
        "err(str(exc)) 패턴이 재발한 파일(구조 소실 — code/detail이 str()로 뭉개짐, "
        "story #3933 실사고 재현): " + ", ".join(offenders)
    )


def _except_block_lines(lines: list[str], except_line_idx: int, except_indent: int) -> list[str]:
    """`except Exception as exc:` 블록 본문(그보다 들여쓰기 깊은 연속 줄들)만 뽑는다."""
    body: list[str] = []
    for k in range(except_line_idx + 1, len(lines)):
        line = lines[k]
        if line.strip() == "":
            body.append(line)
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent <= except_indent:
            break
        body.append(line)
    return body


def test_every_except_exception_as_exc_block_returns_bare_err_exc():
    """AC — `except Exception as exc:` 블록의 return문은 예외 없이 `return err(exc)` 하나
    모양이어야 한다(로깅 등 부수 문장은 허용 — chat.py send_chat_message의 orphan-attachment
    경고 로그처럼 정당한 사례가 실제로 있다, story #3933 그라운딩으로 확認). 다른 반환 변종
    (`return err(str(exc))`류)이 섞이면 이 구조 재설계의 일관성이 깨진다."""
    offenders: list[str] = []
    return_re = re.compile(r"^\s*return\s")
    for path in _tool_files():
        lines = path.read_text(encoding="utf-8").split("\n")
        for i, line in enumerate(lines):
            m = _EXCEPT_RE.match(line)
            if not m:
                continue
            except_indent = len(m.group(1))
            body = _except_block_lines(lines, i, except_indent)
            return_lines = [b for b in body if return_re.match(b)]
            if not return_lines:
                offenders.append(f"{path.name}:{i + 1} → except 블록에 return문 없음")
                continue
            for r in return_lines:
                if not _EXPECTED_NEXT_RE.match(r):
                    offenders.append(f"{path.name}:{i + 1} → return문: {r.strip()!r}")

    assert not offenders, (
        "`except Exception as exc:` 블록의 return이 `return err(exc)`가 아닌 자리 발견(다른 "
        "변종 혼입 — story #3933 구조 일관성 깨짐):\n" + "\n".join(offenders)
    )


def test_positive_control_old_pattern_would_be_caught(tmp_path):
    """양성대조 — 위 두 가드가 실제로 「구형 패턴」을 잡아내는지, 진짜 파일이 아니라 합성
    픽스처로 고정한다(가드 로직 자체의 mutation-kill 확인, 실 tools/*.py 훼손 없이)."""
    fixture = tmp_path / "fake_tool.py"
    fixture.write_text(
        "async def handler(args):\n"
        "    try:\n"
        "        return ok(1)\n"
        "    except Exception as exc:\n"
        "        return err(str(exc))\n",
        encoding="utf-8",
    )
    content = fixture.read_text(encoding="utf-8")
    assert _OLD_PATTERN_RE.search(content), "합성 픽스처 자체가 구형 패턴을 담고 있어야 양성대조가 성립한다"

    # 정당한 사례(chat.py send_chat_message 동형) — 로깅 후 return err(exc)는 통과해야 함.
    fixture2 = tmp_path / "fake_tool2.py"
    fixture2.write_text(
        "async def handler(args):\n"
        "    try:\n"
        "        return ok(1)\n"
        "    except Exception as exc:\n"
        "        logger.warning('oops')\n"
        "        return err(exc)\n",
        encoding="utf-8",
    )
    lines2 = fixture2.read_text(encoding="utf-8").split("\n")
    m2 = _EXCEPT_RE.match(lines2[3])
    assert m2
    body2 = _except_block_lines(lines2, 3, len(m2.group(1)))
    return_lines2 = [b for b in body2 if re.match(r"^\s*return\s", b)]
    assert all(_EXPECTED_NEXT_RE.match(r) for r in return_lines2), "로깅 후 return err(exc)인 정당한 사례를 오탐하면 안 된다"

    # 진짜 변종(구형 패턴이 return문 안에 남은 경우) — 잡혀야 함.
    fixture3 = tmp_path / "fake_tool3.py"
    fixture3.write_text(
        "async def handler(args):\n"
        "    try:\n"
        "        return ok(1)\n"
        "    except Exception as exc:\n"
        "        logger.warning('oops')\n"
        "        return err(str(exc))\n",
        encoding="utf-8",
    )
    lines3 = fixture3.read_text(encoding="utf-8").split("\n")
    m3 = _EXCEPT_RE.match(lines3[3])
    assert m3
    body3 = _except_block_lines(lines3, 3, len(m3.group(1)))
    return_lines3 = [b for b in body3 if re.match(r"^\s*return\s", b)]
    assert not all(_EXPECTED_NEXT_RE.match(r) for r in return_lines3), "return err(str(exc)) 변종을 잡아내지 못함"

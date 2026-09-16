"""story #3963(적어둠 — verdict 원장 배선, PO 확定 2026-09-16 16:08Z) — GitHub PR issue_comment
본문에서 판정 3형을 파싱한다. `POST /capture-review`(app/routers/verdict_capture.py) 호출용
`{role, result}` 또는 판정 아님(None)을 판별하는 순수 함수만 — HTTP 호출은 워크플로 쪽 몫.

## 실 표본(2026-09-16, PR#4173·#3983·#4172·#4201·#4362·#4360·#4350·#4348 grep 실측)
1. **codex QA verdict**(가장 안정적, role="qa"): 첫 줄이 정확히
   ``## QA verdict: approved (qa:pass)`` 또는 ``## QA verdict: changes requested (qa:changes)``.
2. **PO review/리뷰**(role="po"): 첫 줄이 ``## PO review — PASS`` 류 또는 ``## PO 리뷰 — PASS``류
   (영/한 혼용·시기별 접미사 자유형이라 접두만 고정, "PASS"/"CHANGES" 낱말 존재로 판정).
3. **명시적 비-verdict**(카디르가 codex exec 장애 中 대체 게시하는 관찰 코멘트) — 문구에
   "verdict/approve 아님"이 있으면 위 1/2 패턴처럼 보여도 무조건 skip(None). 실측 근거:
   PR#4360/#4362의 "## 읽기 검수 관찰 — codex exec 사용불가 기간 임시(verdict/approve 아님,
   페드루 지시 2026-09-16 11:23Z 패턴)" 코멘트.
"""
from __future__ import annotations

import re

_NON_VERDICT_MARKER = "verdict/approve 아님"

_CODEX_VERDICT_RE = re.compile(
    r"^##\s*QA verdict:\s*(approved|changes requested)\b", re.IGNORECASE | re.MULTILINE,
)
_PO_REVIEW_RE = re.compile(
    r"^##\s*PO\s*(?:review|리뷰)\s*—\s*(PASS|CHANGES)\b", re.MULTILINE,
)
_SID_RE = re.compile(r"\[SID:\s*(\d{1,6})\]|fix\(#(\d{1,6})\):", re.IGNORECASE)


def parse_verdict_comment(body: str) -> dict[str, str] | None:
    """댓글 본문 → {"role": "qa"|"po", "result": "pass"|"fail"} 또는 판정 아니면 None.

    ⛔순서 중요 — 비-verdict 마커부터 검사한다(카디르의 codex 대체 관찰 코멘트가 우연히
    "PASS"/"approved" 낱말을 포함할 가능성을 원천 배제, 실측상 이 마커 코멘트들은 그 낱말
    자체가 없었지만 방어적으로 먼저 검사)."""
    if _NON_VERDICT_MARKER in body:
        return None

    m = _CODEX_VERDICT_RE.search(body)
    if m:
        outcome = m.group(1).lower()
        return {"role": "qa", "result": "pass" if outcome == "approved" else "fail"}

    m = _PO_REVIEW_RE.search(body)
    if m:
        outcome = m.group(1).upper()
        return {"role": "po", "result": "pass" if outcome == "PASS" else "fail"}

    return None


def parse_story_number(pr_title: str, pr_body: str | None = None) -> int | None:
    """PR 제목(우선) 또는 본문에서 `[SID:NNNN]`/`fix(#NNNN):` 파싱 — app/services/
    verdict_capture.py::parse_story_number와 동일 정규식(관례 재사용, 새 규칙 발명 0)."""
    m = _SID_RE.search(pr_title)
    if not m and pr_body:
        m = _SID_RE.search(pr_body)
    if not m:
        return None
    try:
        return int(m.group(1) or m.group(2))
    except (ValueError, TypeError):
        return None


def main() -> int:
    """CLI 진입점 — 워크플로가 comment body(stdin)·PR title/body(argv)를 넘기면 JSON 1줄
    출력(판정 아니면 빈 줄). GH Actions `run:` 스텝에서 바로 파이프하기 쉬운 모양."""
    import json
    import sys

    body = sys.stdin.read()
    pr_title = sys.argv[1] if len(sys.argv) > 1 else ""
    pr_body = sys.argv[2] if len(sys.argv) > 2 else ""

    verdict = parse_verdict_comment(body)
    if verdict is None:
        print("")
        return 0

    story_number = parse_story_number(pr_title, pr_body)
    if story_number is None:
        print("")
        return 0

    print(json.dumps({**verdict, "story_number": story_number}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

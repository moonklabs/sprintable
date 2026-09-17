"""story #3963(적어둠 — verdict 원장 배선, PO 확定 2026-09-16) — GitHub PR issue_comment
본문에서 판정 2형을 파싱한다. `_process_webhook_event`(app/routers/verdict_capture.py)의
issue_comment 분기가 이 순수 함수를 그대로 쓴다(HTTP·DB 0 — 판정 자체만).

## 구조 처방(페드루 PO 확定 2026-09-17, 4366 CHANGES 2) — 한글 문자열 리터럴 자체를 없앤다
이전 버전은 "PO 리뷰"(한글) 헤더와 "verdict/approve 아님" 마커를 코드 리터럴로 들고
있었는데, 둘 다 BE 한글 사용자 문장 가드(story #3779/#3924)의 "baseline은 신규 파일에
grandfather 자체를 금지"는 제약과 충돌했다(EXEMPT_FILES는 i18n_catalog.py류 "정본 보관
자리" 전용이라 이 파일엔 안 맞음, 페드루 판단). 처방은 우회 인코딩이 아니라 구조 수정:

1. **헤더는 코멘트 첫 줄만 본다**(`body.split("\\n", 1)[0]`에 `re.match` — MULTILINE
   서치 아님). 본문 인용문 안에 우연히 같은 헤더 문구가 섞여 있어도 안 걸리는 부수 효과.
2. **PO 헤더는 영문만** — ``## PO review — PASS`` / ``## PO review — CHANGES``(대소문자
   무관). 페드루 자신의 헤더 규율 고정(2026-09-16 16:33Z, "앞으로 `## PO review —
   PASS|CHANGES` 고정") 이후로 옛 한글 「PO 리뷰」 헤더가 이 웹훅(`action=created`
   새 코멘트만 봄) 경로로 도달할 일 자체가 없다 — 지원 안 함이 아니라 사실상 재발
   경로가 없어진 것.
3. **명시적 비-verdict 마커 제거** — 카디르의 codex 대체 관찰 코멘트(예: "## 읽기 검수
   관찰 — ...")는 첫 줄이 애초에 QA/PO 헤더 패턴과 안 맞아 1의 첫 줄 제한만으로
   자동 배제된다(마커 없이도 동일 결과).

## 실 표본(2026-09-16, PR#4173·#3983·#4172·#4201·#4362·#4360·#4350·#4348 grep 실측)
1. **codex QA verdict**(가장 안정적, role="qa"): 첫 줄이 정확히
   ``## QA verdict: approved (qa:pass)`` 또는 ``## QA verdict: changes requested (qa:changes)``.
2. **PO review**(role="po"): 첫 줄이 ``## PO review — PASS`` 류(위 구조 처방 2 참고).

story_number 파싱은 새로 짓지 않는다 — `app.services.verdict_capture.parse_story_number`를
그대로 재사용(같은 `[SID:NNNN]`/`fix(#NNNN):` 관례, 정규식 중복 0).
"""
from __future__ import annotations

import re

_CODEX_VERDICT_RE = re.compile(
    r"^##\s*QA verdict:\s*(approved|changes requested)\b", re.IGNORECASE,
)
_PO_REVIEW_RE = re.compile(
    r"^##\s*PO review\s*—\s*(PASS|CHANGES)\b",
)


def parse_verdict_comment(body: str) -> dict[str, str] | None:
    """댓글 본문 첫 줄 → {"role": "qa"|"po", "result": "pass"|"fail"} 또는 판정 아니면
    None. 첫 줄만 보는 이유·PO 헤더 영문 전용 이유는 모듈 docstring 「구조 처방」 참고."""
    first_line = body.split("\n", 1)[0]

    m = _CODEX_VERDICT_RE.match(first_line)
    if m:
        outcome = m.group(1).lower()
        return {"role": "qa", "result": "pass" if outcome == "approved" else "fail"}

    m = _PO_REVIEW_RE.match(first_line)
    if m:
        outcome = m.group(1).upper()
        return {"role": "po", "result": "pass" if outcome == "PASS" else "fail"}

    return None

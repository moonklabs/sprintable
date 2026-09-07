"""story #3647(CI·QA 관문·소형·긴급, 페드루 PO 確定 2026-09-07, 선생님 12:17Z 지시) —
qa:pass 근거가 되는 최신 「## QA verdict: approved (qa:pass)」 코멘트 본문에
`codex session: <uuid>`·`model: <이름>` 두 줄이 있는지 형식만 검사한다. 2026-04
선생님-카디르 합의(QA 판정=Claude 대화 + codex exec 실제 실행, Claude 단독 approve
금지)를 기계로 강제하는 첫 관문 — 09-01~02·09-05~07 두 창에서 codex 미사용 verdict가
~300건 나간 실사고(선생님 실측) 재발 방지.

⚠️잃는 것(선언) — 형식만 본다. GitHub 러너는 이 머신의 `~/.codex/sessions` 로그를
볼 수 없어(다른 프로세스·다른 장비) 세션 id가 실재하는지는 검증 못 한다 — UUID
모양의 문자열 아무거나 적으면 통과한다. 실재 검증은 PO 재출근 점검(세션 로그와
verdict 대조)이 사람 축으로 메운다(범위 밖 — 후속 후보: 세션 id를 sprintable
서버에 등록).

`.github/actions/qa-verdict-codex-session-check/action.yml`이 이 스크립트를
stdin(최신 approved verdict 코멘트 본문)으로 호출한다 — gh api/jq로 코멘트를
찾는 것은 그 액션(bash)이 맡고, 이 스크립트는 순수 문자열 판정만(pytest로
검산 가능하게 분리, verdict-head-check의 인라인-bash-only 전례와 달리 이
축은 selftest+뮤테이션이 스토리 AC라 별도 함수로 뺐다)."""
from __future__ import annotations

import re
import sys

_SESSION_RE = re.compile(
    r"codex session:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
_MODEL_RE = re.compile(r"model:\s*\S+", re.IGNORECASE)


def missing_codex_session_lines(body: str) -> list[str]:
    """빠진 표식의 사람용 라벨 목록(둘 다 있으면 빈 리스트) — codex session은 UUID
    모양(8-4-4-4-12 hex)까지 요구하고(형식 검사, AC3 선언대로 실재는 안 봄), model은
    "model:" 뒤에 공백 아닌 토큰이 하나라도 있으면 통과(이름 자체를 화이트리스트로
    제한하지 않는다 — 모델명이 바뀌어도 이 가드가 안 깨지게)."""
    missing: list[str] = []
    if not _SESSION_RE.search(body):
        missing.append("codex session: <uuid>")
    if not _MODEL_RE.search(body):
        missing.append("model: <이름>")
    return missing


def main() -> int:
    body = sys.stdin.read()
    missing = missing_codex_session_lines(body)
    if missing:
        print(
            "::error title=qa:pass verdict missing codex exec session line::"
            "codex exec 세션 id 없음 — 위임 실행 없이 낸 verdict는 관문을 통과할 수 "
            f"없다(2026-04 선생님-카디르 합의). 최신 approved verdict 코멘트에 빠진 줄: "
            f"{', '.join(missing)}"
        )
        return 1
    print(
        "codex session·model 두 줄 확認 — QA verdict가 codex exec 위임 표식을 갖고 있다.",
        file=sys.stderr,
    )
    return 0


# story #3647 AC2 — selftest 3(있음→통과·없음→실패·형식 틀림→실패) + PO 지시 v7 표본.
# 이 repo-root 스크립트는 backend/ 패키지 밖이라 pytest 수집 경로에 안 잡힌다(conftest
# 없음) — `ci.yml`의 기존 관례(`verify-no-new-repeated-row-action-names -- --selftest`)
# 를 그대로 따라 스크립트 자신에 --selftest 플래그로 픽스처를 심는다(새 테스트 러너
# 배선 0).
_SELFTEST_CASES: list[tuple[str, str, bool]] = [
    (
        "session+model 둘 다 있음(v4) → 통과",
        "## QA verdict: approved (qa:pass)\n**Head:** `abc1234`\ncodex session: 5b6f1a2c-9d3e-4f10-8a7b-1c2d3e4f5a6b\nmodel: gpt-6-astra\n",
        True,
    ),
    (
        "session+model 둘 다 있음(v7, 페드루 PO 지시 예시) → 통과",
        "## QA verdict: approved (qa:pass)\n**Head:** `abc1234`\ncodex session: 01a07be9-cad1-7b10-aaa1-91a7d0c1efe6\nmodel: gpt-6-astra\n",
        True,
    ),
    (
        "둘 다 없음(구형 verdict) → 실패",
        "## QA verdict: approved (qa:pass)\n**Head:** `abc1234`\nAPPROVE — 로그인 흐름 확認.\n",
        False,
    ),
    (
        "session 줄이 있지만 UUID 형식이 틀림(짧은 hex) → 실패",
        "## QA verdict: approved (qa:pass)\ncodex session: abc123\nmodel: gpt-6-astra\n",
        False,
    ),
    (
        "model 줄만 없음(session은 정상) → 실패",
        "## QA verdict: approved (qa:pass)\ncodex session: 5b6f1a2c-9d3e-4f10-8a7b-1c2d3e4f5a6b\n",
        False,
    ),
]


def _run_selftest() -> int:
    failures = 0
    for label, body, expect_ok in _SELFTEST_CASES:
        missing = missing_codex_session_lines(body)
        actual_ok = not missing
        status = "OK" if actual_ok == expect_ok else "FAIL"
        if status == "FAIL":
            failures += 1
        print(f"[{status}] {label} — missing={missing!r}")
    if failures:
        print(f"selftest: {failures}/{len(_SELFTEST_CASES)} 실패")
        return 1
    print(f"selftest: {len(_SELFTEST_CASES)}/{len(_SELFTEST_CASES)} 통과")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    raise SystemExit(main())

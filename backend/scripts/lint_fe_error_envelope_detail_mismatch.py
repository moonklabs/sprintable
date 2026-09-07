"""story #3601(FE·결함 클래스, 디디 전수 표 2026-09-07) — BE 전역 HTTPException 핸들러
(app/main.py::http_exception_handler)의 실제 응답 봉투는 항상 `{"data":null,"error":
{"code":...,"message":...},"meta":null}`이다. FastAPI raw shape(`{"detail":...}`)가
그대로 통과하는 경로는 우리 앱엔 없다(커스텀 핸들러가 HTTPException을 전부 가로챈다) —
유일한 예외는 FastAPI 자체 Pydantic 422(RequestValidationError, 커스텀 핸들러를 안
거친다)뿐이다.

그런데 apps/web 코드 곳곳이 `body?.detail?.message`·`body?.detail?.code`를 «1차
소스»로 읽었다 — 그 필드는 우리 봉투에 없으니 항상 undefined, 조용히 폴백 메시지로
떨어지거나(에러 메시지 소실) 특정 code 분기가 영구 사망한다(예: comment_collection_
unsupported). 실제 사고: story #3596 그라운딩(2026-09-07 00:45Z, create 409의
existing_reply_id가 `.detail`이 아니라 `.error`에 있었다).

⛔이 가드가 잡는 패턴: `.detail?.message` 또는 `.detail?.code`(옵셔널 체이닝으로 바로
message/code에 접근하는 형 — 실전 버그의 정확한 모양). 매치된 (file, line)이
`_ALLOWED_MATCHES`(줄 단위 화이트리스트, 사유 필수)에 없으면 위반.

⛔이 가드가 «못 잡는» 것(오탐 방지 우선, 다른 lint_*.py와 동일 원칙):
  ① `.detail`을 변수에 옮겨 담은 뒤 나중에 `.message`/`.code`를 읽는 형
     (예: `const detail = body.detail; detail?.message`) — lib/avatar-upload.ts의
     실제 사고가 이 모양이다(`json.data ?? json.detail ?? fallback`, `.detail?.`
     체이닝 자체가 없다). 정적 패턴 매칭이 잡을 수 없는 축 — 리뷰가 봐야 한다.
  ② `.detail`이 다른 키(`?.[0]`·구조분해 등)로 옮겨진 뒤 읽히는 형.
  ③ FastAPI 기본 Pydantic 422(`{detail:[{loc,msg,type}]}`)를 읽는 진짜 합법적
     자리(content/validate-scheduled-at.ts) — 이 파일은 우연히 `.detail?.` 체이닝
     형을 안 써서(배열 전체를 변수에 담아 `.find()`) 이 정규식엔 애초에 안 걸린다.
     혹시 나중에 `.detail?.`형으로 다시 쓰이면 오탐이 아니라 진짜 예외라 별도
     허용 목록 등재가 필요하다(지금은 0건).

허용 목록에 오른 자리는 전부 «이미 `.error`를 1순위로 읽고, `.detail`은 무해한 죽은
폴백으로만 남긴» 자리다(organization/events/page.tsx ×3·channel-posts/[draftId]/
page.tsx:509 — 이 마지막 자리는 story #3596/#3953이 만든 `.error` 우선 폴백, #3601
스코프 밖). 새 자리가 이 목록에 또 오르려면 반드시 같은 근거(.error 우선 확認)와
사유를 남길 것 — 그냥 억제하려고 추가하면 이 가드의 존재 이유가 사라진다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_PATTERN = re.compile(r"\.detail\?\.(message|code)\b")

# PO 리뷰 관례(model_registration lint와 동형) — 줄 단위 dict, 값=사유. 새 항목은
# 반드시 ".error를 이미 1순위로 읽는다"는 근거를 사유에 적을 것. 이 dict의 key
# 집합은 tests/test_3601_error_envelope_detail_mismatch_lint.py::
# test_allowlist_is_pinned_to_known_safe_lines에 pin돼 있어 조용히 늘어날 수 없다.
_ALLOWED_MATCHES: dict[str, str] = {
    "src/app/(authenticated)/organization/events/page.tsx:116": (
        "`body?.error?.message ?? body?.detail?.message ?? ...` — .error가 이미 1순위, "
        ".detail은 무해한 죽은 폴백(story #3601 그라운딩)."
    ),
    "src/app/(authenticated)/organization/events/page.tsx:546": (
        "위와 동형(resBody 변수명만 다름)."
    ),
    "src/app/(authenticated)/organization/events/page.tsx:755": (
        "위와 동형."
    ),
    "src/app/(authenticated)/content/channel-posts/[draftId]/page.tsx:509": (
        "story #3596/#3953이 만든 `.error?.message ?? .detail?.message ?? ...` — "
        ".error 1순위 확認 완료, #3601 스코프 밖(그 스토리가 이미 닫은 자리)."
    ),
}

SCAN_ROOT = "apps/web/src"
_EXCLUDE_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")


def find_violations(path: Path, label: str | None = None) -> list[str]:
    """단일 파일 스캔 — 허용 목록에 없는 위반 라인을 `{label}:{lineno}: {line}` 형태로
    반환. label 생략 시 path 그대로."""
    text = path.read_text(encoding="utf-8")
    label = label or str(path)
    violations: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if _PATTERN.search(line) and f"{label}:{lineno}" not in _ALLOWED_MATCHES:
            violations.append(f"{label}:{lineno}: {line.strip()}")
    return violations


def scan(repo_root: Path) -> list[str]:
    violations: list[str] = []
    scan_dir = repo_root / SCAN_ROOT
    for f in sorted(scan_dir.rglob("*.ts")) + sorted(scan_dir.rglob("*.tsx")):
        if f.name.endswith(_EXCLUDE_SUFFIXES):
            continue
        violations.extend(find_violations(f, label=str(f.relative_to(repo_root / "apps/web"))))
    return violations


def main() -> int:
    # backend/scripts/ -> backend -> repo root
    repo_root = Path(__file__).resolve().parent.parent.parent
    violations = scan(repo_root)
    if violations:
        print(
            "FAIL: `.detail?.message`/`.detail?.code`가 새로 등장했다(story #3601) — "
            "BE 전역 오류 봉투는 {data,error,meta}뿐이라 `.detail`은 항상 undefined다. "
            "`lib/api-error-message.ts::extractBackendErrorMessage(body)`(.error 우선)를 "
            "쓰거나, 정말 안전하면(.error를 이미 먼저 읽는 무해한 죽은 폴백) 이 스크립트의 "
            "_ALLOWED_MATCHES에 사유와 함께 등재할 것:"
        )
        for v in violations:
            print(f"  {v}")
        return 1
    print(f"OK: `.detail?.(message|code)` 신규 위반 0건 (허용 목록 {len(_ALLOWED_MATCHES)}건 유지)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

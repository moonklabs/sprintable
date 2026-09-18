#!/usr/bin/env python3
"""story #3897 — backend/tests/**가 실제로 참조하는 FE(apps/web/·packages/) 경로를 «코드로
추출»한다(손으로 적는 allowlist 아님). ci.yml의 detect-changed-scope가 이 목록을 써서
«apps/web/만 바뀐 PR은 백엔드-무관»이라는 기존 판정을 보정한다 — 3889 사고(PR 4294가
apps/web/messages/ko.json을 바꿨지만 BE i18n_catalog와의 파리티 테스트
test_3815_youtube_publish.py가 그 파일을 직접 읽어 대조하는데도, 경로 기반 스킵이 그
참조를 몰라 develop CI에서만 RED가 터졌다)의 구조 처방.

CHANGES 1(페드루 PO 리뷰, 2026-09-15) — 최초 bash 버전은 아래 ①②만 봤는데, 실측(PO)에서
`os.path.join(os.path.dirname(__file__), "..", "..", "apps", "web", "src", ...)` 콤마
세그먼트 형태(여러 줄에 걸침) 4곳(test_e_org_multi_s5_3_polar_checkout.py 등)이 안 걸려
그 파일들이 읽는 apps/web/src/... 경로가 «조용히» 빠지는 걸 발견 — 이 카드가 막으려는
바로 그 클래스(«알려진 형태만 보고 안심»)가 스크립트 자신 안에서 재발했다. 처방 2겹:
  ③ 형태 추가 — os.path.join(...) 호출을 통째로(줄바꿈 포함) 찾아 그 안의 모든 따옴표
     세그먼트를 뽑고, ".." 세그먼트는 버리고 "apps"/"packages" 세그먼트부터 재조립.
  완전성 fail-closed — 파일에 `"apps"`/`"packages"`(정확히 그 토큰, 따옴표로 감싼) 또는
     `"apps/web/`로 시작하는 따옴표 문자열이 있는데, 그 파일에서 ①②③ 어디로도 0건이면
     「4번째 미지의 형태」로 보고 스크립트 전체를 fail-closed(exit 1)한다 — "그 파일만
     조용히 빠뜨리고 넘어가는" 걸 원천 차단한다(정확히 이번에 재발한 클래스).

Python으로 다시 쓴 이유: os.path.join(...) 콤마 세그먼트 호출이 여러 줄에 걸쳐 있어
줄 단위 grep(bash 버전)로는 안전하게 못 잡는다 — 문자열 리터럴 경계를 존중하는 괄호
매칭(파일 #3886의 브레이스 매칭 선례와 같은 이유)이 필요하다.

추출 대상 3가지 형태(backend/tests/**/*.py 실사용 실측):
  ① 한 문자열 리터럴: "apps/web/messages/ko.json"(디렉터리도 포함 — 확장자 유무로 거르지
     않는다. deeplink_contract_lib.py의 APPS_WEB_APP_DIR처럼 디렉터리 루트를 나중에
     조합해 쓰는 실제 코드가 있다).
  ② `/` 세그먼트 조인: "apps" / "web" / "messages" / "ko.json"(pathlib 연산자 스타일).
  ③ os.path.join(...) 콤마 세그먼트: os.path.join(dirname(__file__), "..", "..", "apps",
     "web", "src", ...) — ".." 세그먼트는 버리고 "apps"/"packages"부터 재조립.

셋 다 실제 큰따옴표로 감싼 리터럴만 잡는다 — 괄호 안 설명문("...apps/web/foo.ts 참고")
이나 인용부호 없는 산문("apps/web 쪽")은 정규식이 여는/닫는 " 를 요구해 자연히 걸러진다.
이건 의도적 — 과다포함은 안전한 방향(backend_relevant=true가 늘어 CI 시간이 조금 늘 뿐)
이고, 과소포함이 위험한 방향(실 파리티 테스트가 놓쳐 develop에서만 터짐)이라 grep 기반의
보수적 초과 추출을 택한다.

사용법: extract_fe_paths_referenced_by_backend_tests.py [test_root=backend/tests]
stdout: 추출된 경로 1줄당 1개(정렬·중복 제거).
exit 0 = 1건 이상 추출(정상, 완전성 위반 0건).
exit 1 = ⓐ 추출 0건 ⓑ test_root 없음/빈 ⓒ 완전성 위반(어떤 파일이 apps/packages 리터럴을
         갖고 있는데 3형 어디로도 안 걸림) — 셋 다 fail-closed. 호출부는 「추출 실패」와
         「FE 의존 없음」을 절대 같은 걸로 읽지 않는다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_FORM1_RE = re.compile(r'"((?:apps/web|packages)/[A-Za-z0-9_./-]+)"')
_FORM2_RE = re.compile(r'"(?:apps|packages)"(?:\s*/\s*"[A-Za-z0-9_.-]+")+', re.DOTALL)
_QUOTED_SEG_RE = re.compile(r'"([A-Za-z0-9_.-]+)"')
_OS_PATH_JOIN_RE = re.compile(r'os\.path\.join\(')
# (?<!") — 여는 큰따옴표 앞에 또 다른 "가 있으면(트리플쿼트 독스트링 시작 `"""apps/web/...`
# 처럼) 매치하지 않는다. 그 경우의 첫 "는 진짜 문자열 리터럴의 시작이 아니라 `"""` 구분자의
# 일부(예: test_email_shell.py:23 — 독스트링이 우연히 "apps/web/..."로 시작해 3형 어디로도
# 안 걸리는 것처럼 보였으나, 실은 그 테스트가 FE 파일을 아예 읽지 않는 손동기 값 비교라
# 진짜 4번째 형태가 아니었다 — 그라운딩으로 확認).
_PATH_SUGGESTIVE_RE = re.compile(r'(?<!")"apps"|(?<!")"packages"|(?<!")"apps/web/')


def _find_matching_paren(text: str, open_idx: int) -> int:
    """text[open_idx] == '(' 인 지점에서 짝이 맞는 ')' 의 인덱스를 찾는다. 문자열 리터럴
    안의 괄호는 무시한다(이스케이프 존중) — story #3886 브레이스 매칭과 같은 이유."""
    depth = 0
    i = open_idx
    in_str = False
    str_char = ""
    escape = False
    n = len(text)
    while i < n:
        c = text[i]
        if in_str:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == str_char:
                in_str = False
        else:
            if c in ('"', "'"):
                in_str = True
                str_char = c
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def _extract_form1(text: str) -> list[str]:
    return [m.group(1) for m in _FORM1_RE.finditer(text)]


def _extract_form2(text: str) -> list[str]:
    out = []
    for m in _FORM2_RE.finditer(text):
        segs = _QUOTED_SEG_RE.findall(m.group(0))
        if len(segs) >= 2:
            out.append("/".join(segs))
    return out


def _extract_form3(text: str) -> list[str]:
    out = []
    for m in _OS_PATH_JOIN_RE.finditer(text):
        open_idx = m.end() - 1
        close_idx = _find_matching_paren(text, open_idx)
        if close_idx == -1:
            continue
        call_body = text[open_idx + 1 : close_idx]
        segs = _QUOTED_SEG_RE.findall(call_body)
        anchor = next((i for i, s in enumerate(segs) if s in ("apps", "packages")), None)
        if anchor is None:
            continue
        path_segs = [s for s in segs[anchor:] if s != ".."]
        if len(path_segs) >= 2:
            out.append("/".join(path_segs))
    return out


def extract_from_file(text: str) -> list[str]:
    return _extract_form1(text) + _extract_form2(text) + _extract_form3(text)


def main(argv: list[str]) -> int:
    test_root = Path(argv[1] if len(argv) > 1 else "backend/tests")
    if not test_root.is_dir():
        print(
            f"extract_fe_paths_referenced_by_backend_tests: {test_root} 없음 — fail-closed exit 1",
            file=sys.stderr,
        )
        return 1

    files = sorted(test_root.rglob("*.py"))
    if not files:
        print(
            f"extract_fe_paths_referenced_by_backend_tests: {test_root} 안에 *.py 0건 — fail-closed exit 1",
            file=sys.stderr,
        )
        return 1

    all_paths: set[str] = set()
    incomplete_files: list[str] = []
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        found = extract_from_file(text)
        if found:
            all_paths.update(found)
        elif _PATH_SUGGESTIVE_RE.search(text):
            incomplete_files.append(str(f))

    if incomplete_files:
        print(
            "extract_fe_paths_referenced_by_backend_tests: 완전성 fail-closed — 다음 파일에 "
            '따옴표로 감싼 "apps"/"packages" 토큰(또는 "apps/web/"로 시작하는 문자열)이 있는데 '
            "알려진 3형(단일 문자열·`/` 세그먼트 조인·os.path.join 콤마 조인) 어디에도 안 걸림 "
            "— 4번째 미지의 형태일 수 있어 exit 1:",
            file=sys.stderr,
        )
        for f in incomplete_files:
            print(f"  {f}", file=sys.stderr)
        return 1

    if not all_paths:
        print(
            "extract_fe_paths_referenced_by_backend_tests: 추출 0건 — fail-closed exit 1",
            file=sys.stderr,
        )
        return 1

    for p in sorted(all_paths):
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

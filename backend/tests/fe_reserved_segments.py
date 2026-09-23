"""story #4218 — FE `RESERVED_FIRST_SEGMENTS`(apps/web/src/lib/reserved-first-segments.ts)를 백엔드 테스트가 읽는 파서.

FE 목록은 두 갈래다: ① `...Object.keys(MIGRATED_RESOURCES | RENAMED_RESOURCES | RETIRED_RESOURCES)`(legacy-resource-tables.ts)
② 손 스냅샷 문자열 리터럴(FE 쪽 `verify-reserved-first-segments-sync` CI 가드가 `app/` 디렉터리와 맞춘다). 둘 다 정적으로
읽는다 — 백엔드 CI에는 node_modules가 없어 TS를 실행할 수 없다. 파싱이 조용히 비지 않게 호출자가 개수·표본을 확인한다.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FE_LIB = REPO_ROOT / "apps" / "web" / "src" / "lib"
RESERVED_TS = FE_LIB / "reserved-first-segments.ts"
LEGACY_TABLES_TS = FE_LIB / "legacy-resource-tables.ts"

def _strip_comments(src: str) -> str:
    """문자열 리터럴을 지키며 `//`·`/* */` 주석을 걷는 작은 스캐너. 정규식 두 번으로는 한쪽 주석 안의 `/*`(예: `app/*`)나
    `//`가 다른 쪽 주석을 잘못 열어 목록 본문을 삼킨다."""
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1])
            i = j + 1
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j == -1 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _block(src: str, opener: str, closer: str) -> str:
    start = src.index(opener) + len(opener)
    return src[start:src.index(closer, start)]


def _table_keys(name: str) -> set[str]:
    src = _strip_comments(LEGACY_TABLES_TS.read_text(encoding="utf-8"))
    body = _block(src, f"export const {name}", "};")
    body = body[body.index("{") + 1:]
    return {m.group(2) for m in re.finditer(r"^\s*(['\"]?)([\w.-]+)\1\s*:", body, re.M)}


def fe_reserved_first_segments() -> set[str]:
    src = _strip_comments(RESERVED_TS.read_text(encoding="utf-8"))
    body = _block(src, "export const RESERVED_FIRST_SEGMENTS = new Set([", "]);")
    names = set(re.findall(r"'([^']+)'", body)) | set(re.findall(r'"([^"]+)"', body))
    for table in re.findall(r"\.\.\.Object\.keys\((\w+)\)", body):
        names |= _table_keys(table)
    return names

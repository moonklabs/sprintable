"""story #4218 — FE `RESERVED_FIRST_SEGMENTS`의 커밋된 산출물(apps/web/src/lib/reserved-first-segments.json)을 읽는다.

백엔드는 TS를 파싱하지 않는다(카디르 QA P2 — 정규식 파서는 유효한 TS 모양 몇 가지를 놓치고도 초록이었다). JSON이 실제 모듈
평가값과 같다는 것은 FE 쪽 vitest(`apps/web/src/lib/reserved-first-segments-json.test.ts`)가 node에서 모듈을 import해 보장한다.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RESERVED_JSON = REPO_ROOT / "apps" / "web" / "src" / "lib" / "reserved-first-segments.json"


def fe_reserved_first_segments(path: Path | None = None) -> set[str]:
    data = json.loads((path or RESERVED_JSON).read_text(encoding="utf-8"))
    return set(data["segments"])

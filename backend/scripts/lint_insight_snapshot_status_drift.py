"""story #3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) — `InsightSnapshot.status`
어휘 BE↔FE 드리프트 가드. BE(`insight_snapshots.py`)가 새 상태값(예: 이 PR의
`skipped`)을 쓰기 시작했는데 FE(`InsightSnapshotStatus` 유니온·types.ts)가 못 따라오면
`insights-board/page.tsx`·`insight-snapshot-block.tsx`가 그 값을 "빈 라벨/알 수 없는
상태"로 그린다(«같은 화면 두 세계» 드리프트, #4049류 — 페드루 PO 리뷰 지적).

`test_3697_channel_insight_metrics_drift_lint.py`(insight_metrics 축)와 동형
사상(크로스파일·크로스언어 자구 대조, import 불가) — 다른 축(status 어휘 vs 채널별
지표 튜플)이라 별도 스크립트.

## 기전
BE 추출은 Python `ast` 모듈로 세 패턴을 모두 훑는다(정규식 줄 스캔이 아니라 —
`insight_snapshots.py`가 상태를 쓰는 세 관용구를 전부 커버해야 한다, 하나만 보면
누락된다):
  ① `snapshot.status = "값"`(속성 대입 — claim 단계의 `pending`→`in_progress`).
  ② 임의 함수 호출의 `status="값"` 키워드 인자(`pg_insert(...).values(status=...)`·
     `update(...).values(status=...)` — `schedule_insight_snapshots`의 초기 삽입·
     supersede 회수).
  ③ 임의 함수 호출의 `new_status="값"` 키워드 인자(`_finalize_snapshot_write(...,
     new_status=...)` 호출부 전체 — captured/unsupported/failed/pending/skipped).
이 세 패턴 밖의 새 관용구로 새 상태값이 추가되면 이 가드가 "새 값 0건 늘어남"으로
거짓 GREEN을 낼 수 있다(⚠️한계, 자인) — 그런 새 관용구가 생기면 이 스크립트도 같이
넓혀야 한다.

FE 추출은 `types.ts`의 `export type InsightSnapshotStatus = | '...' | '...' ...;`
유니온 리터럴을 정규식으로 그대로 뽑는다(business-info.ts 드리프트 가드와 동형 —
자구 대조, 포맷 무관 의미적 동치는 범위 밖)."""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_PATH = Path(__file__).resolve().parent.parent / "app/services/insight_snapshots.py"
FRONTEND_TYPES_PATH = REPO_ROOT / "apps/web/src/components/insights-board/types.ts"


class StatusExtractionIncompleteError(Exception):
    """FE 유니온 블록을 정규식이 못 찾았을 때(파일 구조가 이 스크립트의 가정 밖으로
    바뀜) — "0건=드리프트 없음"으로 조용히 오판하지 않게 예외로 승격한다(business-info
    가드의 "추출실패=보수적 RED" 원칙과 동일 사상, 여기선 아예 진행을 막는다)."""


def extract_backend_status_vocabulary(py_text: str) -> set[str]:
    tree = ast.parse(py_text)
    values: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                # `snapshot.status = "값"`만(변수명 한정) — 이 파일이 `.status`를
                # 대입하는 다른 모델(예: `ga4_connection.status = "needs_reauth"`,
                # GA4Connection)까지 InsightSnapshot 어휘로 오염시키지 않는다(실측
                # 발견 — 첫 버전이 이 오탐을 냈다).
                if (
                    isinstance(target, ast.Attribute) and target.attr == "status"
                    and isinstance(target.value, ast.Name) and target.value.id == "snapshot"
                    and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
                ):
                    values.add(node.value.value)
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                if (
                    kw.arg in ("status", "new_status")
                    and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str)
                ):
                    values.add(kw.value.value)
    return values


_FE_UNION_BLOCK_RE = re.compile(
    r"export type InsightSnapshotStatus\s*=\s*((?:\|\s*'[^']*'\s*)+);", re.MULTILINE,
)
_FE_UNION_MEMBER_RE = re.compile(r"'([^']*)'")


def extract_frontend_status_vocabulary(ts_text: str) -> set[str]:
    match = _FE_UNION_BLOCK_RE.search(ts_text)
    if match is None:
        raise StatusExtractionIncompleteError(
            "types.ts에서 `export type InsightSnapshotStatus = | '...' ...;` 유니온 블록을 "
            "찾지 못했습니다(파일 구조 변경 — 이 스크립트의 정규식을 갱신할 것)."
        )
    return set(_FE_UNION_MEMBER_RE.findall(match.group(1)))


def find_drift(backend_py_text: str, frontend_ts_text: str) -> tuple[set[str], set[str]]:
    """(backend_only, frontend_only) — 한쪽에만 있는 값들. 둘 다 빈 집합이면 드리프트
    없음. 양방향 완전성(페드루 PO 요구 "한쪽만 늘면 RED") — BE가 새 값을 추가했는데
    FE가 안 따라오는 방향 **AND** 그 반대(FE가 유령값을 지어내는 방향, #3746류)
    둘 다 잡는다."""
    backend = extract_backend_status_vocabulary(backend_py_text)
    frontend = extract_frontend_status_vocabulary(frontend_ts_text)
    return backend - frontend, frontend - backend


def main() -> int:
    backend_text = BACKEND_PATH.read_text(encoding="utf-8")
    frontend_text = FRONTEND_TYPES_PATH.read_text(encoding="utf-8")
    backend_only, frontend_only = find_drift(backend_text, frontend_text)
    if backend_only or frontend_only:
        print("FAIL: InsightSnapshot.status 어휘 BE↔FE 드리프트")
        if backend_only:
            print(f"  BE에만 있음(FE InsightSnapshotStatus에 없음): {sorted(backend_only)}")
        if frontend_only:
            print(f"  FE에만 있음(BE insight_snapshots.py에 없음 — 유령값): {sorted(frontend_only)}")
        print(
            "insight_snapshots.py(BE)가 정본 — apps/web/src/components/insights-board/"
            "types.ts::InsightSnapshotStatus를 거기 맞춰 정정할 것."
        )
        return 1
    print(f"OK: InsightSnapshot.status 어휘 BE↔FE 일치({len(extract_backend_status_vocabulary(backend_text))}개)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

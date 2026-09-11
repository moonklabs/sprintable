"""story #3370 후속(페드루 PO 지시 2026-09-11) — `scripts/lint_commit_before_validate.py`
(story #2459)의 `scan_repo()`가 스캔 루트 부재·파일 0개를 "위반 0건"으로 조용히 흘리던
fails-silent 구멍을 정정한 뒤, 그 완전성 자기 확認 자체를 pin한다
(`lint_raw_auth_id_into_member_field.py`의 동형 조건1 정정·테스트와 같은 계약 —
scripts/lint_commit_before_validate.py 모듈 docstring "완전성 자기 확認" 절 참고).

이 파일은 그 완전성 체크만 다룬다 — commit()/model_validate() 탐지 로직 자체(story #2459
본체)는 도입 당시 카디르 QA의 AST 스캔+수동 감사로 이미 검증됐고 이 스토리의 관심사가
아니다."""
from __future__ import annotations

import pytest

from scripts.lint_commit_before_validate import ScanIncompleteError, scan_repo


def test_scan_repo_raises_when_a_root_is_missing(tmp_path):
    (tmp_path / "app" / "routers").mkdir(parents=True)
    (tmp_path / "app" / "routers" / "x.py").write_text("async def f(db, obj):\n    pass\n")
    (tmp_path / "app" / "services").mkdir(parents=True)
    (tmp_path / "app" / "services" / "y.py").write_text("async def f(db, obj):\n    pass\n")
    # "ee" 루트를 아예 안 만든다 — 3개 중 하나 실종.
    with pytest.raises(ScanIncompleteError):
        scan_repo(scan_roots=["app/routers", "app/services", "ee"], backend_root=tmp_path)


def test_scan_repo_raises_when_zero_files_scanned(tmp_path):
    for root in ("app/routers", "app/services", "ee"):
        (tmp_path / root).mkdir(parents=True)
    # 세 루트 다 실존하지만 .py 파일이 하나도 없다.
    with pytest.raises(ScanIncompleteError):
        scan_repo(scan_roots=["app/routers", "app/services", "ee"], backend_root=tmp_path)


def test_scan_repo_succeeds_when_roots_exist_with_files(tmp_path):
    for root in ("app/routers", "app/services", "ee"):
        d = tmp_path / root
        d.mkdir(parents=True)
        (d / "x.py").write_text("async def f(db, obj):\n    pass\n")
    # 예외 없이 정상 반환(빈 리스트 — 위반 0건과 "헛돎" 0건을 구분하는 정상 경로).
    assert scan_repo(scan_roots=["app/routers", "app/services", "ee"], backend_root=tmp_path) == []


def test_repo_has_zero_violations():
    """실 저장소 scan_repo() 0건 — story #2459 도입 당시 계약(grandfather 없음)이 지금도
    성립함을 확認(이 파일 자신이 완전성 정정 뒤에도 여전히 유효함을 pin)."""
    assert scan_repo() == []

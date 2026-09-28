"""story #3804 PO CHANGES 1회차(2026-09-16 11:24Z) C2 — 0354a의 `_SEGMENT_*_FILES`
하드코딩 60개 ↔ `alembic/versions/` 실물 드리프트 가드.

파일명이 바뀌거나(리넘버) 빠지면 지금은 prod 적용 순간에야 `FileNotFoundError`로
드러난다 — 그 전에 이 테스트가 develop 착지 시점마다 정적으로 잡는다. 실 DB가
필요 없는 순수 파일시스템 대조라 destructive_schema 마커 없이 상시 스윗에서 돈다.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_VERSIONS_DIR = Path(__file__).parent.parent / "alembic" / "versions"
_BRIDGE_FILE = _VERSIONS_DIR / "0354a_prod_promotion_skipped_migrations_replay.py"

# 구간④ 번호 범위 — 0296~0351(0352는 git 이력에 실체 없는 결번) + 0353.
_SEGMENT_4_LOW, _SEGMENT_4_HIGH = 296, 351
_SEGMENT_4_TAIL = "0353"


def _load_bridge_module():
    spec = importlib.util.spec_from_file_location("mig0354a_driftcheck", str(_BRIDGE_FILE))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _live_segment4_files() -> list[str]:
    names = []
    for p in _VERSIONS_DIR.glob("0*.py"):
        num_part = p.name[:4]
        if not num_part.isdigit():
            continue
        num = int(num_part)
        if _SEGMENT_4_LOW <= num <= _SEGMENT_4_HIGH or num_part == _SEGMENT_4_TAIL:
            names.append(p.name)
    return sorted(names)


def _find_drift(live: list[str], declared: list[str]) -> str | None:
    """드리프트가 있으면 사람이 읽을 진단 문자열, 없으면 None. 테스트·양성대조가
    같은 판정 로직을 공유해 "판정 로직 자체"가 아니라 "입력"만 다르게 검증한다."""
    if live == declared:
        return None
    return (
        f"versions/ 실물({len(live)}개)과 _SEGMENT_4_FILES({len(declared)}개)가 "
        f"드리프트함(순서 포함 비교) — 신규/삭제/리넘버 파일을 0354a에 반영할 것.\n"
        f"실물에만 있음: {sorted(set(live) - set(declared))}\n"
        f"목록에만 있음: {sorted(set(declared) - set(live))}"
    )


def test_segment1_2_3_single_files_exist():
    mig = _load_bridge_module()
    assert len(mig._SEGMENT_1_FILES) == 1 and (_VERSIONS_DIR / mig._SEGMENT_1_FILES[0]).is_file()
    assert len(mig._SEGMENT_2_FILES) == 1 and (_VERSIONS_DIR / mig._SEGMENT_2_FILES[0]).is_file()
    assert len(mig._SEGMENT_3_FILES) == 1 and (_VERSIONS_DIR / mig._SEGMENT_3_FILES[0]).is_file()


def test_segment4_file_list_matches_versions_dir_glob_exactly_in_order():
    """구간④ 재생 순서=체인 순서 전제라 집합 일치만으론 부족 — 리스트(순서 포함)
    일치가 진짜 계약. 0352가 실제로 나타나면(향후 재사용 등) 구간④ 범위 전제
    자체가 깨진 것이라 별도로 표면화한다."""
    mig = _load_bridge_module()
    live = _live_segment4_files()

    assert not any(f.startswith("0352_") for f in live), (
        "0352 파일이 실제로 존재 — 구간④ 범위 전제(0352는 결번)가 깨졌다, 0354a 재설계 필요"
    )

    drift = _find_drift(live, mig._SEGMENT_4_FILES)
    assert drift is None, drift


def test_total_segment_count_is_60():
    mig = _load_bridge_module()
    total = (
        len(mig._SEGMENT_1_FILES) + len(mig._SEGMENT_2_FILES)
        + len(mig._SEGMENT_3_FILES) + len(mig._SEGMENT_4_FILES)
    )
    assert total == 60, f"리허설 doc·카드 전제(60개)와 어긋남 — 실측 {total}개"


def test_positive_control_missing_file_is_detected():
    """양성대조 — glob 결과에서 파일 하나를 몰래 빼면(리넘버/삭제 시뮬레이션)
    `_find_drift`가 실제로 드리프트를 보고하는지 직접 확認(판정 로직 자체가
    항상 None을 돌려주는 vacuous pass가 아님을 증명)."""
    mig = _load_bridge_module()
    live = _live_segment4_files()
    tampered = [f for f in live if f != live[0]]

    drift = _find_drift(tampered, mig._SEGMENT_4_FILES)
    assert drift is not None
    assert live[0] in drift

"""story #2293 — backend/scripts/shard_destructive_tests.py 회귀가드.

핵심 불변식: partition()은 «무손실»이어야 한다 — 입력으로 준 파일 전체가 정확히 하나의
샤드에 들어가야 한다(누락도 중복도 없이). 이게 깨지면 어떤 파일은 CI에서 «한 번도 안 도는»
상태가 되는데, 94개 순차 루프와 달리 매트릭스 샤드 사이에는 사람이 눈으로 훑을 로그가
하나로 안 모이므로 조용히 새는 실패가 훨씬 위험하다.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "backend" / "scripts" / "shard_destructive_tests.py"
_WEIGHTS_PATH = _REPO_ROOT / "infra" / "destructive-schema-shard-weights.json"


def _load():
    spec = importlib.util.spec_from_file_location("shard_destructive_tests", _SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_files(n: int) -> list[str]:
    return [f"tests/test_fake_{i:03d}.py" for i in range(n)]


@pytest.mark.parametrize("n_files,n_shards", [
    (94, 4),   # 실제 규모
    (1, 1),
    (1, 4),    # 샤드 수가 파일 수보다 많음 — 빈 샤드가 생겨도 손실은 없어야 한다
    (5, 3),    # 안 나누어떨어지는 흔한 경우
    (0, 4),    # 파일이 0개(향후 destructive_schema 마커가 전부 없어지는 극단)
])
def test_partition_is_lossless_for_any_input(n_files, n_shards):
    mod = _load()
    files = _fake_files(n_files)
    shards, totals = mod.partition(files, weights={}, shard_count=n_shards)
    assert len(shards) == n_shards
    assert len(totals) == n_shards
    union = [f for s in shards for f in s]
    assert sorted(union) == sorted(files), "샤드 합집합이 원본 파일 목록과 정확히 같아야 한다"
    assert len(union) == len(set(union)), "같은 파일이 두 샤드에 중복 배정되면 안 된다"


def test_unknown_files_get_average_weight_not_dropped():
    """가중치 스냅샷에 없는 새 파일도 discover만 되면 반드시 어딘가의 샤드에 들어간다."""
    mod = _load()
    files = ["tests/test_known_heavy.py", "tests/test_brand_new_unweighted.py"]
    weights = {"tests/test_known_heavy.py": 20.0}
    shards, totals = mod.partition(files, weights, shard_count=2)
    union = [f for s in shards for f in s]
    assert "tests/test_brand_new_unweighted.py" in union


def test_partition_balances_heavy_files_across_shards():
    """무거운 파일 여러 개가 한 샤드에 몰리지 않고 갈라져야 한다(그래야 병렬화 값이 있다)."""
    mod = _load()
    files = [f"tests/test_heavy_{i}.py" for i in range(4)]
    weights = {f: 100.0 for f in files}  # 전부 동일하게 무거움
    shards, totals = mod.partition(files, weights, shard_count=4)
    assert all(len(s) == 1 for s in shards), "동일 가중치 4개·샤드 4개면 1:1로 갈려야 한다"


def test_load_weights_missing_file_returns_empty(tmp_path):
    mod = _load()
    missing = tmp_path / "nope.json"
    assert mod.load_weights(missing) == {}


def test_load_weights_reads_repo_snapshot_shape():
    mod = _load()
    weights = mod.load_weights(_WEIGHTS_PATH)
    assert len(weights) > 0
    assert all(isinstance(v, float) for v in weights.values())


def test_repo_weights_file_is_wellformed():
    """저장소에 실제로 커밋된 스냅샷(infra/destructive-schema-shard-weights.json)이 형식을
    지키는지 — total_files/total_sec가 files 배열과 실제로 맞아떨어지는지."""
    data = json.loads(_WEIGHTS_PATH.read_text())
    assert data["total_files"] == len(data["files"])
    assert abs(data["total_sec"] - sum(e["sec"] for e in data["files"])) < 0.5
    assert len(data["files"]) == len({e["file"] for e in data["files"]}), "중복 파일 항목 없어야 함"


def test_shard_index_out_of_range_is_rejected():
    mod = _load()
    with pytest.raises(ValueError):
        mod.partition(["a"], {}, shard_count=0)


def test_check_staleness_flags_20pct_file_growth(tmp_path):
    mod = _load()
    weights_path = tmp_path / "weights.json"
    weights_path.write_text(json.dumps({
        "measured_at": "2026-01-01", "total_files": 100, "total_sec": 500.0,
        "files": [{"file": "tests/test_a.py", "sec": 5.0}],
    }))
    assert mod.check_staleness(119, weights_path) is None, "19% 증가는 아직 경고 아님"
    warning = mod.check_staleness(120, weights_path)
    assert warning is not None and "+20%" in warning


def test_check_staleness_silent_when_stable(tmp_path):
    mod = _load()
    weights_path = tmp_path / "weights.json"
    weights_path.write_text(json.dumps({
        "measured_at": "2026-01-01", "total_files": 94, "total_sec": 534.7, "files": [],
    }))
    assert mod.check_staleness(94, weights_path) is None
    assert mod.check_staleness(80, weights_path) is None, "줄어든 것은 경고 대상 아님"


def test_check_staleness_missing_file_is_silent(tmp_path):
    mod = _load()
    assert mod.check_staleness(94, tmp_path / "nope.json") is None


# ── story #3392(CI 후속) — unweighted 파일 가드 ─────────────────────────────

def test_check_staleness_flags_unweighted_file_even_without_20pct_growth(tmp_path):
    """PR #3742 실사고 — 파일 수는 20% 안 늘었는데 unweighted 파일 1개가 shard를
    timeout으로 끌고 갔다. «비율»이 아니라 «존재 자체»가 신호여야 한다."""
    mod = _load()
    weights_path = tmp_path / "weights.json"
    weights_path.write_text(json.dumps({
        "measured_at": "2026-01-01", "total_files": 200, "total_sec": 1000.0, "files": [],
    }))
    assert mod.check_staleness(200, weights_path, unweighted_count=0) is None
    warning = mod.check_staleness(200, weights_path, unweighted_count=1)
    assert warning is not None and "unweighted 파일 1개" in warning


def test_check_staleness_combines_both_reasons(tmp_path):
    mod = _load()
    weights_path = tmp_path / "weights.json"
    weights_path.write_text(json.dumps({
        "measured_at": "2026-01-01", "total_files": 100, "total_sec": 500.0, "files": [],
    }))
    warning = mod.check_staleness(130, weights_path, unweighted_count=2)
    assert "+30%" in warning
    assert "unweighted 파일 2개" in warning


def test_unweighted_files_in_finds_only_missing_from_weights():
    mod = _load()
    files = ["tests/a.py", "tests/b.py", "tests/c.py"]
    weights = {"tests/a.py": 5.0}
    assert mod.unweighted_files_in(files, weights) == ["tests/b.py", "tests/c.py"]


def test_unweighted_files_in_empty_when_all_weighted():
    mod = _load()
    files = ["tests/a.py"]
    weights = {"tests/a.py": 5.0}
    assert mod.unweighted_files_in(files, weights) == []


def test_average_weight_matches_partition_fallback():
    """단일 SSOT 확인 — partition()이 unweighted 파일에 실제로 쓰는 폴백값과
    average_weight()가 같은 값을 낸다(두 계산이 갈라지지 않는다)."""
    mod = _load()
    weights = {"tests/a.py": 10.0, "tests/b.py": 20.0}
    avg = mod.average_weight(weights)
    assert avg == 15.0
    shards, totals = mod.partition(["tests/a.py", "tests/b.py", "tests/new.py"], weights, shard_count=1)
    # 유일한 샤드의 총합 = 10+20+avg(15) = 45
    assert totals[0] == 45.0


def test_average_weight_of_empty_weights_is_one():
    mod = _load()
    assert mod.average_weight({}) == 1.0


def test_main_writes_meta_out_with_unweighted_files_and_threshold(tmp_path, monkeypatch):
    """story #3392 AC1 — --meta-out이 이 샤드의 unweighted 파일·평균·초과판정선을
    실제로 내보내는지, main()을 통째로 돌려 확인한다(discover_files는 무겁고 이 저장소
    실측과 무관하므로 fake로 대체)."""
    mod = _load()
    fake_files = ["tests/test_known.py", "tests/test_brand_new.py"]
    monkeypatch.setattr(mod, "discover_files", lambda: fake_files)
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/test_known.py": 10.0})
    meta_path = tmp_path / "meta.json"
    monkeypatch.setattr(
        sys, "argv",
        ["shard_destructive_tests.py", "--shard-index", "0", "--shard-count", "1", "--meta-out", str(meta_path)],
    )
    import io
    captured_stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", captured_stdout)
    exit_code = mod.main()
    assert exit_code == 0
    meta = json.loads(meta_path.read_text())
    assert meta["unweighted_files"] == ["tests/test_brand_new.py"]
    assert meta["avg_weight_sec"] == 10.0
    assert meta["unweighted_overage_multiplier"] == mod.UNWEIGHTED_OVERAGE_MULTIPLIER
    assert meta["unweighted_overage_threshold_sec"] == 10.0 * mod.UNWEIGHTED_OVERAGE_MULTIPLIER


def test_main_meta_out_empty_list_when_shard_fully_weighted(tmp_path, monkeypatch):
    mod = _load()
    fake_files = ["tests/test_known.py"]
    monkeypatch.setattr(mod, "discover_files", lambda: fake_files)
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/test_known.py": 10.0})
    meta_path = tmp_path / "meta.json"
    monkeypatch.setattr(
        sys, "argv",
        ["shard_destructive_tests.py", "--shard-index", "0", "--shard-count", "1", "--meta-out", str(meta_path)],
    )
    import io
    monkeypatch.setattr(sys, "stdout", io.StringIO())
    mod.main()
    meta = json.loads(meta_path.read_text())
    assert meta["unweighted_files"] == []

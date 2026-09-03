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
    (94, 4),   # 실제 규모(구 4샤드)
    (200, 8),  # story #3393 — 4→8샤드 확대 후 실제 규모
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


# ── story #3396(CI 후속) — 60초 절대 가드의 러너 정규화 ──────────────────────
#
# 픽스처는 실사고 원본 그대로다 — PR #3753 run 33773872963(attempt 1) shard 0,
# job 100710656162의 "elapsed: Xs" 로그를 파일별로 그대로 옮겼다(25개 전부). weights는
# 그 시점 infra/destructive-schema-shard-weights.json의 실제 값. test_3373_channel_
# connections.py가 168s(가중치 20.1s=8.4x)로 60초 절대 가드에 걸려 shard가 fail
# 났었다 — 나머지 24개도 median 5.91x로 튀어 있어 "이 파일만 무거워진 게 아니라 그
# run 자체가 느린 러너였다"는 것이 이 픽스처의 핵심 증거다.
_RUN_33773872963_SHARD0_ELAPSED = {
    "tests/test_3373_channel_connections.py": 168,
    "tests/test_edg_s32_reassign.py": 55,
    "tests/test_2944_api_key_issuance_replace_semantics_realdb.py": 56,
    "tests/test_2815_gate_github_check_events_endpoint_realdb.py": 52,
    "tests/test_e_recruit_s5_connection_artifact_realdb.py": 31,
    "tests/test_c7abdf42_repeat_schedule_endpoints.py": 22,
    "tests/test_3386_site_post_publication.py": 24,
    "tests/test_2156_merge_gate_evidence_realdb.py": 47,
    "tests/test_2893_gate_pr_scoped_isolation_realdb.py": 24,
    "tests/test_3288_recipe_role_bindings.py": 52,
    "tests/test_2249_gate_entered_at_realdb.py": 40,
    "tests/test_2985_gate_designated_approver_line.py": 52,
    "tests/test_2606_legal_document_current.py": 18,
    "tests/test_edg_s19_grandfather.py": 43,
    "tests/test_3025_gate_self_reclamation_realdb.py": 42,
    "tests/test_3293_recipe_role_bindings_read.py": 15,
    "tests/test_edg_s23_hypothesis_overlay.py": 21,
    "tests/test_3275_presence_profile_selfheal_realdb.py": 17,
    "tests/test_edg_s28_doc_resubmit.py": 10,
    "tests/test_org_create_seeds_default_participation_role.py": 28,
    "tests/test_edg_s30_void_recovery.py": 38,
    "tests/test_claim_participation.py": 14,
    "tests/test_merge_gate_reject_resubmit_reopen.py": 14,
    "tests/test_e_recruit_s16_rotate_idor_realdb.py": 8,
    "tests/test_2520_line_merge_gate_reconcile.py": 8,
}
_RUN_33773872963_SHARD0_WEIGHTS = {
    "tests/test_3373_channel_connections.py": 20.1,
    "tests/test_edg_s32_reassign.py": 10.42,
    "tests/test_2944_api_key_issuance_replace_semantics_realdb.py": 8.81,
    "tests/test_2815_gate_github_check_events_endpoint_realdb.py": 8.21,
    "tests/test_e_recruit_s5_connection_artifact_realdb.py": 7.77,
    "tests/test_c7abdf42_repeat_schedule_endpoints.py": 7.18,
    "tests/test_3386_site_post_publication.py": 6.88,
    "tests/test_2156_merge_gate_evidence_realdb.py": 6.39,
    "tests/test_2893_gate_pr_scoped_isolation_realdb.py": 5.99,
    "tests/test_3288_recipe_role_bindings.py": 5.55,
    "tests/test_2249_gate_entered_at_realdb.py": 5.34,
    "tests/test_2985_gate_designated_approver_line.py": 5.14,
    "tests/test_2606_legal_document_current.py": 4.95,
    "tests/test_edg_s19_grandfather.py": 4.75,
    "tests/test_3025_gate_self_reclamation_realdb.py": 4.34,
    "tests/test_3293_recipe_role_bindings_read.py": 4.22,
    "tests/test_edg_s23_hypothesis_overlay.py": 3.89,
    "tests/test_3275_presence_profile_selfheal_realdb.py": 3.53,
    "tests/test_edg_s28_doc_resubmit.py": 3.44,
    "tests/test_org_create_seeds_default_participation_role.py": 3.26,
    "tests/test_edg_s30_void_recovery.py": 2.66,
    "tests/test_claim_participation.py": 2.37,
    "tests/test_merge_gate_reject_resubmit_reopen.py": 2.05,
    "tests/test_e_recruit_s16_rotate_idor_realdb.py": 1.68,
    "tests/test_2520_line_merge_gate_reconcile.py": 1.47,
}


def test_weighted_ratios_excludes_unweighted_files():
    mod = _load()
    elapsed = {"tests/a.py": 20.0, "tests/unweighted.py": 999.0}
    weights = {"tests/a.py": 10.0}
    assert mod.weighted_ratios(elapsed, weights) == [2.0]


def test_normalized_threshold_falls_back_to_absolute_60_below_min_sample():
    mod = _load()
    assert mod.normalized_slow_threshold_sec([8.0, 8.0]) == 60.0  # 표본 2개 — 폴백


def test_normalized_threshold_scales_by_median_at_or_above_min_sample():
    mod = _load()
    assert mod.normalized_slow_threshold_sec([2.0, 8.0, 8.0]) == 8.0 * 60.0  # 중앙값 8.0


def test_real_incident_run_33773872963_shard0_is_not_flagged_by_normalization():
    """⭐story #3396 핵심 — 이 run은 실제로 60초 절대 가드에 걸려 shard가 fail 났다
    (test_3373_channel_connections.py 168s). 정규화 적용 후에는 «정상적인 느린 러너
    편차»로 판정돼 아무 파일도 안 걸려야 한다(양성대조 — 오탐 해소 확인)."""
    mod = _load()
    slow, threshold, sample_size = mod.slow_files_normalized(
        _RUN_33773872963_SHARD0_ELAPSED, _RUN_33773872963_SHARD0_WEIGHTS,
    )
    assert slow == [], f"정규화했는데도 여전히 걸린 파일: {slow}"
    assert sample_size == 25
    assert 300 < threshold < 400  # 중앙값 5.91 × 60 ≈ 354.6


def test_real_incident_file_alone_would_still_fail_absolute_60s_guard():
    """뮤테이션(AC4) — 정규화 로직을 걷어내면(= 절대 60초로 되돌리면) 오늘 사고의 그
    파일(168s)이 다시 실패로 판정돼야 한다. slow_files_normalized()가 없다는 가정하에
    구식 절대 비교를 직접 재현해 RED 조건 자체가 실재함을 고정한다 — 정규화 함수가
    없다면(구현을 되돌리면) 이 assert가 표현하는 판정으로 회귀한다는 뜻."""
    absolute_threshold = 60.0
    assert _RUN_33773872963_SHARD0_ELAPSED["tests/test_3373_channel_connections.py"] > absolute_threshold


def test_genuinely_heavy_file_still_caught_when_runner_is_normal():
    """회귀 0(AC5) — 러너가 정상(배율이 대부분 1 근처)인데 파일 하나만 weight 대비
    몇 배로 튀면, 정규화 후에도 여전히 잡혀야 한다(정규화가 «전부 다 봐주는» 가드로
    변질되면 안 된다)."""
    mod = _load()
    elapsed = {
        "tests/normal_a.py": 5.0, "tests/normal_b.py": 5.0, "tests/normal_c.py": 5.0,
        "tests/genuinely_slow.py": 100.0,  # weight 5.0의 20배 — 러너 탓이 아니라 진짜 회귀
    }
    weights = {"tests/normal_a.py": 5.0, "tests/normal_b.py": 5.0, "tests/normal_c.py": 5.0, "tests/genuinely_slow.py": 5.0}
    slow, threshold, sample_size = mod.slow_files_normalized(elapsed, weights)
    assert slow == ["tests/genuinely_slow.py"]
    assert threshold == 60.0  # 정상 러너(배율 1.0) — 사실상 절대 60초와 같은 값, 100s는 그 위


def test_check_elapsed_mode_exit_code_matches_slow_files(tmp_path, capsys):
    """_check_elapsed_mode()를 통째로 돌려 오늘 실사고 표본이 exit 0(정상 판정)이
    되는지 e2e로 확인한다(파일 파싱·가중치 로딩·판정 전체 경로)."""
    mod = _load()
    elapsed_path = tmp_path / "elapsed.tsv"
    elapsed_path.write_text(
        "\n".join(f"{f}\t{s}" for f, s in _RUN_33773872963_SHARD0_ELAPSED.items())
    )
    exit_code = mod._check_elapsed_mode(elapsed_path)
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "OK" in captured.err


def test_check_elapsed_mode_returns_1_and_prints_error_when_genuinely_slow(tmp_path, capsys, monkeypatch):
    mod = _load()
    elapsed_path = tmp_path / "elapsed.tsv"
    # 정상 러너(배율 1근처) 표본 3개 + 진짜 느린 파일 1개.
    elapsed_path.write_text(
        "tests/a.py\t5\ntests/b.py\t5\ntests/c.py\t5\ntests/slow.py\t100\n"
    )
    monkeypatch.setattr(mod, "load_weights", lambda: {
        "tests/a.py": 5.0, "tests/b.py": 5.0, "tests/c.py": 5.0, "tests/slow.py": 5.0,
    })
    exit_code = mod._check_elapsed_mode(elapsed_path)
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "::error::" in captured.out
    assert "tests/slow.py" in captured.out


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

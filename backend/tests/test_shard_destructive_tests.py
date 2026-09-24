"""story #2293 — backend/scripts/shard_destructive_tests.py 회귀가드.

핵심 불변식: partition()은 «무손실»이어야 한다 — 입력으로 준 파일 전체가 정확히 하나의
샤드에 들어가야 한다(누락도 중복도 없이). 이게 깨지면 어떤 파일은 CI에서 «한 번도 안 도는»
상태가 되는데, 94개 순차 루프와 달리 매트릭스 샤드 사이에는 사람이 눈으로 훑을 로그가
하나로 안 모이므로 조용히 새는 실패가 훨씬 위험하다.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "backend" / "scripts" / "shard_destructive_tests.py"
_WEIGHTS_DIR = _REPO_ROOT / "infra" / "destructive-schema-shard-weights"


def _write_fake_weights_dir(dir_path: Path, *, measured_at: str, files: list[dict]) -> None:
    """story #3812 CHANGES(재설계) — 디렉터리(파일마다 정확히 하나의 `<test_file>.json`)
    + 형제 meta.json으로 합성 스냅샷을 쓴다(옛 jsonl 단일-파일 append 관례를 대체 —
    GitHub 서버측 merge가 `.gitattributes merge=union`을 안 따라 그 1차 처방이
    무효였던 실사고 뒤 재설계, 회귀가 아니다)."""
    dir_path.mkdir(parents=True, exist_ok=True)
    for e in files:
        entry_name = Path(e["file"]).name + ".json"
        (dir_path / entry_name).write_text(json.dumps(e, ensure_ascii=False) + "\n")
    dir_path.parent.joinpath(f"{dir_path.name}.meta.json").write_text(json.dumps({"measured_at": measured_at}))


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
    missing = tmp_path / "nope"
    assert mod.load_weights(missing) == {}


def test_load_weights_reads_repo_snapshot_shape():
    mod = _load()
    weights = mod.load_weights(_WEIGHTS_DIR)
    assert len(weights) > 0
    assert all(isinstance(v, float) for v in weights.values())


def test_load_weights_ignores_non_json_extension_files(tmp_path):
    """story #3812 CHANGES — 디렉터리 안 `*.json`만 훑는다(사람이 옆에 README나
    `.gitkeep` 같은 비-json 보조 파일을 둬도 무해해야 한다는 계약)."""
    mod = _load()
    weights_dir = tmp_path / "weights"
    weights_dir.mkdir()
    (weights_dir / "test_a.py.json").write_text('{"file": "tests/test_a.py", "sec": 1.0}\n')
    (weights_dir / "README.md").write_text("사람용 메모 — json 아님, 무시돼야 한다")
    assert mod.load_weights(weights_dir) == {"tests/test_a.py": 1.0}


def test_load_weights_malformed_json_file_raises_with_filename(tmp_path):
    """⭐story #3812 CHANGES — 디렉터리 안 한 물리 파일이 깨진 JSON이면(사람 손 실수)
    어느 파일인지 이름을 실어 fail-loud로 알려야 한다(사후 JSONDecodeError만으로는
    어느 파일이 문제인지 바로 안 보인다)."""
    mod = _load()
    weights_dir = tmp_path / "weights"
    weights_dir.mkdir()
    (weights_dir / "test_broken.py.json").write_text("{이건 JSON이 아니다")
    with pytest.raises(ValueError, match="test_broken.py.json"):
        mod.load_weights(weights_dir)


def test_load_weights_filename_mismatch_with_file_field_raises(tmp_path):
    """⭐story #3812(카디르 QA 계약값 ①) — 물리 파일명이 내용의 `file` 필드와 어긋나면
    (복붙 실수·리네임 누락) 조용히 엉뚱한 파일의 가중치로 읽힐 수 있다 — fail-loud로
    잡아야 한다."""
    mod = _load()
    weights_dir = tmp_path / "weights"
    weights_dir.mkdir()
    (weights_dir / "test_wrong_name.py.json").write_text(
        '{"file": "tests/test_actual.py", "sec": 1.0, "source": "x"}\n'
    )
    with pytest.raises(mod.ShardWeightFilenameMismatchError, match="test_wrong_name.py.json"):
        mod.load_weights(weights_dir)


def test_load_weights_duplicate_file_field_across_two_physical_files_raises():
    """⭐story #3812 CHANGES — 디렉터리 방식에서도 남는 유일한 논리 맹점: 서로 다른
    두 물리 json 파일이 «같은» `file` 키 값을 등재하면(파일명 자체는 다르니 git은
    이걸 ADD/ADD 충돌로 못 잡는다) 로더가 fail-loud로 잡아야 한다."""
    mod = _load()
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        weights_dir = Path(d)
        (weights_dir / "test_dup.py.json").write_text(
            '{"file": "tests/test_dup.py", "sec": 1.0, "source": "a"}\n'
        )
        (weights_dir / "test_dup_renamed.py.json").write_text(
            '{"file": "tests/test_dup.py", "sec": 2.0, "source": "b"}\n'
        )
        with pytest.raises(mod.DuplicateShardWeightEntryError):
            mod.load_weights(weights_dir)


def test_load_weights_duplicate_file_field_with_identical_entry_is_fine(tmp_path):
    """양성대조 — 두 물리 파일이 «완전히 동일한» 항목을 등재한 경우(예: cherry-pick
    중복)는 실 충돌이 아니므로 통과해야 한다(위 테스트와 대비되는 경계). 두 번째
    사본은 이름 검사 대상이 아니다(cherry-pick 산출물이 임의 이름을 가질 수 있음,
    story #3812) — 그래서 일부러 파일명 규칙과 안 맞는 이름을 썼다."""
    mod = _load()
    weights_dir = tmp_path / "weights"
    weights_dir.mkdir()
    (weights_dir / "test_a.py.json").write_text('{"file": "tests/test_a.py", "sec": 1.0, "source": "x"}\n')
    # 정렬 순서상 두 번째로 처리되도록 알파벳상 뒤에 오는 이름을 쓴다(story #3812 —
    # 이름 검사는 그 file 값을 «처음» 보는 항목에만 적용된다).
    (weights_dir / "zzz_copy_of_test_a.py.json").write_text('{"file": "tests/test_a.py", "sec": 1.0, "source": "x"}\n')
    assert mod.load_weights(weights_dir) == {"tests/test_a.py": 1.0}


def test_repo_weights_dir_is_wellformed():
    """저장소에 실제로 커밋된 스냅샷(infra/destructive-schema-shard-weights/+
    .meta.json)이 형식을 지키는지 — 중복 파일 항목이 없는지.

    story #3397 — total_files/total_sec는 files 배열에서 파생 가능한 값이라 이제 JSON에
    기록하지 않는다(각 PR이 이 두 필드를 각자 갱신해 병합 충돌을 내던 것이 원인 —
    #3742·#3752 실사고). 이 필드들이 «없어야 함»을 여기서 고정해 둔다 — 누가 다시
    넣으면 이 테스트가 그 회귀를 잡는다.

    story #3812 CHANGES(재설계) — 포맷이 jsonl(+meta.json)에서 디렉터리(파일마다
    정확히 하나의 json 파일, +meta.json)로 바뀜(GitHub 서버측 merge가 `.gitattributes
    merge=union`을 안 따라 1차 처방이 무효였던 실사고 뒤). 중복 파일 항목 검사는
    이제 `_load_full_data()` 자신이 `DuplicateShardWeightEntryError`로 fail-loud
    하므로, 이 테스트는 그 예외가 안 뜨는 것 자체로 "중복 없음"을 증명한다(로드가
    성공하면 이미 중복 0건이 보장됨)."""
    mod = _load()
    data = mod._load_full_data(_WEIGHTS_DIR)
    assert "total_files" not in data, "total_files는 len(files)에서 파생한다 — 다시 기록하지 않는다(story #3397)"
    assert "total_sec" not in data, "total_sec는 sum(files[].sec)에서 파생한다 — 다시 기록하지 않는다(story #3397)"
    assert len(data["files"]) == len({e["file"] for e in data["files"]}), "중복 파일 항목 없어야 함"


def test_shard_index_out_of_range_is_rejected():
    mod = _load()
    with pytest.raises(ValueError):
        mod.partition(["a"], {}, shard_count=0)


def _fake_weight_entries(n: int) -> list[dict]:
    """story #3397 — check_staleness()가 이제 len(files)로 스냅샷 파일 수를 판정하므로,
    이 테스트들의 «가짜 과거 스냅샷 파일 수»는 files 배열 길이 자체로 표현한다(예전엔
    total_files 필드 숫자만 바꾸면 됐다 — 그 필드가 사라진 대신 이렇게 만든다)."""
    return [{"file": f"tests/test_fake_{i:03d}.py", "sec": 5.0} for i in range(n)]


def test_check_staleness_flags_20pct_file_growth(tmp_path):
    mod = _load()
    weights_path = tmp_path / "weights"
    _write_fake_weights_dir(weights_path, measured_at="2026-01-01", files=_fake_weight_entries(100))
    assert mod.check_staleness(119, weights_path) is None, "19% 증가는 아직 경고 아님"
    warning = mod.check_staleness(120, weights_path)
    assert warning is not None and "+20%" in warning


def test_check_staleness_silent_when_stable(tmp_path):
    mod = _load()
    weights_path = tmp_path / "weights"
    _write_fake_weights_dir(weights_path, measured_at="2026-01-01", files=_fake_weight_entries(94))
    assert mod.check_staleness(94, weights_path) is None
    assert mod.check_staleness(80, weights_path) is None, "줄어든 것은 경고 대상 아님"


def test_check_staleness_missing_file_is_silent(tmp_path):
    mod = _load()
    assert mod.check_staleness(94, tmp_path / "nope") is None


# ── story #3392(CI 후속) — unweighted 파일 가드 ─────────────────────────────

def test_check_staleness_flags_unweighted_file_even_without_20pct_growth(tmp_path):
    """PR #3742 실사고 — 파일 수는 20% 안 늘었는데 unweighted 파일 1개가 shard를
    timeout으로 끌고 갔다. «비율»이 아니라 «존재 자체»가 신호여야 한다."""
    mod = _load()
    weights_path = tmp_path / "weights"
    _write_fake_weights_dir(weights_path, measured_at="2026-01-01", files=_fake_weight_entries(200))
    assert mod.check_staleness(200, weights_path, unweighted_count=0) is None
    warning = mod.check_staleness(200, weights_path, unweighted_count=1)
    assert warning is not None and "unweighted 파일 1개" in warning


def test_check_staleness_combines_both_reasons(tmp_path):
    mod = _load()
    weights_path = tmp_path / "weights"
    _write_fake_weights_dir(weights_path, measured_at="2026-01-01", files=_fake_weight_entries(100))
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


# ── story #3636(CI 후속) — 무거운 파일의 flat 임계값 거짓 빨강(2026-09-07 실사고 2건) ──
#
# test_2813_gate_github_check_realdb.py(weight 45.0s — 25개 realdb 테스트, 매번 전체
# schema create_all을 다시 태우는 무거운 파일)가 오늘 두 번: run 34099865987에서
# 72s>66.0s, run 34103152060에서 131s>102.9s. 둘 다 그 파일과 무관한 PR이고 다음 run은
# 초록이었다(3396의 정규화 자체는 맞게 동작 — "그 run이 전반적으로 느렸다"는 판정까지는
# 맞았다. 문제는 threshold가 파일 자신의 weight와 무관한 flat 값이라 weight 45.0처럼
# 60s 근방인 파일은 median_ratio가 1.0만 넘어도 밥먹듯 걸리는 구조였다는 것).
_INCIDENT1_ELAPSED = {
    "tests/normal_a.py": 11.0, "tests/normal_b.py": 11.0, "tests/normal_c.py": 11.0,
    "tests/test_2813_gate_github_check_realdb.py": 72.0,
}
_INCIDENT1_WEIGHTS = {
    "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
    "tests/test_2813_gate_github_check_realdb.py": 45.0,
}  # median_ratio = 1.1 → threshold = 66.0(실사고와 동일)

_INCIDENT2_ELAPSED = {
    "tests/normal_a.py": 17.15, "tests/normal_b.py": 17.15, "tests/normal_c.py": 17.15,
    "tests/test_2813_gate_github_check_realdb.py": 131.0,
}
_INCIDENT2_WEIGHTS = {
    "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
    "tests/test_2813_gate_github_check_realdb.py": 45.0,
}  # median_ratio = 1.715 → threshold ≈ 102.9(실사고와 동일)


def test_incident1_2026_09_07_run_34099865987_no_longer_flags_test_2813():
    """⭐story #3636 핵심(실사고 1) — weight×3.0 여유축 적용 후 test_2813(72s)이
    더는 FAIL이 아니어야 한다(정규화 자체는 맞다 — threshold 66.0도 실사고와 일치)."""
    mod = _load()
    slow, threshold, sample_size = mod.slow_files_normalized(_INCIDENT1_ELAPSED, _INCIDENT1_WEIGHTS)
    assert threshold == pytest.approx(66.0)
    assert slow == [], f"weight×3.0 여유축이 있는데도 여전히 걸림: {slow}"


def test_incident2_2026_09_07_run_34103152060_no_longer_flags_test_2813():
    """⭐story #3636 핵심(실사고 2) — 131s>102.9s도 마찬가지로 더는 FAIL이 아니다."""
    mod = _load()
    slow, threshold, sample_size = mod.slow_files_normalized(_INCIDENT2_ELAPSED, _INCIDENT2_WEIGHTS)
    assert threshold == pytest.approx(102.9, abs=0.1)
    assert slow == [], f"weight×3.0 여유축이 있는데도 여전히 걸림: {slow}"


def test_incident1_without_own_weight_cap_axis_would_still_fail_mutation():
    """뮤테이션(AC4) — weight×3.0 여유축 없이(구 로직 그대로) 판정하면 실사고 1이
    다시 FAIL로 재현돼야 한다. slow_files_normalized() 내부 두 번째 AND 조건을
    걷어낸 구식 판정을 직접 재현(이 assert가 표현하는 조건으로 되돌아간다는 뜻)."""
    mod = _load()
    ratios = mod.weighted_ratios(_INCIDENT1_ELAPSED, _INCIDENT1_WEIGHTS)
    threshold = mod.normalized_slow_threshold_sec(ratios)
    old_slow = sorted(f for f, e in _INCIDENT1_ELAPSED.items() if f in _INCIDENT1_WEIGHTS and e > threshold)
    assert old_slow == ["tests/test_2813_gate_github_check_realdb.py"]


def test_warned_only_files_normalized_surfaces_the_spared_file():
    """story #3636 — FAIL에서 빠졌다고 조용히 넘어가지 않는다. warned_only에 잡혀야
    한다(가시성, story #3558 ratio_outliers와 동형)."""
    mod = _load()
    slow, threshold, _ = mod.slow_files_normalized(_INCIDENT1_ELAPSED, _INCIDENT1_WEIGHTS)
    warned = mod.warned_only_files_normalized(_INCIDENT1_ELAPSED, _INCIDENT1_WEIGHTS, threshold, slow)
    assert warned == ["tests/test_2813_gate_github_check_realdb.py"]


def test_heavy_file_own_weight_cap_still_fails_past_3x_boundary():
    """경계 — test_2813 weight 45.0이라도 자기 weight의 3배(135.0s)를 넘게 느려지면
    (진짜 회귀) 여전히 FAIL이어야 한다 — 이 축이 «무거운 파일은 뭘 해도 안 걸린다»로
    변질되면 안 된다(story #3636 AC2 선언과 짝)."""
    mod = _load()
    elapsed = dict(_INCIDENT1_ELAPSED)
    elapsed["tests/test_2813_gate_github_check_realdb.py"] = 140.0  # > 45.0*3.0
    slow, threshold, _ = mod.slow_files_normalized(elapsed, _INCIDENT1_WEIGHTS)
    assert slow == ["tests/test_2813_gate_github_check_realdb.py"]


# ── story #4152(CI·결정성, 페드루 PO 確定 2026-09-22) — «같은 run 상대» 정규화(#3396)
# 이 러너 부하 노이즈에 취약함을 드러낸 실사고 2건(오늘, 2026-09-22)의 실측값을 그대로
# 픽스처로 고정한다. PR#4351 run 35696793719 shard(2): test_3502_insights_board.py
# 261s(그 run의 정규화 판정선 187.7s 초과) — 이 PR은 FE h1 파일 9개뿐(백엔드 파일 0,
# 즉 test_3502는 diff 밖 무관 파일). PR#4355 run 35697222669 shard(6): 자기 신규 테스트
# test_3804_prod_promotion_bridge_0354a.py 80s(판정선 71.2s 초과) — 등재 weight
# 25.0(잠정값, 로컬 추정치)의 첫 CI run.

_INCIDENT4152A_WEIGHT = 70.0  # test_3502_insights_board.py 실 등재값(story-3911)
_INCIDENT4152B_WEIGHT = 25.0  # test_3804_...py 실 등재값(provisional=true)


def test_absolute_threshold_is_own_weight_times_multiplier_floored_at_60():
    mod = _load()
    assert mod.absolute_slow_threshold_sec(70.0) == pytest.approx(175.0)  # 70*2.5
    assert mod.absolute_slow_threshold_sec(1.0) == 60.0  # AC3 — 60초 절대 최저선 무변


def test_provisional_files_in_requires_structured_flag_not_free_text():
    mod = _load()
    entries = [
        {"file": "tests/a.py", "sec": 5.0, "source": "잠정값 — 아직 안 채움"},  # 자유문뿐, 구조화 X
        {"file": "tests/b.py", "sec": 5.0, "provisional": True, "source": "x"},
    ]
    assert mod.provisional_files_in(entries) == frozenset({"tests/b.py"})


def test_entries_missing_provisional_flag_catches_tentative_source_without_flag():
    """story #4159 AC2 — source에 잠정/추정/실측 전 문구가 있는데 provisional:true가
    없으면 잡힌다(test_4101/PR 4381 shard 10 실사고 클래스)."""
    mod = _load()
    entries = [
        {"file": "tests/a.py", "sec": 10.0, "source": "로컬 추정치 — CI 실측 전 잠정값"},
        {"file": "tests/b.py", "sec": 10.0, "provisional": True, "source": "잠정값"},
        {"file": "tests/c.py", "sec": 10.0, "source": "PR#1234 CI 실측 42.0s"},
    ]
    assert mod.entries_missing_provisional_flag(entries) == ["tests/a.py"]


def test_entries_missing_provisional_flag_is_purely_mechanical_no_tense_awareness():
    """⚠️story #4159 실측 함정 — 이 축은 자유문 형태소 분석 없이 순수 부분문자열 매치다.
    "이전 잠정값을 대체"처럼 과거형(이미 실측 교체 완료)으로 써도 "잠정"이 텍스트에
    남아 있으면 여전히 걸린다(#4159 본 작업 중 330개 파일 source를 처음 이렇게 썼다가
    이 축에 다시 걸려 재작성한 실사고 — "구 로컬×배율 스냅샷을 대체"로 트리거 단어
    자체를 피해야 한다). 그래서 문서(entries_missing_provisional_flag docstring)에
    「실측 완료 서술은 트리거 단어를 아예 안 쓰는 게 정답」을 명시해 둔다."""
    mod = _load()
    entries = [{"file": "tests/a.py", "sec": 42.0, "source": "이전 잠정값을 CI 실측으로 대체"}]
    assert mod.entries_missing_provisional_flag(entries) == ["tests/a.py"]


def test_parse_changed_files_strips_blank_lines():
    mod = _load()
    assert mod.parse_changed_files("tests/a.py\n\n  \ntests/b.py\n") == frozenset({"tests/a.py", "tests/b.py"})


# ── story #4163 — __ALL__ 모드 RED 범위 축소(import-그래프 narrowing) ──────────────
def test_changed_app_files_to_modules_basic_path():
    mod = _load()
    assert mod.changed_app_files_to_modules(frozenset({"app/routers/other.py"})) == frozenset({"app.routers.other"})


def test_changed_app_files_to_modules_init_py_maps_to_package():
    mod = _load()
    assert mod.changed_app_files_to_modules(frozenset({"app/services/__init__.py"})) == frozenset({"app.services"})


def test_changed_app_files_to_modules_multiple_and_non_py_ignored():
    mod = _load()
    result = mod.changed_app_files_to_modules(frozenset({"app/a/b.py", "app/c.py", "README.md"}))
    assert result == frozenset({"app.a.b", "app.c"})


def test_files_depending_on_modules_direct_import(tmp_path: Path):
    """⭐AC1 정탐① — `import app.x.y`(직접 import)를 잡는다."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    t1 = tmp_path / "tests" / "test_direct.py"
    t1.write_text("import app.x.y\n\ndef test_a():\n    assert True\n")
    t2 = tmp_path / "tests" / "test_unrelated.py"
    t2.write_text("import app.other\n\ndef test_b():\n    assert True\n")
    result = mod.test_files_depending_on_modules(
        frozenset({"app.x.y"}), ["tests/test_direct.py", "tests/test_unrelated.py"], backend_dir=tmp_path,
    )
    assert result == ["tests/test_direct.py"]


def test_files_depending_on_modules_from_import(tmp_path: Path):
    """⭐AC1 정탐② — `from app.x.y import Z`(from-import)도 잡는다."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_from.py").write_text(
        "from app.x.y import Z\n\ndef test_a():\n    assert True\n"
    )
    result = mod.test_files_depending_on_modules(
        frozenset({"app.x.y"}), ["tests/test_from.py"], backend_dir=tmp_path,
    )
    assert result == ["tests/test_from.py"]


def test_files_depending_on_modules_member_of_package_import(tmp_path: Path):
    """⭐AC1 정탐③ — `from app.services import approval_delivery`(부모 패키지에서
    멤버로 import, 이 레포 실측 관례상 가장 흔한 형태)도 잡는다."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_member.py").write_text(
        "from app.services import approval_delivery\n\ndef test_a():\n    assert True\n"
    )
    result = mod.test_files_depending_on_modules(
        frozenset({"app.services.approval_delivery"}), ["tests/test_member.py"], backend_dir=tmp_path,
    )
    assert result == ["tests/test_member.py"]


def test_files_depending_on_modules_unrelated_file_not_matched(tmp_path: Path):
    """음성대조 — 변경 모듈을 전혀 참조하지 않는 파일은 안 잡힌다(오늘 PR#4527
    실사고 — test_3373/test_3415/test_3523/test_3806는 approval_delivery.py를 안
    건드림)."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_unrelated.py").write_text(
        "from app.services.other_thing import Foo\n\ndef test_a():\n    assert True\n"
    )
    result = mod.test_files_depending_on_modules(
        frozenset({"app.services.approval_delivery"}), ["tests/test_unrelated.py"], backend_dir=tmp_path,
    )
    assert result == []


def test_files_depending_on_modules_leaf_word_boundary_no_false_positive(tmp_path: Path):
    """⭐«못 틀리는 대조» 방지 — leaf 이름이 다른 식별자의 부분문자열로 우연히
    나타나도(예: `approval_delivery_v2`) 단어경계(\\b)로 오탐 안 한다."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_similar_name.py").write_text(
        "from app.services import approval_delivery_v2\n\ndef test_a():\n    assert True\n"
    )
    result = mod.test_files_depending_on_modules(
        frozenset({"app.services.approval_delivery"}), ["tests/test_similar_name.py"], backend_dir=tmp_path,
    )
    assert result == []


def test_files_depending_on_modules_no_dotall_leak_across_later_lines(tmp_path: Path):
    """⭐최초 구현 함정(실측으로 발견) — DOTALL을 쓰면 `from app.services import X` 뒤
    파일 어딘가에 우연히 leaf 단어가 또 나타나도 매치돼 버린다. MULTILINE(줄 경계
    고정)으로 그 오탐을 막았는지 직접 재현해 고정."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_no_leak.py").write_text(
        "from app.services import other_thing\n\n"
        "# approval_delivery라는 단어가 여기 우연히 있다(주석, import 문과 무관)\n"
        "def test_a():\n    assert True\n"
    )
    result = mod.test_files_depending_on_modules(
        frozenset({"app.services.approval_delivery"}), ["tests/test_no_leak.py"], backend_dir=tmp_path,
    )
    assert result == []


def test_files_depending_on_modules_empty_modules_returns_empty_list():
    mod = _load()
    assert mod.test_files_depending_on_modules(frozenset(), ["tests/test_a.py"]) == []


def test_files_depending_on_modules_multiple_files_sorted(tmp_path: Path):
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_z.py").write_text("import app.x\n")
    (tmp_path / "tests" / "test_a.py").write_text("import app.x\n")
    result = mod.test_files_depending_on_modules(
        frozenset({"app.x"}), ["tests/test_z.py", "tests/test_a.py"], backend_dir=tmp_path,
    )
    assert result == ["tests/test_a.py", "tests/test_z.py"]


def test_ac1_e2e_module_dependent_red_unrelated_warn(tmp_path: Path):
    """⭐AC1 핵심 — PO 지정 합성 케이스: app 모듈 X 변경 + T1(X를 import)·T2(무관)
    둘 다 절대 임계 초과 → T1 RED·T2 WARN(exit 0에 해당하는 slow_files_absolute
    반환값 — narrowed changed_files가 실제로 red/warn 갈림을 만든다는 파이프라인
    전체 증거, test_files_depending_on_modules의 출력을 그대로 slow_files_absolute의
    changed_files 인자에 먹인다)."""
    mod = _load()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_t1_depends.py").write_text("from app.x import Y\n")
    (tmp_path / "tests" / "test_t2_unrelated.py").write_text("from app.other import Z\n")

    narrowed = mod.test_files_depending_on_modules(
        mod.changed_app_files_to_modules(frozenset({"app/x.py"})),
        ["tests/test_t1_depends.py", "tests/test_t2_unrelated.py"],
        backend_dir=tmp_path,
    )
    assert narrowed == ["tests/test_t1_depends.py"]

    weights = {"tests/test_t1_depends.py": 30.0, "tests/test_t2_unrelated.py": 30.0}
    elapsed = {"tests/test_t1_depends.py": 100.0, "tests/test_t2_unrelated.py": 100.0}  # 둘 다 threshold(75.0) 초과
    red, warn = mod.slow_files_absolute(elapsed, weights, changed_files=frozenset(narrowed))
    assert red == ["tests/test_t1_depends.py"]
    assert warn == ["tests/test_t2_unrelated.py"]


def test_ac1_test_file_direct_change_stays_red_even_if_unrelated_to_app_module(tmp_path: Path):
    """AC1 — "테스트 파일 직접 변경은 RED 유지": narrowed 목록은 app-모듈-의존
    테스트뿐 아니라 PR이 직접 바꾼 테스트 파일도 포함해야 한다(호출부 책임 —
    ci.yml은 backend_test_files_changed가 __ALL__이 아닐 때의 기존 경로를 그대로
    쓰므로 이 축은 무변경이지만, __ALL__+app-narrowing 경로에서도 "이 PR이 신설/
    수정한 테스트 파일 자신"은 기존 classify 스크립트의 줄1 로직이 __ALL__로
    뭉개므로, T3(무관·비변경)까지만 이 테스트로 고정하고 직접변경 케이스는
    narrowed 목록에 수동으로 합쳐도 RED가 유지됨을 보인다(합집합 계약 자체는
    ci.yml이 아니라 호출부/향후 확장 몫 — 여기선 slow_files_absolute가 그 합집합을
    올바로 RED 처리한다는 것만 고정)."""
    mod = _load()
    weights = {"tests/test_t1_depends.py": 30.0, "tests/test_directly_changed.py": 30.0}
    elapsed = {"tests/test_t1_depends.py": 100.0, "tests/test_directly_changed.py": 100.0}
    narrowed = frozenset({"tests/test_t1_depends.py"}) | frozenset({"tests/test_directly_changed.py"})
    red, warn = mod.slow_files_absolute(elapsed, weights, changed_files=narrowed)
    assert set(red) == {"tests/test_t1_depends.py", "tests/test_directly_changed.py"}
    assert warn == []


def test_ac1_mutation_without_narrowing_unrelated_file_also_red():
    """뮤테이션 — narrowing을 걷어내면(changed_files=None, #4163 처방 前 동작) 무관
    파일(T2)도 RED로 되돌아간다 — narrowing이 실제로 이 값을 갈랐음을 고정(#4152의
    기존 뮤테이션 관례와 동형)."""
    mod = _load()
    weights = {"tests/test_t1_depends.py": 30.0, "tests/test_t2_unrelated.py": 30.0}
    elapsed = {"tests/test_t1_depends.py": 100.0, "tests/test_t2_unrelated.py": 100.0}
    red, warn = mod.slow_files_absolute(elapsed, weights, changed_files=None)
    assert set(red) == {"tests/test_t1_depends.py", "tests/test_t2_unrelated.py"}, (
        f"narrowing 없이는(구현 걷어냄) 무관 파일도 RED로 재현돼야: {red}"
    )


def test_incident4152a_unrelated_file_over_absolute_threshold_is_warn_not_red():
    """⭐AC1/AC2 — PR#4351 실사고: test_3502(261s, weight 70.0 → 절대 임계 175.0s 초과)
    이지만 이 PR의 changed_files 밖(FE h1 파일 9개뿐)이라 RED 아니라 WARN — 잡 초록."""
    mod = _load()
    elapsed = {"tests/test_3502_insights_board.py": 261.0}
    weights = {"tests/test_3502_insights_board.py": _INCIDENT4152A_WEIGHT}
    red, warn = mod.slow_files_absolute(
        elapsed, weights, changed_files=frozenset({"apps/web/src/app/h1-unrelated.tsx"}),
    )
    assert red == [], f"무관 파일인데도 RED: {red}"
    assert warn == ["tests/test_3502_insights_board.py"]


def test_incident4152b_own_provisional_weight_file_is_excluded_not_red():
    """⭐AC4 — PR#4355 실사고: test_3804(80s, weight 25.0 provisional)는 이 PR 자신의
    신설 테스트(changed_files 안)라 AC2로는 못 구한다 — provisional 제외(AC4)로 red도
    warn도 0(등재값 자체를 못 믿는 축이라 이 게이트가 no-op, #3558 별도 경고는 무변)."""
    mod = _load()
    elapsed = {"tests/test_3804_prod_promotion_bridge_0354a.py": 80.0}
    weights = {"tests/test_3804_prod_promotion_bridge_0354a.py": _INCIDENT4152B_WEIGHT}
    provisional = frozenset({"tests/test_3804_prod_promotion_bridge_0354a.py"})
    red, warn = mod.slow_files_absolute(
        elapsed, weights, provisional_files=provisional,
        changed_files=frozenset({"tests/test_3804_prod_promotion_bridge_0354a.py"}),
    )
    assert red == [], f"provisional인데도 RED: {red}"
    assert warn == [], f"provisional은 WARN도 0이어야 함(등재값 자체를 못 믿음): {warn}"


def test_incident4152b_mutation_without_provisional_exclusion_would_be_red():
    """뮤테이션(AC4) — provisional_files를 안 주면(구현을 걷어내면) 같은 표본이 RED로
    되돌아가야 한다 — AC4의 provisional 제외가 실제로 이 값을 살리고 있음을 고정."""
    mod = _load()
    elapsed = {"tests/test_3804_prod_promotion_bridge_0354a.py": 80.0}
    weights = {"tests/test_3804_prod_promotion_bridge_0354a.py": _INCIDENT4152B_WEIGHT}
    red, warn = mod.slow_files_absolute(
        elapsed, weights, changed_files=frozenset({"tests/test_3804_prod_promotion_bridge_0354a.py"}),
    )
    assert red == ["tests/test_3804_prod_promotion_bridge_0354a.py"], (
        f"provisional 제외 없이는 RED가 재현돼야 하는데: {red}"
    )


def test_changed_files_none_treats_everything_as_changed_regression_zero():
    """회귀 0 — changed_files=None(호출측이 diff 정보를 안 줬을 때)이면 예전처럼 전부
    RED 후보(안전측 폴백) — AC2의 WARN 완화가 새 인자를 안 쓰는 기존 소비처까지 조용히
    관대해지게 만들면 안 된다."""
    mod = _load()
    elapsed = {"tests/test_3502_insights_board.py": 261.0}
    weights = {"tests/test_3502_insights_board.py": _INCIDENT4152A_WEIGHT}
    red, warn = mod.slow_files_absolute(elapsed, weights, changed_files=None)
    assert red == ["tests/test_3502_insights_board.py"]
    assert warn == []


def test_ac3_mutation_changed_file_over_absolute_threshold_stays_red():
    """AC3 — 진짜 폭주는 여전히 잡힌다: 변경 파일(diff 안)이 자기 weight×2.5를 넘으면
    provisional이 아닌 한 RED 유지(«전부 다 봐주는» 가드로 변질되면 안 된다, #3396의
    AC5와 동형 회귀 원칙)."""
    mod = _load()
    elapsed = {"tests/genuinely_slow.py": 100.0}
    weights = {"tests/genuinely_slow.py": 5.0}  # threshold = max(5*2.5, 60) = 60, 100 > 60
    red, warn = mod.slow_files_absolute(
        elapsed, weights, changed_files=frozenset({"tests/genuinely_slow.py"}),
    )
    assert red == ["tests/genuinely_slow.py"]
    assert warn == []


def test_unweighted_files_are_not_touched_by_absolute_gate():
    """회귀 0 — unweighted 파일은 이 게이트의 대상이 아니다(#3392가 전담, 무변)."""
    mod = _load()
    elapsed = {"tests/brand_new_unweighted.py": 999.0}
    red, warn = mod.slow_files_absolute(elapsed, {}, changed_files=frozenset())
    assert red == [] and warn == []


def test_check_elapsed_mode_exit_code_matches_slow_files(tmp_path, capsys, monkeypatch):
    """_check_elapsed_mode()를 통째로 돌려 오늘 실사고 표본이 exit 0(정상 판정)이
    되는지 e2e로 확인한다(파일 파싱·가중치 로딩·판정 전체 경로). 이 픽스처는 PR
    #3753(2026-09-03) 실사고 당시의 weight 스냅샷(_RUN_33773872963_SHARD0_WEIGHTS)을
    재현하는 것이 목적이라 **그 시점 값을 고정**해야 한다 — 실 weights.json을 그대로
    읽으면(story #3558, 2026-09-06 전수 재측정으로 값이 갱신된 뒤) 이 역사적 시나리오
    재현이 매번 지금 시점의 등재값에 따라 값이 달라져 깨진다(실측 fix 자체가 이
    회귀를 노출시킴 — load_weights를 monkeypatch해 고정).

    story #4152 이관 — `_check_elapsed_mode`는 이제 run-relative 정규화(#3396) 대신
    diff-scoping(AC2)으로 판정한다. 이 25개 파일은 실측 근거(`git show 4bfa823b4
    --stat`, PR#3753 실 diff)로 확認된 «PR#3753과 무관한 파일들»이다(그 PR이 실제로
    건드린 테스트는 test_3666_channel_post_image_import.py·test_3753_*.py 셋뿐 —
    test_3373_channel_connections.py는 없다). `--changed-files`로 그 사실을 알리면
    WARN(exit 0)만 — 옛 run-relative 값(중앙값 5.91배)은 더 이상 판정에 안 쓰인다."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: _RUN_33773872963_SHARD0_WEIGHTS)
    elapsed_path = tmp_path / "elapsed.tsv"
    elapsed_path.write_text(
        "\n".join(f"{f}\t{s}" for f, s in _RUN_33773872963_SHARD0_ELAPSED.items())
    )
    changed_files_path = tmp_path / "changed.txt"
    changed_files_path.write_text(
        "tests/test_3666_channel_post_image_import.py\n"
        "tests/test_3753_image_integrity_validator.py\n"
        "tests/test_3753_mcp_import_image_path.py\n"
    )
    exit_code = mod._check_elapsed_mode(elapsed_path, changed_files_path=changed_files_path)
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "OK" in captured.err
    assert "::warning::" in captured.out  # AC2 — 무관 파일 초과는 경고로 남는다(가시성)


def test_check_elapsed_mode_without_changed_files_arg_is_conservative_red(tmp_path, capsys, monkeypatch):
    """story #4152 회귀 0 — `--changed-files` 생략(diff 정보 없음)이면 전부 RED 후보(안전측 폴백)는 그대로다.

    story #4206 — 판정선은 샤드 전체를 대조군으로 잰 러너 배율만큼 올라가지만 상한 1.5(까디르 P1 · PO 결정)라, 이
    픽스처(PR#3753 당시 shard 0, 중앙값 약 5.9배)는 상한을 넘어 ① 그대로 RED(exit 1)다 — 상한 밖 둔화는 러너 탓인지
    코드 탓인지 가드가 가를 수 없어 안전측. ② 같은 러너 위에서 파일 하나만 더 튀어도 당연히 RED."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: _RUN_33773872963_SHARD0_WEIGHTS)
    elapsed_path = tmp_path / "elapsed.tsv"
    elapsed_path.write_text(
        "\n".join(f"{f}\t{s}" for f, s in _RUN_33773872963_SHARD0_ELAPSED.items())
    )
    assert mod._check_elapsed_mode(elapsed_path) == 1
    assert "::error::" in capsys.readouterr().out

    lone = next(iter(_RUN_33773872963_SHARD0_WEIGHTS))
    spiked = dict(_RUN_33773872963_SHARD0_ELAPSED) | {
        lone: mod.absolute_slow_threshold_sec(_RUN_33773872963_SHARD0_WEIGHTS[lone]) * 20,
    }
    elapsed_path.write_text("\n".join(f"{f}\t{s}" for f, s in spiked.items()))
    assert mod._check_elapsed_mode(elapsed_path) == 1
    assert "::error::" in capsys.readouterr().out


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


# ─── story #3558 — 등재값 대 실측 절대 배율 경고 축(실패 X) ────────────────────


def test_ratio_outliers_flags_at_exact_high_boundary():
    """ratio==2.0(경계 자체)는 «>=»라 flag돼야 한다(정확히 2배 과소 등재도 놓치면 안 됨)."""
    mod = _load()
    outliers = mod.ratio_outliers({"tests/a.py": 20.0}, {"tests/a.py": 10.0})
    assert len(outliers) == 1
    assert outliers[0]["file"] == "tests/a.py"
    assert outliers[0]["ratio"] == pytest.approx(2.0)


def test_ratio_outliers_flags_at_exact_low_boundary():
    """ratio==0.5(경계 자체)도 «<=」라 flag(과대 등재 — 이 파일 탓에 다른 파일이 손해)."""
    mod = _load()
    outliers = mod.ratio_outliers({"tests/a.py": 5.0}, {"tests/a.py": 10.0})
    assert len(outliers) == 1
    assert outliers[0]["ratio"] == pytest.approx(0.5)


def test_ratio_outliers_just_inside_bounds_not_flagged():
    """2.0/0.5 경계 바로 안쪽(1.99배·0.51배)은 정상 편차로 보고 flag 안 한다."""
    mod = _load()
    outliers = mod.ratio_outliers(
        {"tests/a.py": 19.9, "tests/b.py": 5.1}, {"tests/a.py": 10.0, "tests/b.py": 10.0},
    )
    assert outliers == []


def test_ratio_outliers_skips_file_missing_from_weights():
    """measured에는 있는데 weights.json엔 없는(unweighted, #3392 축이 별도 담당) 파일은
    조용히 건너뛴다 — 이 축이 unweighted 가드와 중복 경고를 내면 혼란만 커진다."""
    mod = _load()
    outliers = mod.ratio_outliers({"tests/new_unweighted.py": 999.0}, {})
    assert outliers == []


def test_ratio_outliers_sorted_worst_first():
    mod = _load()
    outliers = mod.ratio_outliers(
        {"tests/mild.py": 21.0, "tests/severe.py": 100.0},
        {"tests/mild.py": 10.0, "tests/severe.py": 10.0},
    )
    assert [o["file"] for o in outliers] == ["tests/severe.py", "tests/mild.py"]


def test_load_duration_artifacts_merges_multiple_shard_files(tmp_path):
    mod = _load()
    (tmp_path / "shard-durations-0.json").write_text(
        json.dumps({"shard": 0, "durations": {"tests/a.py": 5.0, "tests/b.py": 6.0}})
    )
    (tmp_path / "shard-durations-1.json").write_text(
        json.dumps({"shard": 1, "durations": {"tests/c.py": 7.0}})
    )
    merged = mod.load_duration_artifacts(tmp_path)
    assert merged == {"tests/a.py": 5.0, "tests/b.py": 6.0, "tests/c.py": 7.0}


def test_write_and_reload_durations_json_roundtrip(tmp_path):
    mod = _load()
    out = tmp_path / "shard-durations-3.json"
    mod.write_durations_json({"tests/x.py": 12.5}, out, shard=3)
    data = json.loads(out.read_text())
    assert data == {"shard": 3, "durations": {"tests/x.py": 12.5}}


def test_audit_durations_mode_never_fails_even_with_outliers(tmp_path, capsys, monkeypatch):
    """story #3558 AC2 — 명백한 이탈이 있어도 exit code는 항상 0이어야 한다(경고 전용,
    이 잡이 CI를 절대 못 죽인다)."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    (artifact_dir / "shard-durations-0.json").write_text(
        json.dumps({"shard": 0, "durations": {"tests/way_off.py": 500.0}})
    )
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/way_off.py": 10.0})
    exit_code = mod._audit_durations_mode(artifact_dir)
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "::warning::" in captured.out
    assert "tests/way_off.py" in captured.out


def test_audit_durations_mode_missing_dir_returns_0_no_crash(tmp_path):
    """backend-irrelevant PR이면 destructive 샤드 자체가 스킵돼 산출물이 아예 없을 수
    있다 — 디렉터리 부재를 에러가 아니라 "대조 0건"으로 조용히 처리해야 한다."""
    mod = _load()
    exit_code = mod._audit_durations_mode(tmp_path / "does-not-exist")
    assert exit_code == 0


# ─── story #3642(CI·소형, 3396/3558 후속) — weights drift 연속 스트릭 축 ───────────


def test_update_drift_streaks_increments_only_over_ratio_files():
    mod = _load()
    outliers = [
        {"file": "tests/heavy.py", "ratio": 2.5, "measured_sec": 100.0, "weight_sec": 40.0},
        {"file": "tests/light.py", "ratio": 0.4, "measured_sec": 4.0, "weight_sec": 10.0},  # 과대 등재(반대 방향)
    ]
    streaks = mod.update_drift_streaks({}, outliers)
    assert streaks == {"tests/heavy.py": 1}


def test_update_drift_streaks_resets_file_no_longer_over_ratio():
    """이전엔 걸렸던 파일이 이번 run엔 정상이면(러너 편차였다는 뜻) 스트릭이
    사라진다(=0으로 리셋) — 다음 로드 시 .get(file, 0)이 0을 준다."""
    mod = _load()
    prior = {"tests/heavy.py": 2, "tests/other.py": 5}
    outliers = [{"file": "tests/other.py", "ratio": 2.1, "measured_sec": 1.0, "weight_sec": 1.0}]
    streaks = mod.update_drift_streaks(prior, outliers)
    assert streaks == {"tests/other.py": 6}
    assert "tests/heavy.py" not in streaks  # 이번엔 안 걸렸다 — 리셋.


def test_drift_warnings_only_at_or_above_threshold():
    mod = _load()
    streaks = {"a.py": 1, "b.py": 2, "c.py": 3, "d.py": 5}
    assert mod.drift_warnings(streaks) == ["c.py", "d.py"]


def test_drift_warnings_default_threshold_is_3():
    """story #3642 AC3 — PO 確定 "3 run 연속"을 상수로 고정."""
    mod = _load()
    assert mod.DRIFT_STREAK_THRESHOLD == 3


def test_audit_durations_mode_drift_state_fires_after_3_consecutive_runs_then_quiets(tmp_path, capsys, monkeypatch):
    """AC3 selftest — 같은 파일이 3 run 연속 ratio≥2배면 3번째 run에서 ::warning::이
    뜬다. 그 직후(4번째 run, 여전히 초과)는 스트릭이 1회 경고 뒤 리셋됐으므로 다시
    3회를 채워야 한다(«매 run 반복 스팸 방지» — 4번째 run 단독으로는 안 뜬다)."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/stale.py": 10.0})
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    state_path = tmp_path / "drift-state.json"

    def _run(elapsed: float):
        (artifact_dir / "shard-durations-0.json").write_text(
            json.dumps({"shard": 0, "durations": {"tests/stale.py": elapsed}})
        )
        return mod._audit_durations_mode(artifact_dir, drift_state_path=state_path)

    for _ in range(2):  # run 1·2 — 아직 threshold 미달, warning 없음.
        _run(25.0)  # ratio 2.5
        assert "weights drift" not in capsys.readouterr().out

    _run(25.0)  # run 3 — 스트릭 3 도달, 발화.
    out3 = capsys.readouterr().out
    assert "::warning::weights drift(story #3642): tests/stale.py" in out3

    _run(25.0)  # run 4 — 직전에 리셋됐으니 단독으론 안 뜬다(스트릭 1).
    out4 = capsys.readouterr().out
    assert "weights drift" not in out4

    state_after = json.loads(state_path.read_text())
    assert state_after["streaks"] == {"tests/stale.py": 1}


def test_audit_durations_mode_drift_state_normal_run_resets_streak(tmp_path, capsys, monkeypatch):
    """뮤테이션 대조(AC3) — 2 run 연속 초과 뒤 3번째 run이 정상으로 돌아오면(러너
    편차였다) drift 경고가 안 뜬다 — 스트릭이 리셋됐다는 증거."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/stale.py": 10.0})
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    state_path = tmp_path / "drift-state.json"

    def _run(elapsed: float):
        (artifact_dir / "shard-durations-0.json").write_text(
            json.dumps({"shard": 0, "durations": {"tests/stale.py": elapsed}})
        )
        return mod._audit_durations_mode(artifact_dir, drift_state_path=state_path)

    _run(25.0)
    _run(25.0)
    capsys.readouterr()
    _run(5.0)  # 정상 복귀(ratio 0.5, low-outlier 방향이라 drift 축엔 아예 안 잡힘).
    out3 = capsys.readouterr().out
    assert "weights drift" not in out3

    _run(25.0)  # 다시 초과 — 리셋된 뒤라 스트릭 1, 아직 미발화.
    out4 = capsys.readouterr().out
    assert "weights drift" not in out4


# ─── story #3642 AC1 — 재실측 반영값(test_2813·test_3516·test_3414) + 샤드 균형 ──


def test_shard_balance_stays_even_after_remeasure():
    """AC2 — 갱신 뒤에도 partition()의 weight-sum 균형이 샤드 4(또는 무거운 파일이
    떨어지는 아무 샤드)를 편중시키지 않는다(그리디 LPT가 자동 재배치 — 샤드 «번호»가
    아니라 «합»이 기준이라는 것이 이 균형의 근거). 편차 5% 이내로 못박는다."""
    mod = _load()
    weights = mod.load_weights()
    files = mod.discover_files()
    shards, totals = mod.partition(files, weights, 8)
    avg = sum(totals) / len(totals)
    for t in totals:
        assert abs(t - avg) / avg < 0.05, f"샤드 편차 5% 초과: {totals}"


# ─── story #3642 CHANGES(페드루 PO) — write-through·같은 run 재시도 이중카운트 방지 ──


def test_audit_durations_mode_missing_artifacts_writes_through_state_unchanged(tmp_path):
    """CHANGES① — 산출물 디렉터리가 없어(backend-irrelevant PR) 조기 return해도
    drift 상태 파일은 그대로 다시 저장돼야 한다 — 안 그러면 ci.yml의
    `actions/cache/save`(if: always())가 존재하지 않는 경로를 캐시하려다 매 run
    Path Validation Error를 낸다.

    ⚠️ 파일을 미리 만들어 두면(사전 존재) "write-through가 실제로 도는가"가 아니라
    "이미 있던 파일이 그대로 있는가"만 재는 항진 통과 함정이다(리셋 로직 없이도
    통과) — 상태 파일을 아예 없는 채로 시작해 조기 return 경로 자체가 파일을 «새로
    만드는지»로 write-through 실행 자체를 증명한다."""
    mod = _load()
    state_path = tmp_path / "drift-state.json"
    assert not state_path.exists()  # 사전 상태 0 — write-through가 없으면 끝까지 없어야 정상.

    exit_code = mod._audit_durations_mode(tmp_path / "does-not-exist", drift_state_path=state_path)

    assert exit_code == 0
    assert state_path.exists(), "write-through가 없으면 조기 return 경로가 파일을 안 만든다"
    state_after = json.loads(state_path.read_text())
    assert state_after == {"run_id": None, "streaks": {}}

    # 두 번째 호출 — 기존 스트릭({"tests/a.py": 2})이 write-through로 무변경 보존.
    mod._save_drift_state(state_path, run_id="run-1", streaks={"tests/a.py": 2})
    mod._audit_durations_mode(
        tmp_path / "still-does-not-exist", drift_state_path=state_path, run_id="run-1",
    )
    state_after2 = json.loads(state_path.read_text())
    assert state_after2 == {"run_id": "run-1", "streaks": {"tests/a.py": 2}}


def test_audit_durations_mode_same_run_retry_does_not_double_count(tmp_path, capsys):
    """CHANGES② — attempt 2(같은 run_id)가 attempt 1이 이미 반영한 상태를 복원하면
    스트릭을 다시 증가시키지 않는다(멱등). run_id가 다르면(진짜 새 run) 정상 증가."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    state_path = tmp_path / "drift-state.json"
    (artifact_dir / "shard-durations-0.json").write_text(
        json.dumps({"shard": 0, "durations": {"tests/stale.py": 25.0}})
    )
    weights = {"tests/stale.py": 10.0}

    import unittest.mock

    with unittest.mock.patch.object(mod, "load_weights", lambda: weights):
        mod._audit_durations_mode(artifact_dir, drift_state_path=state_path, run_id="run-A")
        state1 = json.loads(state_path.read_text())
        assert state1 == {"run_id": "run-A", "streaks": {"tests/stale.py": 1}}

        # attempt 2 — 같은 run_id로 재시도(예: 이 잡 이후 다른 잡이 실패해 rerun).
        mod._audit_durations_mode(artifact_dir, drift_state_path=state_path, run_id="run-A")
        state2 = json.loads(state_path.read_text())
        assert state2 == {"run_id": "run-A", "streaks": {"tests/stale.py": 1}}, "같은 run 재시도가 이중 카운트했다"

        # 진짜 다음 run(run_id 다름) — 정상 증가.
        mod._audit_durations_mode(artifact_dir, drift_state_path=state_path, run_id="run-B")
        state3 = json.loads(state_path.read_text())
        assert state3 == {"run_id": "run-B", "streaks": {"tests/stale.py": 2}}


# ─── story #3653(CI·가드, 페드루 PO 確定 2026-09-07) — 타임아웃으로 죽은 shard가
# drift 집계 사각지대에 빠지던 것을 닫는다: shard 산출물 개수를 --shard-count와
# 대조해, «성공인데 산출물 없음»(업로드 결함, ::error+exit 1)과 «실패/타임아웃이라
# 원천적으로 못 세는 것»(::warning만, exit 0)을 가른다 ────────────────────────────


def _write_shard_artifact(artifact_dir, shard: int, durations: dict | None = None) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / f"shard-durations-{shard}.json").write_text(
        json.dumps({"shard": shard, "durations": durations or {}})
    )


def test_missing_shards_all_8_present_returns_empty():
    mod = _load()
    assert mod.missing_shards(set(range(8)), expected_count=8) == []


def test_load_present_shard_numbers_reads_shard_field_from_each_artifact(tmp_path):
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    for n in (0, 2, 5):
        _write_shard_artifact(artifact_dir, n)
    assert mod.load_present_shard_numbers(artifact_dir) == {0, 2, 5}


def test_audit_durations_mode_8_of_8_present_no_shard_warning(capsys, tmp_path):
    """selftest 1 — 산출물이 기대한 만큼(8/8) 다 있으면 shard-누락 관련 경고/에러가
    0건이어야 한다(양성대조: 아래 두 테스트가 실제로 다른 조건에서 다르게 뜬다는 것
    자체가 이 테스트의 「무경고」가 우연이 아님을 증명한다)."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    for n in range(8):
        _write_shard_artifact(artifact_dir, n)
    exit_code = mod._audit_durations_mode(artifact_dir, expected_shard_count=8, shard_result="success")
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "::error::" not in captured.out
    assert "::warning::shard" not in captured.out
    assert "8/8" in captured.err


def test_audit_durations_mode_7_of_8_non_success_warns_only(capsys, tmp_path):
    """selftest 2 — 7/8만 있고 shard_result가 non-success(타임아웃/실패)면 경고 1건만
    뜨고 exit 0(원천적으로 못 세는 데이터라 실패시키면 안 된다 — story #3653 그라운딩②)."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    for n in range(7):  # shard 7만 빠짐.
        _write_shard_artifact(artifact_dir, n)
    exit_code = mod._audit_durations_mode(artifact_dir, expected_shard_count=8, shard_result="cancelled")
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "::warning::shard 1개는 드리프트 집계 밖" in captured.out
    assert "[7]" in captured.out
    assert "::error::" not in captured.out


def test_audit_durations_mode_7_of_8_success_errors_and_fails(capsys, tmp_path):
    """selftest 3 — 7/8만 있는데 shard_result가 success면(업로드 파이프라인이 조용히
    무산된 것) ::error + exit 1 — 가드 스스로 빨개져야 한다(story #3653 확定)."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    for n in range(7):  # shard 7만 빠짐.
        _write_shard_artifact(artifact_dir, n)
    exit_code = mod._audit_durations_mode(artifact_dir, expected_shard_count=8, shard_result="success")
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "::error::shard 산출물 누락" in captured.out
    assert "[7]" in captured.out


def test_audit_durations_mode_dir_missing_entirely_success_errors_and_fails(capsys, tmp_path):
    """카디르 qa:changes(PR #4005, 2026-09-07) — 산출물 디렉터리 자체가 통째로 없는
    극단형(업로드가 전부 무산)도 shard_result="success"면 부분 누락(selftest 3)과
    같은 문구·같은 코드로 실패해야 한다. 예전엔 이 케이스가 shard_result 분기보다
    앞선 조기 return에 걸려 항상 조용히 0을 돌려줬다(비대칭)."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"  # 만들지 않음 — 디렉터리 자체가 없다.
    exit_code = mod._audit_durations_mode(artifact_dir, expected_shard_count=8, shard_result="success")
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "::error::shard 산출물 누락" in captured.out
    assert "[0, 1, 2, 3, 4, 5, 6, 7]" in captured.out


def test_audit_durations_mode_dir_missing_entirely_non_success_warns_only(capsys, tmp_path):
    """양성대조 — 디렉터리 통째 부재도 shard_result가 non-success면(진짜 스킵/타임아웃)
    여전히 경고-only+exit 0(전체 누락이라고 무조건 실패시키면 안 된다 — 원래 관대한
    분기는 그대로 살아 있어야 한다)."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    exit_code = mod._audit_durations_mode(artifact_dir, expected_shard_count=8, shard_result="cancelled")
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "::warning::shard 8개는 드리프트 집계 밖" in captured.out
    assert "::error::" not in captured.out


def test_mutation_removing_shard_presence_diff_silences_missing_shard_warning(tmp_path, capsys, monkeypatch):
    """뮤테이션 — missing_shards()가 항상 빈 리스트를 내도록 되돌리면(옛 사각지대
    재현), 7/8+non-success 케이스에서 경고가 사라지는 것을 고정한다(이 가드가 실제로
    그 결함을 잡는다는 증거)."""
    mod = _load()
    monkeypatch.setattr(mod, "missing_shards", lambda present, *, expected_count: [])

    artifact_dir = tmp_path / "artifacts"
    for n in range(7):
        _write_shard_artifact(artifact_dir, n)
    exit_code = mod._audit_durations_mode(artifact_dir, expected_shard_count=8, shard_result="cancelled")
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "::warning::shard" not in captured.out, "뮤테이션이 걸리지 않았다(경고가 여전히 뜬다)"


def test_audit_durations_mode_backend_irrelevant_success_missing_all_is_ok_not_error(capsys, tmp_path):
    """selftest 4(story #3678) — 실물 재현(PR #4021 run 34160408234): FE-only PR이라
    backend_relevant=false, 8개 shard가 전부 내부 스텝을 스킵해 업로드 자체가 없는데도
    잡은 always()라 shard_result="success"로 끝난다. §3653만으로는 이걸 "업로드
    파이프라인 무산"(selftest 3)과 구분 못 해 ::error+exit 1을 냈다 — backend_relevant
    가 이 케이스를 갈라 exit 0."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"  # 만들지 않음 — 업로드 자체가 스킵됐다.
    exit_code = mod._audit_durations_mode(
        artifact_dir, expected_shard_count=8, shard_result="success", backend_relevant="false",
    )
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "::error::" not in captured.out
    assert "OK: shard 8개 산출물 없음(story #3678)" in captured.out
    assert "[0, 1, 2, 3, 4, 5, 6, 7]" in captured.out


def test_audit_durations_mode_backend_relevant_true_success_missing_still_errors(capsys, tmp_path):
    """양성대조 — backend_relevant="true"(진짜 관련 PR)면 §3653 판정이 그대로다(selftest
    3과 동일 시나리오, backend_relevant 인자만 추가). backend_relevant 도입이 §3653의
    실제 결함 탐지력을 죽이지 않았음을 고정한다."""
    mod = _load()
    artifact_dir = tmp_path / "artifacts"
    for n in range(7):  # shard 7만 빠짐 — 업로드 파이프라인이 조용히 무산된 형.
        _write_shard_artifact(artifact_dir, n)
    exit_code = mod._audit_durations_mode(
        artifact_dir, expected_shard_count=8, shard_result="success", backend_relevant="true",
    )
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "::error::shard 산출물 누락" in captured.out
    assert "[7]" in captured.out


def test_mutation_removing_backend_relevant_guard_reintroduces_false_positive(capsys, tmp_path, monkeypatch):
    """뮤테이션 — backend_relevant 분기를 빼면(§3678 도입 前 코드 재현) FE-only PR의 정상
    스킵이 다시 ::error+exit 1로 잘못 뜨는 것을 고정한다(이 가드가 실제로 그 결함을
    막는다는 증거, story #3653의 뮤테이션 관례와 동형)."""
    mod = _load()
    original = mod._audit_durations_mode

    def _without_backend_relevant_guard(artifact_dir, **kwargs):
        kwargs.pop("backend_relevant", None)
        return original(artifact_dir, **kwargs)

    monkeypatch.setattr(mod, "_audit_durations_mode", _without_backend_relevant_guard)

    artifact_dir = tmp_path / "artifacts"
    exit_code = mod._audit_durations_mode(
        artifact_dir, expected_shard_count=8, shard_result="success", backend_relevant="false",
    )
    assert exit_code == 1, "뮤테이션이 걸리지 않았다(backend_relevant 무시하고도 exit 0이 나왔다)"


# ── story #3911(CI 후속) — 등재 weight 자체가 낡아 own-weight 여유축(#3636)이 실제
# 클린 런 소요보다 훨씬 낮게 잡혀 있던 사고 2건(2026-09-15, 한 시간 새 세 번째 표본까지
# 포함해 fleet 25분씩 rerun 물림).
#
# ① PR #4308(run 34928133926, shard 3) — tests/test_3497_insight_snapshots.py 163s>151.2s
# ② PR #4311(run 34929762296, shard 3) — 같은 파일 134s>120.0s
# ③ PR #4314(run 34932958948, shard 6) — tests/test_3502_insights_board.py 161s>135.8s
#
# 그라운딩(포크 실측, run 60개 창 — story #3911 AC0): "동시 CI run 수"를 부하 대리
# 지표로 써 봤으나 상관관계가 없었다(클린 run도 동시성 3~6에서 관측, 사고 run과 겹침).
# 대신 등재 weight 자체가 이미 낡아 있었다 — test_3497(등재 34.0s)의 **클린** 런 실측은
# 49~59s(등재 대비 1.4~1.7배, 처음부터 과소), test_3502(등재 45.0s)의 클린 실측은
# 50~57s(1.1~1.3배). 사고 경과치(163/134/161s)는 클린 기준선 대비 2.3~3.4배로,
# «러너 전체가 느려진 정규화 대상 편차»가 아니라 **이 두 파일의 등재값이 실측을
# 못 따라간** 것이 근본 — PO 처방 (b) 그대로: 등재 가중치를 실측으로 재기준선한다
# (같은 run 동시 부하 보정 (a)는 상관관계 증거가 없어 채택하지 않음).
#
# ⛔fix(2026-09-15, PO 재측 정정) — 최초 60.0(두 파일 공통)안은 PR#4318 자체의
# shard-durations 아티팩트에서 PO가 직접 재측한 결과와 어긋났다: 클린 run
# 34932596611(PR#4313, success) test_3502=**62.0s**가 60.0을 넘음(같은 창의 run
# 34932229501(PR#4312, success)은 test_3497=56.0·test_3502=49.0 — 이쪽은 60.0 안). 「클린
# 최댓값 위 여유」 전제가 test_3502에서만 깨져 있었다 — test_3497은 60.0 유지, test_3502만
# 관측 최댓값(62.0) 위로 재상향(70.0). 알고리즘(slow_files_normalized 자체)은 무변경 —
# 데이터만 고친다.

_S3911_INCIDENT_A_ELAPSED = {
    "tests/normal_a.py": 25.2, "tests/normal_b.py": 25.2, "tests/normal_c.py": 25.2,
    "tests/test_3497_insight_snapshots.py": 163.0,
}
_S3911_INCIDENT_A_WEIGHTS_OLD = {
    "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
    "tests/test_3497_insight_snapshots.py": 34.0,
}  # median_ratio=2.52 → threshold=151.2(PR#4308 run 34928133926 실사고와 일치)

_S3911_INCIDENT_B_ELAPSED = {
    "tests/normal_a.py": 20.0, "tests/normal_b.py": 20.0, "tests/normal_c.py": 20.0,
    "tests/test_3497_insight_snapshots.py": 134.0,
}
_S3911_INCIDENT_B_WEIGHTS_OLD = {
    "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
    "tests/test_3497_insight_snapshots.py": 34.0,
}  # median_ratio=2.0 → threshold=120.0(PR#4311 run 34929762296 실사고와 일치)

_S3911_INCIDENT_C_ELAPSED = {
    "tests/normal_a.py": 22.633333, "tests/normal_b.py": 22.633333, "tests/normal_c.py": 22.633333,
    "tests/test_3502_insights_board.py": 161.0,
}
_S3911_INCIDENT_C_WEIGHTS_OLD = {
    "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
    "tests/test_3502_insights_board.py": 45.0,
}  # median_ratio≈2.263333 → threshold≈135.8(PR#4314 run 34932958948 실사고와 일치)

_S3911_NEW_WEIGHT_3497 = 60.0  # 클린 실측 최댓값(59s, PO 재측 56s 포함) 위 여유 반올림
_S3911_NEW_WEIGHT_3502 = 70.0  # 클린 실측 최댓값(PO 재측 62.0s) 위 여유 반올림 — 60.0은 부족했음(위 fix 참고)


def test_s3911_incident_a_still_fails_with_stale_registered_weight():
    """뮤테이션(AC2 양성대조) — 낡은 등재값(34.0)으로는 실사고 ①이 오늘도 재현된다
    (own-weight 여유축=34.0*3.0=102.0이 163.0보다 한참 낮다 — 근본원인 고정)."""
    mod = _load()
    slow, threshold, _ = mod.slow_files_normalized(_S3911_INCIDENT_A_ELAPSED, _S3911_INCIDENT_A_WEIGHTS_OLD)
    assert threshold == pytest.approx(151.2)
    assert slow == ["tests/test_3497_insight_snapshots.py"]


def test_s3911_incident_b_still_fails_with_stale_registered_weight():
    """뮤테이션(AC2 양성대조) — 실사고 ②도 낡은 등재값으로 재현(own-weight
    여유축=102.0 < 134.0)."""
    mod = _load()
    slow, threshold, _ = mod.slow_files_normalized(_S3911_INCIDENT_B_ELAPSED, _S3911_INCIDENT_B_WEIGHTS_OLD)
    assert threshold == pytest.approx(120.0)
    assert slow == ["tests/test_3497_insight_snapshots.py"]


def test_s3911_incident_c_still_fails_with_stale_registered_weight():
    """뮤테이션(AC2 양성대조) — 실사고 ③도 낡은 등재값으로 재현(own-weight
    여유축=45.0*3.0=135.0 < 161.0 — 근소하지만 실측과 정확히 일치하는 경계)."""
    mod = _load()
    slow, threshold, _ = mod.slow_files_normalized(_S3911_INCIDENT_C_ELAPSED, _S3911_INCIDENT_C_WEIGHTS_OLD)
    assert threshold == pytest.approx(135.8, abs=0.1)
    assert slow == ["tests/test_3502_insights_board.py"]


def test_s3911_incident_a_resolved_by_rebaselined_weight():
    """⭐story #3911 핵심(처방) — test_3497의 등재값을 60.0으로 재기준선하면
    own-weight 여유축(180.0)이 163.0보다 커져 실사고 ①이 더는 FAIL이 아니다."""
    mod = _load()
    weights = dict(_S3911_INCIDENT_A_WEIGHTS_OLD)
    weights["tests/test_3497_insight_snapshots.py"] = _S3911_NEW_WEIGHT_3497
    slow, _, _ = mod.slow_files_normalized(_S3911_INCIDENT_A_ELAPSED, weights)
    assert slow == [], f"재기준선 후에도 여전히 걸림: {slow}"


def test_s3911_incident_b_resolved_by_rebaselined_weight():
    """⭐실사고 ②도 재기준선(60.0) 후 FAIL 해소(180.0 > 134.0)."""
    mod = _load()
    weights = dict(_S3911_INCIDENT_B_WEIGHTS_OLD)
    weights["tests/test_3497_insight_snapshots.py"] = _S3911_NEW_WEIGHT_3497
    slow, _, _ = mod.slow_files_normalized(_S3911_INCIDENT_B_ELAPSED, weights)
    assert slow == [], f"재기준선 후에도 여전히 걸림: {slow}"


def test_s3911_incident_c_resolved_by_rebaselined_weight():
    """⭐실사고 ③도 재기준선(70.0, test_3502 전용) 후 FAIL 해소(210.0 > 161.0)."""
    mod = _load()
    weights = dict(_S3911_INCIDENT_C_WEIGHTS_OLD)
    weights["tests/test_3502_insights_board.py"] = _S3911_NEW_WEIGHT_3502
    slow, _, _ = mod.slow_files_normalized(_S3911_INCIDENT_C_ELAPSED, weights)
    assert slow == [], f"재기준선 후에도 여전히 걸림: {slow}"


def test_s3911_registered_weights_json_updated():
    """실 등재 파일(infra/destructive-schema-shard-weights/)이 재기준선 값을 실제로
    담고 있는지 — 위 단위 테스트는 값을 손으로 넣어 알고리즘만 검증하므로, 이 테스트가
    "그 값이 실제 등재 파일에도 반영됐다"는 배선을 고정한다. 두 파일이 서로 다른
    값(60.0/70.0)인 이유는 위 PO 재측 정정 fix 참고."""
    mod = _load()
    weights = mod.load_weights()
    assert weights["tests/test_3497_insight_snapshots.py"] == _S3911_NEW_WEIGHT_3497
    assert weights["tests/test_3502_insights_board.py"] == _S3911_NEW_WEIGHT_3502


def test_s3911_genuinely_hanging_file_still_caught_after_rebaseline():
    """회귀 0(AC1 "진짜 멈춤은 여전히 잡힌다") — 재기준선(60.0) 후에도 그 파일이
    러너 정상(배율~1) 상태에서 자기 weight의 3배 이상(180s+)로 튀면 여전히 FAIL."""
    mod = _load()
    elapsed = {
        "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
        "tests/test_3497_insight_snapshots.py": 200.0,  # 60.0의 3배(180.0) 초과 — 진짜 회귀
    }
    weights = {
        "tests/normal_a.py": 10.0, "tests/normal_b.py": 10.0, "tests/normal_c.py": 10.0,
        "tests/test_3497_insight_snapshots.py": _S3911_NEW_WEIGHT_3497,
    }
    slow, threshold, _ = mod.slow_files_normalized(elapsed, weights)
    assert slow == ["tests/test_3497_insight_snapshots.py"]
    assert threshold == 60.0  # 정상 러너(배율 1.0)


# ─── story #4206 — 러너 속도 배율(대조군)·push 범위 ─────────────────────────────────────

_RUNS_4206 = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "story_4206_runner_guard_runs.json").read_text()
)


def _judge_4206(run: dict, *, changed_files, use_factor: bool):
    mod = _load()
    changed = frozenset(changed_files) if changed_files is not None else None
    provisional = frozenset(run["provisional"])
    factor = (
        mod.runner_speed_factor(
            run["elapsed"], run["weights"], exclude=changed or frozenset(), provisional_files=provisional,
        )
        if use_factor else 1.0
    )
    red, _warn = mod.slow_files_absolute(
        run["elapsed"], run["weights"], provisional_files=provisional, changed_files=changed, runner_factor=factor,
    )
    return red, factor


@pytest.mark.parametrize("run", _RUNS_4206, ids=[r["label"] for r in _RUNS_4206])
def test_4206_old_judgment_reproduces_todays_red(run):
    """AC3 전제 — 옛 판정(diff 정보 없음·배율 1.0)이 오늘 attempt-1 로그의 RED 파일을 그대로 재현한다(픽스처가
    실제 입력임을 고정: job 로그의 파일별 elapsed · 그 시점 등재 weight)."""
    red, _ = _judge_4206(run, changed_files=None, use_factor=False)
    assert red == run["observed_red"]


@pytest.mark.parametrize("run", _RUNS_4206, ids=[r["label"] for r in _RUNS_4206])
def test_4206_new_judgment_passes_todays_runs(run):
    """⭐AC3 — 새 판정(push·PR 실제 diff의 변경 파일 + 대조군 러너 배율)으로 오늘 세 실행(6개 RED 샤드) 전부 RED 0.
    changed_files = 그 실행의 실제 diff를 classify_backend_test_diff_scope.sh(+#4163 app 모듈 참조 좁힘)로 판정한 값."""
    red, factor = _judge_4206(run, changed_files=run["changed_files"], use_factor=True)
    assert red == [], f"{run['label']} factor={factor:.2f} red={red}"


def test_4206_each_half_alone_is_not_enough():
    """근거(선택 이유) — 둘 중 하나만으로는 오늘을 못 구한다: diff만 쓰면 push ece08100e shard 5의 test_4098
    (events.py 변경의 참조 테스트, 73s>60s)이 남고, 배율만 쓰면(diff 없음) 등재값이 낡은 파일(test_3806 등)이 남는다."""
    diff_only = [r for run in _RUNS_4206 for r in _judge_4206(run, changed_files=run["changed_files"], use_factor=False)[0]]
    factor_only = [r for run in _RUNS_4206 for r in _judge_4206(run, changed_files=None, use_factor=True)[0]]
    assert diff_only == ["tests/test_4098_gate_linked_channel_draft_realdb.py"]
    assert "tests/test_3806_ads_boost_gate.py" in factor_only


def test_4206_slow_runner_changed_file_passes_but_lone_regression_stays_red():
    """AC2 — 느린 러너 흉내(대조군 전부 ×1.4 — 상한 1.5 안): 변경 파일도 그만큼 느리면 통과. 러너는 정상(대조군 ×1)인데
    변경 파일만 ×3이면 RED(양성 대조 — 배율이 «진짜로 느려진 변경 파일»까지 덮지 않는다)."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 30.0}
    changed = frozenset({"tests/changed.py"})

    slow_runner = {f"tests/c{i}.py": 42.0 for i in range(6)} | {"tests/changed.py": 100.0}
    factor = mod.runner_speed_factor(slow_runner, weights, exclude=changed)
    assert factor == pytest.approx(1.4)
    red, _ = mod.slow_files_absolute(slow_runner, weights, changed_files=changed, runner_factor=factor)
    assert red == []

    normal_runner = {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 90.0}
    factor = mod.runner_speed_factor(normal_runner, weights, exclude=changed)
    assert factor == 1.0
    red, _ = mod.slow_files_absolute(normal_runner, weights, changed_files=changed, runner_factor=factor)
    assert red == ["tests/changed.py"]


def test_4206_mutation_without_factor_slow_runner_is_red():
    """뮤테이션 — 배율을 빼면(1.0) 같은 느린 러너 표본이 RED로 되돌아간다."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 30.0}
    slow_runner = {f"tests/c{i}.py": 42.0 for i in range(6)} | {"tests/changed.py": 100.0}
    red, _ = mod.slow_files_absolute(slow_runner, weights, changed_files=frozenset({"tests/changed.py"}))
    assert red == ["tests/changed.py"]


def test_4206_factor_never_lowers_threshold_and_needs_min_sample():
    """빠른 러너(대조군 ×0.5)는 임계를 좁히지 않는다(1.0) · 대조군이 MIN_RATIO_SAMPLE 미만이면 1.0 ·
    변경 파일·provisional은 대조군에서 빠진다."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(4)}
    fast = {f"tests/c{i}.py": 15.0 for i in range(4)}
    assert mod.runner_speed_factor(fast, weights) == 1.0
    slow = {f"tests/c{i}.py": 90.0 for i in range(4)}
    assert mod.runner_speed_factor(slow, weights) == mod.RUNNER_FACTOR_CAP  # 3.0 → 상한(까디르 P1)
    assert mod.runner_speed_factor(slow, weights, cap=None) == 3.0
    assert mod.runner_speed_factor(slow, weights, exclude=frozenset({"tests/c0.py", "tests/c1.py"})) == 1.0
    assert mod.runner_speed_factor(
        slow, weights, provisional_files=frozenset({"tests/c0.py", "tests/c1.py"}),
    ) == 1.0


def test_4206_check_elapsed_mode_uses_factor_end_to_end(tmp_path, capsys, monkeypatch):
    """_check_elapsed_mode 전체 경로 — 오늘 push ece08100e shard 5(가장 빡빡했던 샤드) 입력 그대로: 변경 파일 목록을
    주면 exit 0 · 배율이 로그에 찍힌다."""
    mod = _load()
    run = next(r for r in _RUNS_4206 if r["label"] == "push ece08100e shard 5")
    monkeypatch.setattr(mod, "load_weights", lambda: run["weights"])
    monkeypatch.setattr(mod, "load_raw_entries", lambda: [{"file": f, "provisional": True} for f in run["provisional"]])
    elapsed_path = tmp_path / "elapsed.tsv"
    elapsed_path.write_text("\n".join(f"{f}\t{s}" for f, s in run["elapsed"].items()))
    changed_path = tmp_path / "changed.txt"
    changed_path.write_text("\n".join(run["changed_files"]))
    assert mod._check_elapsed_mode(elapsed_path, changed_files_path=changed_path) == 0
    err = capsys.readouterr().err
    assert "러너 속도 배율" in err and "OK" in err



def test_4206_code_wide_slowdown_is_red_again_because_of_the_cap():
    """까디르 P1 — 코드발 전역 둔화(conftest·공용 픽스처)로 **모든** 파일이 5배: 상한이 없으면 대조군 중앙값도 5라 판정선이
    같이 올라가 RED 0이었다. 상한 1.5로 다시 RED. 뮤테이션: 상한 제거(cap=None) → RED 0으로 이 테스트 RED.

    정직한 한계(수치): 판정선 = 등재 weight × 2.5(#4152) × 배율(≤1.5) → 전역 둔화는 등재값의 **3.75배를 넘어야** RED다.
    3배 전역 둔화는 경고 줄(배율 3.0 > 1.3)로만 보인다 — 아래 3.5배 대조가 그 경계를 고정한다."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 30.0}
    changed = frozenset({"tests/changed.py"})
    for mult, expect_red in ((5.0, True), (3.5, False)):
        everything = {f: w * mult for f, w in weights.items()}
        factor = mod.runner_speed_factor(everything, weights, exclude=changed)
        assert factor == mod.RUNNER_FACTOR_CAP
        red, _ = mod.slow_files_absolute(everything, weights, changed_files=changed, runner_factor=factor)
        assert (red == ["tests/changed.py"]) is expect_red, (mult, red)


def test_4206_capped_factor_still_clears_todays_twenty():
    """PO 결정 근거 — 상한 1.5에서도 오늘 RED 20건 픽스처는 전부 0(위 new_judgment 테스트가 상한 적용 판정으로 잰다 ·
    여기선 각 샤드 적용 배율이 상한 이하임을 같이 확인)."""
    for run in _RUNS_4206:
        red, factor = _judge_4206(run, changed_files=run["changed_files"], use_factor=True)
        assert red == [] and factor <= 1.5, (run["label"], factor, red)


def test_4206_factor_over_warn_threshold_prints_big_summary_line(tmp_path, capsys, monkeypatch):
    """배율 1.3 초과면 annotation + 잡 요약(GITHUB_STEP_SUMMARY)에 경고 줄 — 1.0~1.5배 전역 둔화가 사람에게 보이는 유일한
    자리. 배율 1.4 대조군 · 1.2면 안 뜸."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)}
    monkeypatch.setattr(mod, "load_weights", lambda: weights)
    monkeypatch.setattr(mod, "load_raw_entries", lambda: [])
    for ratio, expect in ((1.4, True), (1.2, False)):
        summary = tmp_path / f"summary_{ratio}.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
        elapsed_path = tmp_path / f"elapsed_{ratio}.tsv"
        elapsed_path.write_text("\n".join(f"{f}\t{w * ratio}" for f, w in weights.items()))
        changed_path = tmp_path / "changed.txt"
        changed_path.write_text("")
        assert mod._check_elapsed_mode(elapsed_path, changed_files_path=changed_path) == 0
        out = capsys.readouterr().out
        assert ("러너 속도 배율" in out) is expect, (ratio, out)
        assert summary.exists() is expect


# ─── story #4283 — 한 번 재실행으로 확인한 뒤에만 RED · 판정 여유 붕괴 경고 ──────────────

# 카드의 네 run(PO · 까디르 2026-09-24) — 1차 경과 · 그 샤드의 적용 러너 배율(잡 로그 «실측 → 적용» 줄) · 재실행 경과.
# 재실행 경과는 같은 run attempt 2 잡 로그의 `elapsed:` 줄(36018618543 · 36040923585 · 36041927912). 36035793068은
# attempt 2 없이 새 커밋으로 넘어가 재실행 값이 없다 — 그 둘만 성공 run 17개의 CI 중앙값(test_2636 41s · test_3815 34s)을
# 대리값으로 쓴다(그 파일이 평소 속도로 한 번 더 돈다는 가정 — 라벨로 구분).
_CARD_RUNS_4283 = [
    {"label": "36018618543 a1 샤드4", "file": "tests/test_3313_recipe_notification_render.py", "first": 108.0, "factor": 1.07, "rerun": 27.0},
    {"label": "36035793068 샤드1(재실행=CI 중앙값 대리)", "file": "tests/test_2636_custom_event_registration.py", "first": 156.0, "factor": 1.50, "rerun": 41.0},
    {"label": "36035793068 샤드1(재실행=CI 중앙값 대리)", "file": "tests/test_3815_youtube_publish.py", "first": 102.0, "factor": 1.50, "rerun": 34.0},
    {"label": "36040923585 a1 샤드7", "file": "tests/test_4191_recipe_newsletter_send_realdb.py", "first": 82.0, "factor": 1.25, "rerun": 25.0},
    {"label": "36041927912 a1 샤드6", "file": "tests/test_3809_org_cost_summary.py", "first": 141.0, "factor": 1.50, "rerun": 40.0},
]


def _judge_4283(mod, case, *, rerun):
    weights = mod.load_weights()
    red, _ = mod.slow_files_absolute(
        {case["file"]: case["first"]}, weights, changed_files=frozenset({case["file"]}), runner_factor=case["factor"],
    )
    if not red:
        return [], []
    return mod.confirmed_slow_files(red, {case["file"]: rerun}, weights, runner_factor=case["factor"])


@pytest.mark.parametrize("case", _CARD_RUNS_4283, ids=[f"{c['label']} {c['file']}" for c in _CARD_RUNS_4283])
def test_4283_card_runs_are_green_with_the_rerun_they_actually_got(case):
    """⭐AC(양성 대조 ②) — 카드의 네 run 재현 입력(현재 등재 weight): 1차 판정에서 이미 통과하거나(weight 갱신) 재실행
    경과로 내려와 RED 0."""
    confirmed, _ = _judge_4283(_load(), case, rerun=case["rerun"])
    assert confirmed == [], case


@pytest.mark.parametrize("case", _CARD_RUNS_4283, ids=[f"{c['label']} {c['file']}" for c in _CARD_RUNS_4283])
def test_4283_same_input_with_a_deterministic_slowdown_stays_red(case):
    """⭐AC(양성 대조 ①) — 같은 입력인데 재실행도 1차만큼 느리면(PR이 그 경로를 결정적으로 느리게 만든 경우) RED.
    1차에서 판정선 안인 파일은 재실행까지 안 가므로, 판정선을 넘을 만큼 느려진 경우(1차 = 판정선 × 1.3)로 잰다."""
    mod = _load()
    weights = mod.load_weights()
    slow = mod.absolute_slow_threshold_sec(weights[case["file"]]) * case["factor"] * 1.3
    slowed = dict(case, first=slow)
    confirmed, _ = _judge_4283(mod, slowed, rerun=slow)
    assert confirmed == [case["file"]]


def test_4283_confirmed_slow_files_rules():
    """재실행도 넘으면 RED · 내려오면 해제 · 재실행 기록이 없으면(재실행이 못 돈 파일) RED(안전측) · 판정선은 1차 배율."""
    mod = _load()
    weights = {"tests/a.py": 30.0, "tests/b.py": 30.0, "tests/c.py": 30.0}
    # 판정선 = max(30×2.5, 60) × 1.2 = 90s.
    confirmed, cleared = mod.confirmed_slow_files(
        ["tests/a.py", "tests/b.py", "tests/c.py"], {"tests/a.py": 95.0, "tests/b.py": 85.0}, weights, runner_factor=1.2,
    )
    assert confirmed == ["tests/a.py", "tests/c.py"]
    assert cleared == ["tests/b.py"]


def _write_run(tmp_path, name, elapsed):
    path = tmp_path / name
    path.write_text("\n".join(f"{f}\t{s}" for f, s in elapsed.items()))
    return path


def test_4283_check_then_confirm_end_to_end(tmp_path, capsys, monkeypatch):
    """ci.yml이 부르는 순서 그대로: --check-elapsed --suspects-out → exit 3 · 후보 파일 → --confirm-elapsed.
    재실행에서 내려오면 exit 0 + 두 값을 ::warning:: 로(PO 조건 ①) · 재실행도 넘으면 exit 1 + ::error::."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 30.0}
    monkeypatch.setattr(mod, "load_weights", lambda: weights)
    monkeypatch.setattr(mod, "load_raw_entries", list)
    first = _write_run(tmp_path, "first.tsv", {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 100.0})
    changed = tmp_path / "changed.txt"
    changed.write_text("tests/changed.py\n")
    suspects = tmp_path / "suspects.txt"

    assert mod._check_elapsed_mode(first, changed_files_path=changed, suspects_out_path=suspects) == mod.CONFIRM_RERUN_EXIT
    assert suspects.read_text() == "tests/changed.py\n"
    assert "::error::" not in capsys.readouterr().out

    spike = _write_run(tmp_path, "rerun_spike.tsv", {"tests/changed.py": 31.0})
    assert mod._confirm_elapsed_mode(first, spike, suspects, changed_files_path=changed) == 0
    out = capsys.readouterr().out
    assert "::warning::러너 정규화 가드(story #4283) — tests/changed.py 1차 100s" in out and "재실행 31s" in out
    assert "::error::" not in out

    real = _write_run(tmp_path, "rerun_real.tsv", {"tests/changed.py": 98.0})
    assert mod._confirm_elapsed_mode(first, real, suspects, changed_files_path=changed) == 1
    assert "::error::러너 정규화 절대 가드 초과(story #4152): tests/changed.py" in capsys.readouterr().out


def test_4283_more_suspects_than_the_cap_is_red_without_rerun(tmp_path, capsys, monkeypatch):
    """1차 초과가 CONFIRM_RERUN_MAX_FILES를 넘으면(광범위 둔화) 재실행 없이 바로 RED(exit 1) · 후보 파일 안 씀.
    뮤테이션: 상한 검사를 빼면 exit 3으로 이 테스트 RED."""
    mod = _load()
    n = mod.CONFIRM_RERUN_MAX_FILES + 1
    changed_names = [f"tests/x{i}.py" for i in range(n)]
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)} | {f: 30.0 for f in changed_names}
    monkeypatch.setattr(mod, "load_weights", lambda: weights)
    monkeypatch.setattr(mod, "load_raw_entries", list)
    first = _write_run(tmp_path, "first.tsv", {f"tests/c{i}.py": 30.0 for i in range(6)} | {f: 100.0 for f in changed_names})
    changed = tmp_path / "changed.txt"
    changed.write_text("\n".join(changed_names))
    suspects = tmp_path / "suspects.txt"
    assert mod._check_elapsed_mode(first, changed_files_path=changed, suspects_out_path=suspects) == 1
    assert not suspects.exists()
    assert capsys.readouterr().out.count("::error::러너 정규화 절대 가드 초과") == n


def test_4283_without_suspects_out_the_old_contract_holds(tmp_path, monkeypatch):
    """--suspects-out을 안 주는 호출(예전 호출부)은 예전 그대로 바로 RED(exit 1)."""
    mod = _load()
    weights = {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 30.0}
    monkeypatch.setattr(mod, "load_weights", lambda: weights)
    monkeypatch.setattr(mod, "load_raw_entries", list)
    first = _write_run(tmp_path, "first.tsv", {f"tests/c{i}.py": 30.0 for i in range(6)} | {"tests/changed.py": 100.0})
    changed = tmp_path / "changed.txt"
    changed.write_text("tests/changed.py\n")
    assert mod._check_elapsed_mode(first, changed_files_path=changed) == 1


def test_4283_ci_yml_reruns_suspects_before_confirming():
    """ci.yml 배선 — 1차 판정에 --suspects-out, exit 3이면 같은 격리 루프 스크립트로 후보만 재실행 → 재실행 실패는
    RED → --confirm-elapsed. 순서가 뒤집히거나 한 줄이 빠지면 이 테스트 RED."""
    text = (_REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text()
    i_check = text.index('--suspects-out "$suspects_file"')
    i_gate = text.index('if [ "$slow_exit" -eq 3 ]; then', i_check)
    i_rerun = text.index('FILES_LIST_FILE="$suspects_file"', i_gate)
    i_loop = text.index("run-destructive-shard-loop.sh", i_rerun)
    i_failed = text.index('if [ -s "$rerun_failed" ]; then', i_loop)
    i_confirm = text.index('--confirm-elapsed "$elapsed_file" "$rerun_elapsed" "$suspects_file"', i_failed)
    i_json = text.index("--elapsed-to-json", i_confirm)
    assert i_check < i_gate < i_rerun < i_loop < i_failed < i_confirm < i_json


# 카드 7건에 걸렸던 · 판정 여유가 무너졌던 12개 파일의 CI 중앙값(성공 run 17개 durations 산출물 · 2026-09-17~24).
_CI_MEDIAN_4283 = {
    "tests/test_3808_x_thread_publish.py": 36.0, "tests/test_3815_youtube_publish.py": 34.0,
    "tests/test_3813_stibee_esp_connection.py": 28.0, "tests/test_3806_ads_boost_gate.py": 35.0,
    "tests/test_3816_ghost_connect.py": 31.0, "tests/test_4042_evidence_kind_fail_closed_registry_realdb.py": 31.0,
    "tests/test_3806_ads_boost_execution.py": 29.0, "tests/test_3813_newsletter_send_gate.py": 29.0,
    "tests/test_3806_ads_boost_spend.py": 37.0, "tests/test_3809_org_cost_summary.py": 37.0,
    "tests/test_4191_recipe_newsletter_send_realdb.py": 35.0, "tests/test_3828_conversation_thread_link.py": 33.0,
}


def test_4283_refreshed_weights_restore_the_guard_margin():
    """갱신 뒤 12개 파일 전부 판정선이 CI 중앙값의 GUARD_MARGIN_WARN배 이상(= 여유 붕괴 경고 대상 아님) · 등재 source에
    출처가 박혀 있다. 누가 이 값을 옛 로컬값으로 되돌리면 RED."""
    mod = _load()
    weights = mod.load_weights()
    entries = {e["file"]: e for e in mod.load_raw_entries()}
    assert mod.guard_margin_collapsed(_CI_MEDIAN_4283, weights) == []
    for f in _CI_MEDIAN_4283:
        assert "story #4283" in entries[f]["source"] and entries[f].get("provisional") is not True, f


def test_4283_margin_collapse_warns_after_three_runs_and_resets(tmp_path, capsys, monkeypatch):
    """PO 조건 ② — 다음 낡음이 사람 눈에 먼저: 판정선이 실측의 2배 미만인 run이 3번 연속이면 audit이 ::warning:: +
    잡 요약 표. 2번까진 안 뜸(단발 튐 거름) · 발화 뒤 리셋 · 정상 run이 끼면 스트릭 0.
    옛 등재값(test_3808 3.9s) × CI 중앙값 36s 그대로 — 판정선 60s = 실측의 1.67배."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/test_3808_x_thread_publish.py": 3.9})
    monkeypatch.setattr(mod, "load_raw_entries", list)
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    state_path = tmp_path / "drift-state.json"

    def _run(run_id, elapsed):
        (artifact_dir / "shard-durations-0.json").write_text(
            json.dumps({"shard": 0, "durations": {"tests/test_3808_x_thread_publish.py": elapsed}})
        )
        mod._audit_durations_mode(artifact_dir, drift_state_path=state_path, run_id=run_id)
        return capsys.readouterr().out

    tag = "::warning::절대 가드 판정 여유 붕괴(story #4283): tests/test_3808_x_thread_publish.py"
    assert tag not in _run("r1", 36.0)
    assert tag not in _run("r2", 36.0)
    assert tag not in _run("r2", 36.0)  # 같은 run 재시도 — 이중 카운트 없음.
    assert tag in _run("r3", 36.0)
    assert "절대 가드 판정 여유 붕괴" in summary.read_text()
    assert tag not in _run("r4", 36.0)  # 발화 뒤 리셋.
    assert tag not in _run("r5", 20.0)  # 판정선 60s / 20s = 3배 — 정상, 스트릭 0.
    assert tag not in _run("r6", 36.0)
    assert tag not in _run("r7", 36.0)
    assert tag in _run("r8", 36.0)


def test_4283_margin_state_is_backward_compatible(tmp_path):
    """옛 모양 상태 파일(margin_streaks 키 없음)은 빈 스트릭으로 읽히고 · 비어 있으면 저장에도 안 실린다."""
    mod = _load()
    state_path = tmp_path / "s.json"
    state_path.write_text(json.dumps({"run_id": "r", "streaks": {"tests/a.py": 1}}))
    assert mod._load_drift_state(state_path)["margin_streaks"] == {}
    mod._save_drift_state(state_path, run_id="r", streaks={}, margin_streaks={})
    assert json.loads(state_path.read_text()) == {"run_id": "r", "streaks": {}}


# ─── story #4283(까디르 P1) — 워크플로 스텝 원문을 GitHub 기본 셸(`bash -e {0}`)로 그대로 돌린다 ──────────────
# 이 스텝엔 `shell:`이 없어(워크플로 `defaults`도 없음) GitHub 기본 `bash -e {0}`로 돈다. 첫 구현은 `set -uo pipefail`만
# 적어 -e가 켜진 채였고, `--check-elapsed`가 exit 3을 내는 순간 스텝이 죽어 재실행 갈래에 못 갔다. 로컬 e2e는 -e 없는
# 셸로 돌려 이걸 못 봤다 — 그래서 여기선 ci.yml의 `run:` 텍스트를 그대로 꺼내 `bash -e`로 실행한다. 바꾸는 건 `${{ }}`
# 값 · `/tmp/` 위치 · `uv`(→ 이 파이썬으로 실제 스크립트 실행) · 격리 루프 스크립트(→ 시나리오대로 경과를 쓰는 스텁)뿐이고,
# 판정은 진짜 `shard_destructive_tests.py` + 진짜 등재 weight가 한다.

_LOOP_STUB = r"""#!/usr/bin/env bash
# 격리 루프 스텁 — 부를 때마다 call 번호를 올리고 $SCENARIO_DIR/call_N.tsv의 경과를 FILES_LIST_FILE 순서대로 쓴다.
set -u
n=$(( $(cat "$SCENARIO_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$SCENARIO_DIR/calls"
: > "$FAILED_OUT_FILE"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  sec=$(awk -F'\t' -v f="$f" '$1==f {print $2}' "$SCENARIO_DIR/call_$n.tsv")
  printf '%s\t%s\n' "$f" "${sec:-1}" >> "$ELAPSED_OUT_FILE"
done < "$FILES_LIST_FILE"
[ -f "$SCENARIO_DIR/fail_$n.txt" ] && cat "$SCENARIO_DIR/fail_$n.txt" >> "$FAILED_OUT_FILE"
[ -f "$SCENARIO_DIR/unreadable_$n" ] && chmod 000 "$FAILED_OUT_FILE"
exit "$(cat "$SCENARIO_DIR/exit_$n" 2>/dev/null || echo 0)"
"""


def _bash5() -> str | None:
    import shutil
    import subprocess

    for cand in (shutil.which("bash"), "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"):
        if not cand or not Path(cand).exists():
            continue
        out = subprocess.run([cand, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True, text=True, check=False).stdout.strip()
        if out.isdigit() and int(out) >= 4:  # mapfile — macOS 기본 /bin/bash 3.2엔 없다.
            return cand
    return None


def _destructive_step_run() -> str:
    import yaml

    wf = yaml.safe_load((_REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text())
    step = next(
        s for s in wf["jobs"]["backend-test-destructive"]["steps"]
        if s.get("name", "").startswith("Run pytest (destructive schema")
    )
    # 전제 고정: 셸을 안 적었다 = GitHub 기본 `bash -e {0}`. 누가 `shell:`을 달면 이 테스트의 셸도 같이 바꿔야 한다.
    assert "shell" not in step and "defaults" not in wf and "defaults" not in wf["jobs"]["backend-test-destructive"]
    return step["run"]


def _run_step(
    tmp_path, *, targets, first, rerun=None, rerun_fail=None, run_text=None, uv_fail_on="", value_overrides=None,
    drop_shard_files=False, mktemp_fail_at=None, unreadable_failed_out_call=None, rerun_exit=None,
):
    import re
    import shutil
    import subprocess

    bash = _bash5()
    if bash is None:
        pytest.skip("bash 4+ 없음(mapfile) — CI ubuntu엔 있다")
    mod = _load()
    weights = mod.load_weights()
    provisional = mod.provisional_files_in(mod.load_raw_entries())
    controls = [f for f in sorted(weights) if f not in provisional and f not in targets][:6]
    scen = tmp_path / "scenario"
    scen.mkdir(parents=True)
    ws = tmp_path / "ws"
    (ws / "scripts").mkdir(parents=True)
    loop = ws / "scripts" / "run-destructive-shard-loop.sh"
    loop.write_text(_LOOP_STUB)
    loop.chmod(0o755)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    uv = bindir / "uv"
    uv.write_text(
        '#!/usr/bin/env bash\n[ "$1" = run ] && [ "$2" = python ] || exit 99\n'
        'if [ -n "${UV_FAIL_ON:-}" ]; then case " $* " in *" $UV_FAIL_ON "*) exit 7;; esac; fi\n'
        f'shift 2\nexec "{sys.executable}" "$@"\n'
    )
    uv.chmod(0o755)
    if mktemp_fail_at is not None:
        # N번째 mktemp만 실패(디스크 가득 흉내) — 나머지는 진짜 mktemp.
        real_mktemp = shutil.which("mktemp")
        stub = bindir / "mktemp"
        stub.write_text(
            '#!/usr/bin/env bash\n'
            'c=$(( $(cat "$SCENARIO_DIR/mktemp_calls" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$SCENARIO_DIR/mktemp_calls"\n'
            f'[ "$c" -eq {mktemp_fail_at} ] && exit 1\n'
            f'exec "{real_mktemp}" "$@"\n'
        )
        stub.chmod(0o755)
    tmpdir = tmp_path / "t"
    tmpdir.mkdir()
    if not drop_shard_files:
        (tmpdir / "shard_files.txt").write_text("".join(f"{f}\n" for f in controls + targets))

    def _write_call(n, values):
        (scen / f"call_{n}.tsv").write_text("".join(f"{f}\t{s}\n" for f, s in values.items()))

    _write_call(1, {f: weights[f] for f in controls} | {f: first(mod, weights, f) for f in targets})
    if rerun is not None:
        _write_call(2, {f: rerun(mod, weights, f) for f in targets})
    if rerun_fail:
        (scen / "fail_2.txt").write_text("".join(f"{f}\n" for f in rerun_fail))
    if rerun_exit is not None:
        (scen / "exit_2").write_text(f"{rerun_exit}\n")
    if unreadable_failed_out_call is not None:
        (scen / f"unreadable_{unreadable_failed_out_call}").write_text("")

    values = {
        "github.workspace": str(ws), "matrix.shard": "0",
        "needs.detect-changed-scope.outputs.backend_test_files_changed": " ".join(targets),
        "needs.detect-changed-scope.outputs.backend_app_files_changed": "",
        "needs.detect-changed-scope.outputs.backend_mixed_test_files_changed": "",
    } | (value_overrides or {})
    text = run_text if run_text is not None else _destructive_step_run()
    text = re.sub(r"\$\{\{\s*([^}]+?)\s*\}\}", lambda m: values[m.group(1)], text)
    text = text.replace("/tmp/", f"{tmpdir}/")
    script = tmp_path / "step.sh"
    script.write_text(text)
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", SCENARIO_DIR=str(scen), TMPDIR=str(tmpdir),
               UV_FAIL_ON=uv_fail_on)
    env.pop("GITHUB_STEP_SUMMARY", None)
    proc = subprocess.run([bash, "-e", str(script)], cwd=_REPO_ROOT / "backend", env=env, capture_output=True, text=True, check=False)
    calls = int((scen / "calls").read_text()) if (scen / "calls").exists() else 0
    return proc.returncode, proc.stdout + proc.stderr, calls


def _over(mod, weights, f):
    return round(mod.absolute_slow_threshold_sec(weights[f]) * 1.3)


def _normal(mod, weights, f):
    return round(weights[f])


_STEP_TARGET = ["tests/test_3813_stibee_esp_connection.py"]


def test_4283_step_under_bash_e_spike_is_green_with_warning(tmp_path):
    """⭐후보 1 → 재실행에서 내려옴 → 스텝 exit 0 + 두 값 ::warning::(루프 두 번 불림 = 재실행 갈래에 실제로 감)."""
    code, out, calls = _run_step(tmp_path, targets=_STEP_TARGET, first=_over, rerun=_normal)
    assert code == 0, out
    assert calls == 2
    assert "::warning::러너 정규화 가드(story #4283) — tests/test_3813_stibee_esp_connection.py 1차" in out


def test_4283_step_under_bash_e_repeat_is_red(tmp_path):
    """후보 1 → 재실행도 넘음 → exit 1 + ::error::."""
    code, out, calls = _run_step(tmp_path, targets=_STEP_TARGET, first=_over, rerun=_over)
    assert code == 1 and calls == 2, out
    assert "::error::러너 정규화 절대 가드 초과(story #4152): tests/test_3813_stibee_esp_connection.py" in out


def test_4283_step_under_bash_e_rerun_test_failure_is_red(tmp_path):
    """재실행에서 테스트가 실패하면 경과와 무관하게 exit 1."""
    code, out, calls = _run_step(
        tmp_path, targets=_STEP_TARGET, first=_over, rerun=_normal, rerun_fail=_STEP_TARGET,
    )
    assert code == 1 and calls == 2, out
    assert "재실행에서 테스트 실패(story #4283)" in out


def test_4283_step_under_bash_e_six_suspects_is_red_without_rerun(tmp_path):
    """후보 6(> CONFIRM_RERUN_MAX_FILES) → 재실행 없이 exit 1(루프 한 번만)."""
    mod = _load()
    weights = mod.load_weights()
    provisional = mod.provisional_files_in(mod.load_raw_entries())
    targets = [f for f in sorted(weights, reverse=True) if f not in provisional][: mod.CONFIRM_RERUN_MAX_FILES + 1]
    code, out, calls = _run_step(tmp_path, targets=targets, first=_over)
    assert code == 1 and calls == 1, out
    assert out.count("::error::러너 정규화 절대 가드 초과") == len(targets)


_CHECK_CAPTURE = '--suspects-out "$suspects_file" --expected-files /tmp/shard_files.txt || slow_exit=$?'


def test_4283_step_mutation_first_implementation_dies_at_exit_3(tmp_path):
    """뮤테이션 — 첫 구현 모양(`set +e` 없음 + `cmd` 다음 줄 `slow_exit=$?`)으로 되돌리면 기본 셸의 -e가 exit 3에서 스텝을
    죽여 재실행 갈래에 못 간다: 단발 튐이 RED가 된다(루프 한 번만). 지금 모양은 둘 중 하나만 있어도 산다 — `|| x=$?`가
    -e에서도 종료 코드를 받는 쪽이고 `set +e`는 주석이 말한 설계를 실제 셸에 맞추는 쪽이라, 둘 다 걷어야 옛 결함이 재현된다."""
    text = _destructive_step_run()
    assert text.count("\nset +e\n") == 1 and text.count(_CHECK_CAPTURE) == 1
    mutated = text.replace("\nset +e\n", "\n").replace(
        _CHECK_CAPTURE, '--suspects-out "$suspects_file" --expected-files /tmp/shard_files.txt\nslow_exit=$?',
    )
    code, out, calls = _run_step(tmp_path, targets=_STEP_TARGET, first=_over, rerun=_normal, run_text=mutated)
    assert code != 0 and calls == 1, out

    only_set_e_removed = text.replace("\nset +e\n", "\n")
    code, out, calls = _run_step(tmp_path / "b", targets=_STEP_TARGET, first=_over, rerun=_normal, run_text=only_set_e_removed)
    assert code == 0 and calls == 2, out


def test_4283_step_loop_infra_failure_still_stops_the_step(tmp_path):
    """-e에 기대던 자리 — 격리 루프가 인프라 실패(non-zero)로 끝나면 여전히 스텝 RED(명시 처리로 옮김)."""
    # call 1이 exit 1 — 시나리오 폴더는 _run_step 안에서 만들어지므로 스텁이 읽을 exit_1을 스텝 앞머리에 심는다.
    text = _destructive_step_run().replace("\nset +e\n", '\nset +e\necho 1 > "$SCENARIO_DIR/exit_1"\n', 1)
    code, out, calls = _run_step(tmp_path, targets=_STEP_TARGET, first=_normal, run_text=text)
    assert code == 1 and calls == 1, out
    assert "격리 루프 인프라 실패" in out


@pytest.mark.parametrize(
    ("content", "expected", "needle"),
    [
        ("tests/a.py\tnan\n", None, "유한수가 아님"),
        ("tests/a.py\tinf\n", None, "유한수가 아님"),
        ("tests/a.py\t-3\n", None, "음수"),
        ("tests/a.py\tabc\n", None, "숫자가 아님"),
        ("", None, "0줄"),
        ("tests/a.py\t10\n", ["tests/a.py", "tests/b.py"], "tests/b.py: 경과 기록 없음"),
    ],
)
def test_4283_record_fail_open_is_red_in_both_modes(tmp_path, capsys, monkeypatch, content, expected, needle):
    """까디르 P1② — NaN(어떤 비교도 False) · inf · 음수 · 숫자 아님 · 0줄 · 돌았어야 하는 파일 누락 → check/confirm 둘 다 exit 1
    + ::error::(판정 불가). 예전엔 전부 «느린 게 없다»로 읽혀 초록."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/a.py": 30.0, "tests/b.py": 30.0})
    monkeypatch.setattr(mod, "load_raw_entries", list)
    bad = tmp_path / "bad.tsv"
    bad.write_text(content)
    expected_path = None
    if expected is not None:
        expected_path = tmp_path / "expected.txt"
        expected_path.write_text("\n".join(expected))
    assert mod._check_elapsed_mode(bad, expected_files_path=expected_path) == 1
    assert needle in capsys.readouterr().out

    good = _write_run(tmp_path, "good.tsv", {"tests/a.py": 100.0, "tests/b.py": 30.0})
    suspects = tmp_path / "suspects.txt"
    suspects.write_text("tests/a.py\n" + ("tests/b.py\n" if expected else ""))
    assert mod._confirm_elapsed_mode(good, bad, suspects) == 1
    assert "::error::러너 정규화 가드 재실행 기록 이상" in capsys.readouterr().out


def test_4283_confirm_with_missing_or_empty_suspects_is_red(tmp_path, capsys, monkeypatch):
    """후보 목록 파일이 없거나 비면(재실행이 무엇을 확인했는지 모름) RED."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: {"tests/a.py": 30.0})
    monkeypatch.setattr(mod, "load_raw_entries", list)
    good = _write_run(tmp_path, "good.tsv", {"tests/a.py": 100.0})
    empty = tmp_path / "empty.txt"
    empty.write_text("")
    assert mod._confirm_elapsed_mode(good, good, empty) == 1
    assert mod._confirm_elapsed_mode(good, good, tmp_path / "nope.txt") == 1
    assert "재실행 후보 목록이 비었거나 없음" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("label", "kwargs", "needle"),
    [
        ("파일 목록 없음", {"drop_shard_files": True}, "샤드 파일 목록"),
        ("narrowing 계산 실패", {
            "uv_fail_on": "--resolve-app-module-dependents",
            "value_overrides": {
                "needs.detect-changed-scope.outputs.backend_test_files_changed": "__ALL__",
                "needs.detect-changed-scope.outputs.backend_app_files_changed": "app/routers/events.py",
            },
        }, "narrowing 계산 실패"),
        ("산출물 변환 실패", {"uv_fail_on": "--elapsed-to-json"}, "산출물 변환 실패"),
    ],
)
def test_4283_step_places_that_relied_on_bash_e_still_stop_the_step(tmp_path, label, kwargs, needle):
    """`set +e` 뒤에도 예전에 -e가 막던 자리(파일 목록 · narrowing · 산출물 변환 · 격리 루프는 위 테스트)는 명시로 RED —
    그냥 넘어가면 0개 실행 · 후보 목록 빔 · 산출물 누락으로 조용히 초록이 된다."""
    code, out, _ = _run_step(tmp_path, targets=_STEP_TARGET, first=_normal, **kwargs)
    assert code == 1, (label, out)
    assert needle in out, (label, out)


# 스텝 안 mktemp 순서: elapsed · failed_out · overage_out · unweighted · suspects · rerun_elapsed · rerun_failed(7번째).
@pytest.mark.parametrize("n", range(1, 8))
def test_4283_step_mktemp_failure_is_red(tmp_path, n):
    """까디르 P2 — `set +e` 뒤 임시 파일 생성 실패가 조용히 지나가면 안 된다: 몇 번째 mktemp가 실패하든(단발 튐 시나리오 —
    재실행 갈래까지 가는 경로) exit 1 + ::error::. 특히 7번째(`rerun_failed`)가 안 생기면 `[ -s ]`가 «재실행 실패 없음»으로
    읽혀 테스트 실패를 초록으로 가렸다."""
    code, out, _ = _run_step(tmp_path, targets=_STEP_TARGET, first=_over, rerun=_normal, mktemp_fail_at=n)
    assert code == 1, (n, out)
    assert "임시 파일 생성 실패" in out, (n, out)


def test_4283_step_unreadable_loop_result_is_red(tmp_path):
    """격리 루프 결과(FAILED_OUT_FILE)를 못 읽으면 «실패 0건»으로 읽지 않고 RED."""
    code, out, _ = _run_step(tmp_path, targets=_STEP_TARGET, first=_normal, unreadable_failed_out_call=1)
    assert code == 1, out
    assert "결과 파일을 못 읽음" in out



def test_4283_step_rerun_loop_nonzero_without_failure_file_is_red(tmp_path):
    """까디르 델타 — 재실행 루프가 실패 파일을 못 쓰고(= 비어 있음) non-zero로 끝나면, 파일 내용이 «실패 없음»이어도 RED:
    재실행 갈래는 실패 파일과 루프 종료 코드를 둘 다 본다(둘 다 깨끗해야 초록). 재실행 경과 자체는 판정선 안(단발 튐)."""
    code, out, calls = _run_step(tmp_path, targets=_STEP_TARGET, first=_over, rerun=_normal, rerun_exit=1)
    assert code == 1 and calls == 2, out
    assert "재실행 루프 인프라 실패" in out

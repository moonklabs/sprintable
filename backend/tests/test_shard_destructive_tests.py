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


def test_check_elapsed_mode_exit_code_matches_slow_files(tmp_path, capsys, monkeypatch):
    """_check_elapsed_mode()를 통째로 돌려 오늘 실사고 표본이 exit 0(정상 판정)이
    되는지 e2e로 확인한다(파일 파싱·가중치 로딩·판정 전체 경로). 이 픽스처는 PR
    #3753(2026-09-03) 실사고 당시의 weight 스냅샷(_RUN_33773872963_SHARD0_WEIGHTS)을
    재현하는 것이 목적이라 **그 시점 값을 고정**해야 한다 — 실 weights.json을 그대로
    읽으면(story #3558, 2026-09-06 전수 재측정으로 값이 갱신된 뒤) 이 역사적 시나리오
    재현이 매번 지금 시점의 등재값에 따라 값이 달라져 깨진다(실측 fix 자체가 이
    회귀를 노출시킴 — load_weights를 monkeypatch해 고정)."""
    mod = _load()
    monkeypatch.setattr(mod, "load_weights", lambda: _RUN_33773872963_SHARD0_WEIGHTS)
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

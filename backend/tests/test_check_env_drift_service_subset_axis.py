"""story #2305 — infra/check_env_drift.py 축⑥ "서비스명 부분집합 wellformed" 회귀가드.

배경(doc `duplicate-registry-census-20260728` #9·#10, 원 판정 철회됨): "4곳이 같은 목록이라
일치해야 한다"는 틀린 전제였다 — `_SETTINGS_CONSUMING_SERVICES`·`_SERVICE_DRY_RUN_MAP`·
`_WEB_CODE_SERVICES`는 각자 다른 목적의 **의도적 부분집합**이다. 진짜 구멍은 그 부분집합들이
마스터(`_SERVICE_SCRIPT_MAP`)의 실제 부분집합인지 재는 자가 0건이었다는 것.

gcloud 라이브 접근 없이(순수 정적 로직) 실행 가능 — live_services 루프 밖에서 계산된다.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load_check_env_drift():
    spec = importlib.util.spec_from_file_location(
        "check_env_drift", _INFRA_DIR / "check_env_drift.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── AC1: 마스터 확定 ────────────────────────────────────────────────────────────

def test_service_script_map_is_declared_master_of_seven():
    """`_SERVICE_SCRIPT_MAP`이 7개 실서비스를 담은 마스터다 — 이 카운트가 바뀌면(신규 서비스
    추가/삭제) 알아야 하므로 명시 고정."""
    mod = _load_check_env_drift()
    assert set(mod._SERVICE_SCRIPT_MAP) == {
        "sprintable-backend-dev", "sprintable-backend-prod",
        "sprintable-frontend-dev", "sprintable-frontend-prod",
        "sprintable-mcp-dev", "sprintable-mcp-prod",
        "sprintable-realtime-dev",
    }


def test_realtime_prod_is_not_a_real_service_yet():
    """AC1 근거 — "sprintable-realtime-prod"는 cloudbuild.yaml에 주석으로만 존재하고 마스터엔
    없다(deploy-realtime 스텝이 prod에서 아직 스킵 중). 마스터에 없는 것이 맞다."""
    mod = _load_check_env_drift()
    assert "sprintable-realtime-prod" not in mod._SERVICE_SCRIPT_MAP


# ── AC2: 부분집합 wellformed(한 방향만) ─────────────────────────────────────────

def test_repo_current_subsets_are_wellformed():
    """리포에 실제로 커밋된 세 부분집합 전부 마스터의 진짜 부분집합이다 — 지금 위반 0건."""
    mod = _load_check_env_drift()
    assert mod._service_subset_wellformed_violations() == []


def test_subset_check_is_one_directional_master_superset_is_fine():
    """⛔양방향(집합 동일)으로 재면 안 된다 — 마스터가 부분집합보다 «큰» 것(예: mcp-dev/prod가
    세 부분집합 어디에도 없는 것)은 정상이라 잡지 않는다."""
    mod = _load_check_env_drift()
    for name in ("sprintable-mcp-dev", "sprintable-mcp-prod"):
        assert name in mod._SERVICE_SCRIPT_MAP
        assert name not in mod._SETTINGS_CONSUMING_SERVICES
        assert name not in mod._SERVICE_DRY_RUN_MAP
        assert name not in mod._WEB_CODE_SERVICES
    # 위 비대칭이 있어도 wellformed 위반은 0건이어야 한다(마스터 초과분은 허용).
    assert mod._service_subset_wellformed_violations() == []


# ── AC4: 양성대조 — 뮤테이션으로 방법이 실제로 잡는지 증명 ──────────────────────────

def test_positive_control_ghost_in_settings_consuming_is_caught(monkeypatch):
    mod = _load_check_env_drift()
    monkeypatch.setattr(
        mod, "_SETTINGS_CONSUMING_SERVICES",
        mod._SETTINGS_CONSUMING_SERVICES | {"sprintable-backend-typo-xyz"},
    )
    violations = mod._service_subset_wellformed_violations()
    assert any("sprintable-backend-typo-xyz" in v for v in violations)
    assert any("_SETTINGS_CONSUMING_SERVICES" in v for v in violations)


def test_positive_control_ghost_in_dry_run_map_is_caught(monkeypatch):
    mod = _load_check_env_drift()
    monkeypatch.setattr(
        mod, "_SERVICE_DRY_RUN_MAP",
        {**mod._SERVICE_DRY_RUN_MAP, "sprintable-frontend-typo-xyz": ("x.sh", "dev")},
    )
    violations = mod._service_subset_wellformed_violations()
    assert any("sprintable-frontend-typo-xyz" in v for v in violations)


def test_positive_control_ghost_in_web_code_services_is_caught(monkeypatch):
    mod = _load_check_env_drift()
    monkeypatch.setattr(
        mod, "_WEB_CODE_SERVICES", mod._WEB_CODE_SERVICES | {"sprintable-web-typo-xyz"},
    )
    violations = mod._service_subset_wellformed_violations()
    assert any("sprintable-web-typo-xyz" in v for v in violations)


# ── AC3+AC4: 외부 IaC 대조 + 주석-오탐 방지 ──────────────────────────────────────

def test_external_iac_literals_match_master_exactly_today():
    """cloudbuild.yaml·.github/workflows/*.yml·deploy_*.sh에 실선언된 서비스명 전량이 오늘
    정확히 마스터 7개와 같다(realtime-prod는 주석에만 있으므로 여기 안 잡혀야 한다)."""
    mod = _load_check_env_drift()
    external = mod._external_iac_service_literals()
    assert external == set(mod._SERVICE_SCRIPT_MAP)
    assert "sprintable-realtime-prod" not in external


def test_comment_only_service_name_is_not_a_real_declaration():
    """⛔grep이 주석 문장을 실선언으로 오탐하던 병(#10 census 항목 원인)을 정확히 재현해
    막는지 확認 — 주석 줄만 있는 파일에서 이름을 «안» 뽑아야 한다."""
    mod = _load_check_env_drift()
    comment_only = "# sprintable-ghost-dev가 아직 없다(계획 단계, PO 검증 전)\n"
    assert mod._SERVICE_NAME_RE.findall(mod._strip_comment(comment_only)) == []
    # 대조: 같은 텍스트에서 주석을 안 벗기면 오탐한다는 것도 같이 보인다(양성대조).
    assert mod._SERVICE_NAME_RE.findall(comment_only) == ["sprintable-ghost-dev"]


def test_external_iac_wellformed_positive_control(tmp_path, monkeypatch):
    """실제 리포 파일 대신 임시 디렉터리에 유령 서비스명을 심어 위반이 잡히는지 증명 —
    리포 원본은 건드리지 않는다."""
    mod = _load_check_env_drift()
    fake_root = tmp_path
    (fake_root / ".github" / "workflows").mkdir(parents=True)
    (fake_root / "backend" / "scripts").mkdir(parents=True)
    (fake_root / "cloudbuild.yaml").write_text(
        "steps:\n  - name: sprintable-backend-dev\n  - name: sprintable-typo-prod\n"
    )
    monkeypatch.setattr(mod, "_REPO_ROOT", fake_root)
    external = mod._external_iac_service_literals()
    assert external == {"sprintable-backend-dev", "sprintable-typo-prod"}
    violations = mod._external_iac_wellformed_violations()
    assert any("sprintable-typo-prod" in v for v in violations)


# ── AC5: 재료를 못 찾으면 실패(skip 금지) ───────────────────────────────────────

def test_external_iac_scan_raises_when_target_file_missing(tmp_path, monkeypatch):
    """대상 파일(cloudbuild.yaml 등)이 없으면 조용히 빈 집합을 돌려주지 않고 즉시 실패한다."""
    mod = _load_check_env_drift()
    empty_root = tmp_path  # cloudbuild.yaml도 workflows/도 scripts/도 없는 빈 디렉터리
    monkeypatch.setattr(mod, "_REPO_ROOT", empty_root)
    import pytest

    with pytest.raises(RuntimeError, match="스캔 대상 파일을 못 찾음"):
        mod._external_iac_service_literals()


def test_find_repo_root_raises_without_git_marker(tmp_path):
    """`_find_repo_root`가 `.git` 표식 없는 경로에서 조용히 엉뚱한 조상 디렉터리를 반환하지
    않고 실패하는지 — '../' 개수 세기 방식이 아니라 표식 탐색 방식임을 직접 증명."""
    mod = _load_check_env_drift()
    import pytest

    isolated = tmp_path / "no" / "git" / "here"
    isolated.mkdir(parents=True)
    with pytest.raises(RuntimeError, match="repo root"):
        mod._find_repo_root(isolated)


def test_find_repo_root_finds_actual_repo_root():
    mod = _load_check_env_drift()
    root = mod._find_repo_root(_INFRA_DIR)
    assert (root / ".git").exists()
    assert (root / "cloudbuild.yaml").exists()

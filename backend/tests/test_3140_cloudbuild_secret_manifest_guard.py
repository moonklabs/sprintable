"""story #3140(카디르 QA #3547 발견) — cloudbuild 시크릿 배선 가드(기존 132건+AST 5종, 구조만
검사)에 «GCP 실물 시크릿명 존재 대조» 축이 없어 이름 오탈자 뮤테이션이 전부 통과하던 갭.

2층 설계(PO 페드루 확定, 2026-08-27):
① PR 게이트(무-GCP 인증) — cloudbuild 참조 시크릿명 ↔ infra/cloudbuild-secret-manifest.txt
   목록 diff(이 파일이 그 축).
② 스케줄 워크플로우(GCP WIF, env-drift-guard.yml 선례 복제) — manifest ↔ GCP 실물 대조,
   manifest 부패 방지(별도 워크플로우+sync_cloudbuild_secret_manifest.py).

AC2(양성대조) — 오탈자 뮤테이션 주입 시 ①이 실제로 red가 되는지가 이 스위트의 핵심 표본."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "infra"))

import check_cloudbuild_secret_manifest as pr_gate  # noqa: E402
import cloudbuild_secret_refs as refs_mod  # noqa: E402
import sync_cloudbuild_secret_manifest as sync_gate  # noqa: E402
from cloudbuild_secret_refs import SecretRefs, extract_all_secret_refs  # noqa: E402


# ── extract_cloudbuild_inline_refs — ①+③(정규식+변수해석) ──────────────────────

def test_extract_inline_literal_secret_binding():
    text = 'gcloud run services update x --update-secrets="DATABASE_URL=DATABASE_URL_DEV:latest"'
    resolved, unresolved = refs_mod.extract_cloudbuild_inline_refs(text)
    assert resolved == {"DATABASE_URL_DEV"}
    assert unresolved == set()


def test_extract_inline_multiple_bindings_comma_separated():
    text = (
        'SECRETS_FLAG="--update-secrets=DATABASE_URL=DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE:latest,'
        'DATABASE_URL_DIRECT=DATABASE_URL_DIRECT_DEV_SPRINTABLE:latest"'
    )
    resolved, unresolved = refs_mod.extract_cloudbuild_inline_refs(text)
    assert resolved == {"DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE", "DATABASE_URL_DIRECT_DEV_SPRINTABLE"}
    assert unresolved == set()


def test_extract_inline_resolves_dollar_variable_reference():
    """③ — `$${VAR}` 간접 참조는 같은 텍스트 안의 `VAR="LITERAL"` 대입을 찾아 해석한다
    (AGENT_KEY_SECRET류 실 패턴)."""
    text = (
        'if [ "$ENV" == "prod" ]; then\n'
        '  AGENT_KEY_SECRET="MCP_AGENT_API_KEY_PROD"\n'
        'else\n'
        '  AGENT_KEY_SECRET="MCP_AGENT_API_KEY_DEV"\n'
        'fi\n'
        '--update-secrets="AGENT_API_KEY=$${AGENT_KEY_SECRET}:latest"\n'
    )
    resolved, unresolved = refs_mod.extract_cloudbuild_inline_refs(text)
    # 조건 분기 두 갈래 다 채택(정적 분석이라 실행 경로를 못 가르므로 둘 다 안전측으로 수집).
    assert resolved == {"MCP_AGENT_API_KEY_DEV", "MCP_AGENT_API_KEY_PROD"}
    assert unresolved == set()
    # 변수명 자체("AGENT_KEY_SECRET")가 실 시크릿명으로 오채택되지 않아야 한다(회귀 가드 —
    # #3140 구현 중 실제로 걸렸던 버그: $ 접두 신호를 안 보면 변수명을 리터럴로 착각한다).
    assert "AGENT_KEY_SECRET" not in resolved


def test_extract_inline_unresolvable_variable_surfaces_not_silently_dropped():
    """no-fiction — 대입을 못 찾으면 unresolved로 명시 반환(가드가 못 잡는 자리를 조용히
    통과시키지 않는다)."""
    text = '--update-secrets="SOME_KEY=$${UNKNOWN_VAR}:latest"'
    resolved, unresolved = refs_mod.extract_cloudbuild_inline_refs(text)
    assert resolved == set()
    assert unresolved == {"UNKNOWN_VAR"}


def test_extract_inline_literal_kebab_case_secret_name():
    """PO 페드루 리뷰 지적(PR #3549) 회귀가드 — GCP 시크릿명은 대문자 SNAKE_CASE만이 아니다
    (manifest 실물의 `cron-secret`·`github-app-webhook-secret-dev` 등 kebab-case 10건). 예전
    문자군(`[A-Z][A-Z0-9_]*`)은 이런 이름을 resolved도 unresolved도 아닌 완전 침묵으로 흘렸다
    — 대문자 전용 fullmatch 판정을 걷어내고 `$` 접두 유무로만 가르게 고친 뒤의 회귀가드."""
    text = 'gcloud run services update x --update-secrets="WEBHOOK=github-app-webhook-secret-dev:latest"'
    resolved, unresolved = refs_mod.extract_cloudbuild_inline_refs(text)
    assert resolved == {"github-app-webhook-secret-dev"}
    assert unresolved == set()


def test_extract_inline_ignores_non_secret_context():
    """`:latest`/`:버전`이 안 붙은 일반 KEY=VALUE는 시크릿 바인딩이 아니므로 무시."""
    text = "APP_URL=https://dev-app.sprintable.ai\nNODE_ENV=production"
    resolved, unresolved = refs_mod.extract_cloudbuild_inline_refs(text)
    assert resolved == set()
    assert unresolved == set()


# ── extract_all_secret_refs — 실 레포 대조(회귀 가드) ────────────────────────────

def test_real_repo_all_refs_are_currently_covered_by_manifest():
    """실 레포 상태 핀 — cloudbuild.yaml+backend/scripts/*.sh가 참조하는 시크릿명 전부가
    지금 시점 manifest 안에 있다(둘 다 실물이라 이 테스트가 곧 «현재 드리프트 0» 증거).
    manifest 밖 이름이 새로 생기면(오탈자든 신규든) 이 테스트가 먼저 알려준다."""
    result = extract_all_secret_refs()
    manifest = pr_gate.load_manifest()
    missing = result.resolved - manifest
    assert not missing, f"실 레포 참조명이 manifest 밖에 있음(갱신 필요): {sorted(missing)}"


def test_real_repo_extraction_finds_known_secrets_not_a_silent_zero():
    """가드가 "아무것도 못 찾아서" 우연히 그린인 게 아님을 고정 — 알려진 실제 참조 몇 개가
    반드시 잡혀야 한다(추출기 자체가 깨지면 이 테스트가 먼저 빨개진다)."""
    result = extract_all_secret_refs()
    assert {"DATABASE_URL_DEV", "JWT_SECRET", "ALEMBIC_DATABASE_URL_DEV"} <= result.resolved


# ── check_cloudbuild_secret_manifest.check() — ① PR 게이트, AC2 양성대조 ────────

def test_pr_gate_passes_when_all_refs_in_manifest(monkeypatch):
    monkeypatch.setattr(
        pr_gate, "extract_all_secret_refs",
        lambda: SecretRefs(resolved={"DATABASE_URL_DEV", "JWT_SECRET"}),
    )
    ok, lines = pr_gate.check(manifest={"DATABASE_URL_DEV", "JWT_SECRET", "OTHER_UNRELATED"})
    assert ok is True
    # 정상 케이스라도 "선언된 미커버" 안내는 항상 붙는다(story #3140 후속) — missing/unresolved
    # 관련 라인만 없는지를 본다(전체 lines가 비어야 한다는 옛 단언은 그 안내 추가로 더 이상
    # 성립하지 않음).
    assert not any("manifest에 없는" in line for line in lines)


def test_pr_gate_ac2_positive_control_typo_mutation_goes_red(monkeypatch):
    """AC2 핵심 표본 — 시크릿명에 오탈자를 주입한 뮤테이션을 재현하면 가드가 실제로 red가
    되는지(«틀릴 수 있는 표본으로» — 카디르 QA #3547이 발견한 정확히 그 결함 클래스의 재발
    방지 실증)."""
    typo_name = "DATABASE_URL_DEV_TYP0"  # 실제 manifest엔 이 이름이 없다(고의 오탈자).
    monkeypatch.setattr(
        pr_gate, "extract_all_secret_refs",
        lambda: SecretRefs(resolved={typo_name, "JWT_SECRET"}),
    )
    ok, lines = pr_gate.check(manifest={"DATABASE_URL_DEV", "JWT_SECRET"})
    assert ok is False, "오탈자 시크릿명이 manifest에 없는데도 가드가 green — AC2 위반"
    assert any(typo_name in line for line in lines)


def test_pr_gate_ac2_typo_against_real_repo_manifest_end_to_end(monkeypatch):
    """AC2 — mock 없이 실 manifest 파일을 대상으로 같은 뮤테이션 재현(진짜 카디르 시나리오와
    가장 가까운 형태: manifest는 실물, 참조 집합만 오염시킨다)."""
    typo_name = "DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE_TYPO"
    monkeypatch.setattr(
        pr_gate, "extract_all_secret_refs", lambda: SecretRefs(resolved={typo_name}),
    )
    ok, lines = pr_gate.check()  # manifest 인자 생략 → 실 파일(load_manifest()) 사용.
    assert ok is False
    assert any(typo_name in line for line in lines)


def test_pr_gate_reports_unresolved_tokens_without_failing_alone():
    """unresolved는 그 자체로 fail을 만들진 않되(정적 분석 한계·오탐 방지), 반드시 stdout에
    드러난다 — «가드가 못 잡는 것 선언»의 실제 구현."""
    stub_refs = SecretRefs(resolved={"JWT_SECRET"}, unresolved={"DYNAMIC_TOKEN"})
    with patch.object(pr_gate, "extract_all_secret_refs", return_value=stub_refs):
        ok, lines = pr_gate.check(manifest={"JWT_SECRET"})
    assert ok is True  # unresolved만으론 fail 아님.
    assert any("DYNAMIC_TOKEN" in line for line in lines)


def test_declared_uncovered_scripts_empty_after_3145_promotion():
    """story #9d1fde0c(3549 QA 후속) — deploy_realtime_gce.sh가 «선언»에서 «실 파서 커버리지»로
    승격됐으므로(AC4) 이 선언 사전은 이제 비어야 한다. 다시 채워지면(새 미커버 스크립트
    발생) 그건 정당한 회귀가 아니라 이 테스트가 먼저 알려줘야 할 신규 사실이다."""
    assert refs_mod._DECLARED_UNCOVERED_SCRIPTS == {}


def test_pr_gate_output_no_longer_carries_uncovered_note():
    """위 승격의 관측면 — check() 출력에 더는 "정적으로 못 보는 시크릿 소스" 안내가
    안 붙는다(선언이 비었으니 그 섹션 자체가 생성 안 됨, check()의 `if _DECLARED_
    UNCOVERED_SCRIPTS:` 가드 참조)."""
    ok, lines = pr_gate.check()
    assert ok is True
    assert not any("정적으로 못 보는 시크릿 소스" in line for line in lines)


# ── extract_realtime_gce_secret_refs — ④(story #9d1fde0c, base64 fetch-secrets 파서) ──

def test_realtime_gce_decode_extracts_secret_names_array():
    """단위 — 디코드된 fetch-secrets 블록에서 `_secret_names=(...)` 배열 리터럴만 뽑고
    `__AR_TOKEN__`(Secret Manager 시크릿이 아닌 access-token sentinel)은 제외한다."""
    decoded = (
        "cat > /tmp/fetch-secrets.sh <<'EOF'\n...\nEOF\n"
        "_secret_names=( 'cron-secret' 'JWT_SECRET' '__AR_TOKEN__' )\n"
        "_secret_env_names=( 'CRON_SECRET' 'JWT_SECRET' '_AR_TOKEN' )\n"
    )
    assert refs_mod._extract_secret_names_from_fetch_block(decoded) == {"cron-secret", "JWT_SECRET"}


def test_realtime_gce_decode_no_array_returns_empty_not_crash():
    """배열 리터럴이 없는 텍스트를 줘도(형식 변경 등) crash 대신 빈 집합(정직한 미가용)."""
    assert refs_mod._extract_secret_names_from_fetch_block("no array here") == set()


def test_real_repo_extract_realtime_gce_finds_dev_and_prod_kebab_secrets():
    """실 레포 대조 — deploy_realtime_gce.sh(dev+prod) DRY_RUN을 실제로 돌려 kebab-case
    시크릿(github-app-* 3종·cron-secret)이 실제로 잡히는지(추출기 자체가 깨지면 여기서
    먼저 빨개진다 — 우연한 그린 방지)."""
    result = refs_mod.extract_realtime_gce_secret_refs()
    assert {
        "cron-secret", "github-app-client-secret-dev", "github-app-private-key-dev",
        "github-app-state-secret-dev", "CRON_SECRET_PROD", "github-app-client-secret-prod",
    } <= result
    assert "__AR_TOKEN__" not in result


def test_real_repo_realtime_gce_refs_included_in_extract_all():
    """④가 실제로 ①②③과 합류하는지 — extract_all_secret_refs()의 resolved 집합에 이
    소스만의 고유 이름(다른 배포 스크립트엔 안 나오는 kebab 시크릿)이 포함돼야 한다."""
    result = extract_all_secret_refs()
    assert "github-app-private-key-dev" in result.resolved


def test_realtime_gce_typo_mutation_goes_red_positive_control():
    """AC3(양성대조) — deploy_realtime_gce.sh가 참조하는 시크릿명에 오탈자가 나면(manifest
    엔 없는 이름) PR 게이트가 실제로 red가 되는지. `extract_all_secret_refs`를 몽키패치해
    실제 gcloud/스크립트 재실행 없이 게이트 로직만 겨눈다(check() 자체는 순수 로직)."""
    typo_refs = SecretRefs(resolved={"cron-secre-TYPO"}, unresolved=set())
    with patch.object(pr_gate, "extract_all_secret_refs", return_value=typo_refs):
        ok, lines = pr_gate.check()
    assert ok is False
    assert any("cron-secre-TYPO" in line for line in lines)


def test_declared_uncovered_scripts_constant_names_a_real_script_path():
    """선언이 가리키는 스크립트가 실제로 레포에 존재하는지 — 이름만 적어두고 스크립트
    자체가 리네임/삭제돼도 아무도 모르는 걸 방지(선언 자체의 부패 방지, sync_* 스크립트가
    manifest 부패를 잡는 것과 같은 원칙)."""
    for script_name in refs_mod._DECLARED_UNCOVERED_SCRIPTS:
        assert (refs_mod._SCRIPTS_DIR / script_name).exists(), (
            f"{script_name}이 backend/scripts/에 없음 — 선언이 낡았을 가능성"
        )


def test_manifest_file_is_wellformed_no_duplicates_sorted_content():
    lines = [
        ln.strip() for ln in pr_gate._MANIFEST_PATH.read_text().splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    assert len(lines) == len(set(lines)), "manifest에 중복 이름 존재"
    assert lines, "manifest가 비어있음"


# ── sync_cloudbuild_secret_manifest.check() — ② 스케줄 축(gcloud mock, 유닛) ─────

def test_sync_ok_when_manifest_matches_live():
    ok, lines = sync_gate.check(manifest={"A", "B"}, live={"A", "B"})
    assert ok is True
    assert lines == []


def test_sync_detects_secret_deleted_from_gcp_but_still_in_manifest():
    """위험 축 — manifest가 이미 죽은 시크릿명을 여전히 "존재"로 승인 중이면 PR 게이트가
    거짓 안전을 낸다는 걸 이 테스트가 고정."""
    ok, lines = sync_gate.check(manifest={"A", "GHOST_SECRET"}, live={"A"})
    assert ok is False
    assert any("GHOST_SECRET" in line for line in lines)


def test_sync_detects_new_gcp_secret_not_yet_in_manifest():
    ok, lines = sync_gate.check(manifest={"A"}, live={"A", "BRAND_NEW_SECRET"})
    assert ok is False
    assert any("BRAND_NEW_SECRET" in line for line in lines)


def test_sync_against_real_manifest_and_real_gcp_if_available():
    """실물 왕복(로컬 gcloud 인증 있을 때만 의미 — CI에선 스케줄 워크플로우가 WIF로 돈다).
    gcloud 미인증/미설치 환경에서는 스킵(재고 없이 지어내지 않음)."""
    import subprocess
    try:
        live = sync_gate._live_gcp_secret_names()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        import pytest
        pytest.skip("로컬 gcloud 인증/설치 없음 — 스케줄 워크플로우(WIF)가 이 축을 담당")
        return
    manifest = pr_gate.load_manifest()
    ok, lines = sync_gate.check(manifest, live)
    assert ok, f"manifest가 GCP 실물과 어긋남(정기 갱신 필요) — {lines}"

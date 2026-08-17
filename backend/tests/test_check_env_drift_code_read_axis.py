"""story #2296 축⑤ "코드가 읽는데 아무도 안 주는 값" — infra/check_env_drift.py 신규 축 회귀가드.

2026-07-28 prod 앱 로그인 장애 그대로 재현·고정한다: `MOBILE_APP_LINK_ORIGIN`(기본값이
dev-app.sprintable.ai — ㉡최고위험)·`FIREBASE_BFF_INTERNAL_SECRET`(기본값 없음 — ㉠높음) 둘
다 IaC(deploy_frontend.sh)에도 라이브(frontend-prod)에도 없었다. gcloud 라이브 접근 없이
(정적 스캔·allowlist 파싱은 순수 로컬 로직) 실행 가능한 부분만 고정한다.
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


# ── AC3 — 위험 등급이 실제로 갈린다 ────────────────────────────────────────────

def test_classify_dev_default_is_highest():
    mod = _load_check_env_drift()
    assert mod._classify_code_read_risk(["https://dev-app.sprintable.ai"]) == "highest"


def test_classify_localhost_and_test_defaults_are_also_highest():
    mod = _load_check_env_drift()
    assert mod._classify_code_read_risk(["http://localhost:8000"]) == "highest"
    assert mod._classify_code_read_risk(["test-mode"]) == "highest"


def test_classify_no_default_is_high_not_highest():
    """FIREBASE_BFF_INTERNAL_SECRET의 실제 모양 — 기본값 자체가 없다. dev 가리키는 것보다는
    한 등급 낮다(㉠) — 즉시 undefined로 드러나 쪽이 조용한 오지정보다 상대적으로 덜 insidious."""
    mod = _load_check_env_drift()
    assert mod._classify_code_read_risk([None]) == "high"


def test_classify_env_agnostic_default_is_low():
    mod = _load_check_env_drift()
    assert mod._classify_code_read_risk(["us-east-1"]) == "low"
    assert mod._classify_code_read_risk([".storage"]) == "low"


def test_three_tiers_are_actually_different_not_one_bucket():
    """AC3 본체 — 세 등급이 «다른 값»으로 나와야 한다(하나로 뭉치면 등급이 아니다)."""
    mod = _load_check_env_drift()
    tiers = {
        mod._classify_code_read_risk(["https://dev-app.sprintable.ai"]),
        mod._classify_code_read_risk([None]),
        mod._classify_code_read_risk(["us-east-1"]),
    }
    assert tiers == {"highest", "high", "low"}


# ── 추출 — 소스 리터럴만 읽는다(라이브 값 없이도 동작) ──────────────────────────

def test_web_env_reads_finds_the_real_incident_file(tmp_path):
    mod = _load_check_env_drift()
    src = tmp_path / "route.ts"
    src.write_text(
        "const A = () => process.env['MOBILE_APP_LINK_ORIGIN'] ?? 'https://dev-app.sprintable.ai';\n"
        "const B = () => process.env['FIREBASE_BFF_INTERNAL_SECRET'];\n"
    )
    reads = mod._web_env_reads(tmp_path)
    assert reads["MOBILE_APP_LINK_ORIGIN"][0][1] == "https://dev-app.sprintable.ai"
    assert reads["FIREBASE_BFF_INTERNAL_SECRET"][0][1] is None


def test_web_env_reads_ignores_test_files(tmp_path):
    mod = _load_check_env_drift()
    (tmp_path / "route.test.ts").write_text("process.env['SOME_TEST_ONLY_KEY'] = 'x';\n")
    reads = mod._web_env_reads(tmp_path)
    assert "SOME_TEST_ONLY_KEY" not in reads


# ── ⑤ 후속(2026-07-31) — `env: NodeJS.ProcessEnv = process.env` DI 관례 블라인드스팟 ──

def test_web_env_reads_catches_di_pattern_when_declared(tmp_path):
    """process.env를 파라미터(관례 이름 `env`)로 받는 함수 안의 `env['X']`도 이 DI 선언이
    실제로 있는 파일이면 process.env['X']와 같은 자리로 잡혀야 한다 —
    SPRINTABLE_RUNTIME_ROLE이 정확히 이 모양으로 못 잡히고 있었다."""
    mod = _load_check_env_drift()
    src = tmp_path / "background-runtime.ts"
    src.write_text(
        "export function resolveRole(env: NodeJS.ProcessEnv = process.env) {\n"
        "  const rawRole = env['SPRINTABLE_RUNTIME_ROLE'];\n"
        "  return rawRole;\n"
        "}\n"
    )
    reads = mod._web_env_reads(tmp_path)
    assert "SPRINTABLE_RUNTIME_ROLE" in reads
    assert reads["SPRINTABLE_RUNTIME_ROLE"][0][1] is None  # 기본값 없음(㉠high)


def test_web_env_reads_ignores_env_bracket_without_di_declaration(tmp_path):
    """DI 선언(`env: NodeJS.ProcessEnv = process.env`)이 «없는» 파일에서 우연히 `env`라는
    이름의 변수를 쓰면(env var와 무관한 지역변수) 잡지 않는다 — 오탐 방지가 이 스캔 확장의
    전제 조건이다."""
    mod = _load_check_env_drift()
    src = tmp_path / "unrelated.ts"
    src.write_text(
        "function pick(env: Record<string, string>) {\n"
        "  return env['SOME_UNRELATED_KEY'];\n"
        "}\n"
    )
    reads = mod._web_env_reads(tmp_path)
    assert "SOME_UNRELATED_KEY" not in reads


def test_ac_sprintable_runtime_role_reproduces_via_real_repo_scan():
    """실제 리포 소스(apps/web/src/services/background-runtime.ts)를 그대로 스캔 —
    SPRINTABLE_RUNTIME_ROLE이 IaC 어디에도 없는 실제 상태에서 high로 잡혀야 한다(라이브
    실측 2026-07-31: sprintable-frontend-{dev,prod} 둘 다 이 키가 없음 — gcloud로 직접 확認)."""
    mod = _load_check_env_drift()
    reads = mod._web_env_reads()  # 실제 apps/web/src 스캔
    assert "SPRINTABLE_RUNTIME_ROLE" in reads

    covered = mod._iac_covered_keys_for_service("sprintable-frontend-prod")
    assert "SPRINTABLE_RUNTIME_ROLE" not in covered  # IaC 스크립트 전수에도 없음(실측)

    highest, high, low = mod._unsupplied_code_read_findings(reads, covered, set())
    high_keys = {k for k, _ in high}
    assert "SPRINTABLE_RUNTIME_ROLE" in high_keys  # 기본값 없음(dev/localhost 문자열 아님) → high, highest 아님


def test_web_env_reads_never_touches_live_values():
    """AC5 — 이 함수의 시그니처 자체가 소스 Path만 받는다(라이브 env 접근 불가능한 구조).
    함수가 아예 gcloud를 부를 방법이 없다는 것을 소스 검사로 고정."""
    import inspect
    mod = _load_check_env_drift()
    src = inspect.getsource(mod._web_env_reads)
    assert "gcloud" not in src and "_live_env_entries" not in src


# ── AC1 — 오늘의 두 건이 실제로 잡힌다(fixture 재현, 라이브 값은 지금 채워져 있으므로) ──

# AC7에서 이 두 키를 deploy_frontend.sh에 실제로 추가한다 — 그러면 실시간
# `_iac_covered_keys_for_service()`는 "이미 고쳐진" 상태를 돌려주게 된다. AC1은 "사고 당시"를
# 재현하는 것이 목적이라 그 두 키만 빼서 사고 시점 상태를 흉내낸다(그 외 실제 IaC 상태는
# 그대로 써서 NEXT_PUBLIC_FASTAPI_URL 같은 무관한 키가 findings에 섞이지 않게 한다).
_INCIDENT_KEYS = {"MOBILE_APP_LINK_ORIGIN", "FIREBASE_BFF_INTERNAL_SECRET"}

# ⑤ 후속(2026-07-31) — DI 패턴 확장으로 새로 잡히기 시작한 실제 미커버 값들. 이 아래
# 포지티브컨트롤 테스트는 "그 두 사고 키가 커버되면 나머지는 실제로 이미 깨끗하다"는 원래
# 시나리오를 재는 것이라 이 신규 발견들과는 별개 관심사(별도로
# test_ac_sprintable_runtime_role_reproduces_via_real_repo_scan이 이걸 전담해서 잡는다) —
# 그래서 여기서만 빼고, baseline에는 안 넣는다(SPRINTABLE_RUNTIME_ROLE은 PO 판단 대기 신규
# 실사고 후보라 스스로 조용히 얼리지 않는다).
_DI_FOLLOWUP_KEYS = {
    "SPRINTABLE_RUNTIME_ROLE",
    "SPRINTABLE_BACKGROUND_POLL_INTERVAL_MS",
    "SPRINTABLE_MEMO_DISPATCHER_POLL_INTERVAL_MS",
    "SPRINTABLE_DISCORD_OUTBOUND_POLL_INTERVAL_MS",
    "SPRINTABLE_TEAMS_OUTBOUND_POLL_INTERVAL_MS",
}


def test_ac1_mobile_app_link_origin_reproduces_as_highest_fail():
    """실제 리포 소스(오늘 그 파일)를 그대로 스캔 + 실제 per-service IaC 커버리지에서 사고
    당시 상태(그 두 키만 없음)를 흉내 — highest 등급으로 잡혀야 한다."""
    mod = _load_check_env_drift()
    reads = mod._web_env_reads()  # 실제 apps/web/src 스캔 — MOBILE_APP_LINK_ORIGIN 실존 확認
    assert "MOBILE_APP_LINK_ORIGIN" in reads

    covered = mod._iac_covered_keys_for_service("sprintable-frontend-prod") - _INCIDENT_KEYS
    highest, high, low = mod._unsupplied_code_read_findings(reads, covered, set())
    assert any("MOBILE_APP_LINK_ORIGIN" in line for line in highest), (
        f"highest에 MOBILE_APP_LINK_ORIGIN이 없음 — {highest}"
    )


def test_ac1_firebase_bff_internal_secret_reproduces_as_high():
    mod = _load_check_env_drift()
    reads = mod._web_env_reads()
    assert "FIREBASE_BFF_INTERNAL_SECRET" in reads

    covered = mod._iac_covered_keys_for_service("sprintable-frontend-prod") - _INCIDENT_KEYS
    highest, high, low = mod._unsupplied_code_read_findings(reads, covered, set())
    assert any("FIREBASE_BFF_INTERNAL_SECRET" in line for line in high), (
        f"high에 FIREBASE_BFF_INTERNAL_SECRET이 없음 — {high}"
    )


def test_ac1_full_main_reproduces_frontend_prod_incident_and_fails(monkeypatch, capsys):
    """⭐AC1 본체 — main()을 통째로 돌려 「가드가 빨개지는 것」을 실제로 본다.
    frontend-prod 라이브를 사고 당시 그대로(두 키 다 없음) fixture로 흉내낸다."""
    mod = _load_check_env_drift()

    monkeypatch.setattr(mod, "_list_live_services", lambda: ["sprintable-frontend-prod"])
    monkeypatch.setattr(
        mod, "_live_env_entries",
        lambda service: [{"name": "OTHER_UNRELATED_KEY", "value": "x"}],  # 그 둘은 없음
    )
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    monkeypatch.setattr(mod, "_load_code_read_exempt", lambda: set())
    monkeypatch.setattr(mod, "_iac_covered_keys_for_service", lambda service: set())
    monkeypatch.setattr(mod, "_iac_covered_keys", lambda: set())
    # ①②③④축은 이 서비스가 그 매핑들 밖이라 자연히 skip — ⑤만 단독으로 신호를 낸다.

    exit_code = mod.main()

    assert exit_code == 1, "MOBILE_APP_LINK_ORIGIN(highest)이 잡혔어야 하는데 통과함"
    out = capsys.readouterr().out
    assert "⑤㉡" in out and "MOBILE_APP_LINK_ORIGIN" in out
    assert "sprintable-frontend-prod" in out


# ── AC2 — 양성대조: 정상 상태에서는 안 걸린다 ──────────────────────────────────

def test_ac2_positive_control_both_keys_covered_does_not_fire():
    """지금(고쳐진 뒤) 상태를 흉내 — 두 키가 covered_keys에 있으면 findings에 안 나와야
    한다. 둘 다 걸리면 판별력 0(뭘 넣어도 FAIL)이라 이 테스트가 그 축퇴를 막는다."""
    mod = _load_check_env_drift()
    reads = mod._web_env_reads()
    covered_after_fix = {"MOBILE_APP_LINK_ORIGIN", "FIREBASE_BFF_INTERNAL_SECRET"}
    highest, high, low = mod._unsupplied_code_read_findings(reads, covered_after_fix, set())
    assert not any("MOBILE_APP_LINK_ORIGIN" in line for line in highest)
    assert not any("FIREBASE_BFF_INTERNAL_SECRET" in line for line in high)


def test_ac2_positive_control_full_main_passes_when_covered(monkeypatch, capsys):
    """⛔`_iac_covered_keys_for_service`는 모킹하지 않는다 — 진짜 IaC(현재 리포)를 그대로
    쓰고, 사고의 그 두 키만 라이브로 "공급된 것처럼" fixture로 얹는다. 나머지 실제 코드베이스
    findings(highest 대상인 NEXT_PUBLIC_FASTAPI_URL 등)는 실제 IaC가 이미 커버하고 있어
    자연히 안 걸린다 — 그게 이 테스트가 «진짜 양성대조»인 이유(인위적으로 다 가려서 초록을
    만든 게 아니다)."""
    mod = _load_check_env_drift()
    monkeypatch.setattr(mod, "_list_live_services", lambda: ["sprintable-frontend-prod"])
    monkeypatch.setattr(
        mod, "_live_env_entries",
        lambda service: [
            {"name": "MOBILE_APP_LINK_ORIGIN", "valueFrom": {}},
            {"name": "FIREBASE_BFF_INTERNAL_SECRET", "valueFrom": {}},
        ],
    )
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    # ⑤ 후속(2026-07-31) — DI 패턴으로 새로 잡히기 시작한 키들을 이 테스트 안에서만 "이미
    # baseline 처리된 것"으로 스텁한다(실제 infra/manual-env-allowlist.yml은 안 건드린다).
    # ⛔`_live_env_entries`에 이 키들을 얹는 방식은 안 쓴다 — 그러면 ①키집합 대조(실제
    # IaC와 비교)가 "라이브엔 있는데 IaC엔 없는 새 키"로 따로 잡아 이 테스트의 관심사(사고
    # 두 키가 커버되면 나머지는 실제로 깨끗한가)와 무관한 실패가 섞인다. 이 신규 발견 자체는
    # test_ac_sprintable_runtime_role_reproduces_via_real_repo_scan이 전담해서 잡는다.
    from datetime import date, timedelta
    _until = (date.today() + timedelta(days=10)).isoformat()
    real_baseline = mod._load_code_read_high_baseline()
    monkeypatch.setattr(
        mod, "_load_code_read_high_baseline",
        lambda: {
            **real_baseline,
            **{
                k: {"key": k, "reason": "test stub — see ⑤ 후속 comment", "declared_by": "test", "until": _until}
                for k in _DI_FOLLOWUP_KEYS
            },
        },
    )

    exit_code = mod.main()
    out = capsys.readouterr().out
    assert "MOBILE_APP_LINK_ORIGIN" not in out
    assert "FIREBASE_BFF_INTERNAL_SECRET" not in out
    # ⛔"⑤㉡" 헤더 자체가 아니라 안내문(항상 찍히는 remediation guidance)에 그 글자가 섞여
    # 있을 수 있어 헤더 전체 문자열로 정밀하게 확認한다(오탐 방지 — 이 assertion 자체가
    # 처음엔 너무 넓어 자기 오탐을 냈다).
    assert "⑤㉡코드가 읽는데" not in out, f"highest 등급 FAIL 섹션이 실제로 찍힘(양성대조 오염) — {out}"
    assert exit_code == 0


# ── AC4 — 오탐 수를 세어 적는다(실 저장소 스캔) ─────────────────────────────────

def test_ac4_real_repo_scan_counts_are_recorded():
    """2026-07-28 실측(AC7 반영 前 — deploy_frontend.sh에 그 두 키를 추가하기 전 기준) —
    이 수치가 바뀌면(새 env 추가·exempt 갱신 등) 이 테스트가 알린다. exempt 18건은
    KMS/Storage/Dogfood 3개 기능-스위치 군으로 코드 확認 후 등재한 것 — 나머지는 정직히
    미triage 상태로 남긴다(라이브 접근 불가 환경이라 IaC-only 상한선 — 실제 CI는 라이브도
    더해 이보다 작거나 같은 수를 본다)."""
    mod = _load_check_env_drift()
    reads = mod._web_env_reads()
    exempt = mod._load_code_read_exempt()
    covered = mod._iac_covered_keys_for_service("sprintable-frontend-prod") - _INCIDENT_KEYS

    highest, high, low = mod._unsupplied_code_read_findings(reads, covered, exempt)
    total_reads = len(reads)
    total_findings = len(highest) + len(high) + len(low)

    print(
        f"\n[AC4] 총 고유 env 키 {total_reads}개 · exempt {len(exempt)}개 · "
        f"미커버 findings {total_findings}개(highest={len(highest)}, high={len(high)}, low={len(low)})"
    )
    # 정확한 숫자 고정(2026-07-28, 2026-07-31 ⑤ DI-패턴 후속으로 high 15→20,
    # 2026-08-02 story #2422 후속으로 high 20→15·exempt 18→23 갱신,
    # 2026-08-07 story #2510 NEXT_PUBLIC_TOSS_CLIENT_KEY 신설로 high 15→16,
    # 2026-08-17 story #2728 후속으로 NEXT_PUBLIC_EE_ENABLED를 cloudbuild.yaml/GHA에 배선
    # (dev FE billing 표면 렌더 안 되던 근본원인)해 IaC-covered로 전환·high 16→15,
    # 2026-08-18 story #e6500272 후속으로 LICENSE_CONSENT도 동형 배선(backend deploy 스텝
    # ENV_VARS)해 IaC-covered로 전환·high 15→14) — 스위트가
    # 실패하면 숫자가 바뀐 것, 원인을 봐야 한다. 이번 -5/+5는 SPRINTABLE_RUNTIME_ROLE·
    # SPRINTABLE_{BACKGROUND,MEMO_DISPATCHER,DISCORD_OUTBOUND,TEAMS_OUTBOUND}_POLL_INTERVAL_MS
    # 다섯이 high(미triage)에서 code_read_exempt(영구 정상)로 승격된 것 — env 드리프트
    # 가드가 나흘째 이 다섯을 FAIL로 잡던 것을 실측(gcloud)으로 추적한 결과, frontend-dev/
    # prod 둘 다 NODE_ENV=production이라 SPRINTABLE_RUNTIME_ROLE 미설정 시 기본값이 'web'
    # 으로 떨어져 이 값들을 쓰는 백그라운드 워커 자체가 안 켜진다(story #2423 — 이 기능군은
    # 은퇴 상태). 값을 채워야 도는 게 아니라 안 채워야 지금 의도대로 도는 스위치라
    # code_read_exempt가 정확한 분류다(baseline의 "아직 triage 안 됨"과 다르다).
    assert len(highest) == 1, highest
    assert len(high) == 14, high
    assert len(low) == 9, low
    assert len(exempt) == 23


# ── AC5 — 값을 안 읽는다 ──────────────────────────────────────────────────────

def test_ac5_findings_never_reference_live_env_values():
    """라이브 entry가 «value 필드 자체가 없어도»(name만) ⑤ 판정이 정상 동작해야 한다 —
    이 축이 구조적으로 값을 필요로 하지 않는다는 증거."""
    mod = _load_check_env_drift()
    reads = {"SOME_KEY": [("file.ts", None)]}
    # covered_keys는 이름 집합일 뿐, live entry의 "value"를 담을 여지가 없는 자료형(set[str]).
    highest, high, low = mod._unsupplied_code_read_findings(reads, {"SOME_KEY"}, set())
    assert highest == [] and high == [] and low == []


# ── ⛔AC6 — 이 축이 여전히 못 잡는 것(코드 검증 아니라 문서화·정직한 선언) ─────────
#
# 1. 런타임에 동적으로 조립된 키(`process.env[varName]`, `process.env[\`PREFIX_${x}\`]`)는
#    정적 정규식(`[A-Z][A-Z0-9_]*` 리터럴)으로 안 보인다.
# 2. `??`/`||` 폴백이 아니라 `if (!process.env.X) throw` 류 런타임 가드는 "기본값 없음"으로
#    뭉뚱그려진다 — 그 가드가 실제로 얼마나 엄격한지는 못 가른다.
# 3. NEXT_PUBLIC_* 접두 키는 Next.js가 빌드타임에 인라인할 수 있어, 그 경우 라이브 Cloud Run
#    env 유무 자체가 무관해진다 — 이 축은 그 구분을 못 한다(과탐 방향 — 실제로는 괜찮은데
#    "안 채워졌다"고 보고할 수 있음).
# 4. IaC 커버리지는 «스크립트에 그 키 리터럴이 있는가»만 본다 — 조건부 분기(`if [ "$ENV" =
#    "prod" ]`) 안에 있어도 스크립트 전체 텍스트에서 매치되면 "있다"로 잡힌다(과소탐지
#    방향 — dev 분기에만 있어도 prod가 커버된 것처럼 보일 수 있음).
def test_ac6_dynamic_key_construction_is_not_detected(tmp_path):
    """1번 한계를 코드로도 고정 — 동적 키 조립은 진짜로 안 잡힌다는 것을 실증."""
    mod = _load_check_env_drift()
    src = tmp_path / "dynamic.ts"
    src.write_text("const key = 'RUNTIME_' + suffix; const v = process.env[key];\n")
    reads = mod._web_env_reads(tmp_path)
    assert reads == {}, "동적 키 조립은 이 축이 원천적으로 못 본다는 전제가 깨짐"


# ── ⑤㉠ baseline 래칫(파울로군 지시, 2026-07-28) — report-only가 영원히 report-only가
# 되지 않도록: baseline에 없는 새 ㉠은 FAIL, baseline 안은 count만, self-expiring ──────


def _entry(reason="r", declared_by="PO", until="2026-08-27"):
    return {"reason": reason, "declared_by": declared_by, "until": until}


def test_baseline_known_high_is_not_escalated():
    mod = _load_check_env_drift()
    baseline = {"KNOWN_KEY": _entry()}
    ok, escalate = mod._split_high_by_baseline(
        [("KNOWN_KEY", "KNOWN_KEY (file.ts)")], baseline, mod._today()
    )
    assert len(ok) == 1 and escalate == []


def test_new_high_not_in_baseline_is_escalated():
    """AC의 핵심 — baseline에 없는 신규 ㉠은 즉시 FAIL 대상이 된다."""
    mod = _load_check_env_drift()
    ok, escalate = mod._split_high_by_baseline(
        [("BRAND_NEW_KEY", "BRAND_NEW_KEY (file.ts)")], {}, mod._today()
    )
    assert ok == [] and len(escalate) == 1
    assert "BRAND_NEW_KEY" in escalate[0] and "신규" in escalate[0]


def test_baseline_entry_expired_is_escalated():
    """만료된 baseline은 신규와 동일하게 FAIL — 「묻어두는 곳」이 되지 않는다."""
    from datetime import date
    mod = _load_check_env_drift()
    baseline = {"OLD_KEY": _entry(until="2026-01-01")}
    ok, escalate = mod._split_high_by_baseline(
        [("OLD_KEY", "OLD_KEY (file.ts)")], baseline, date(2026, 7, 28)
    )
    assert ok == [] and len(escalate) == 1 and "만료" in escalate[0]


def test_baseline_entry_too_far_in_future_is_escalated():
    mod = _load_check_env_drift()
    baseline = {"K": _entry(until="2099-12-31")}
    ok, escalate = mod._split_high_by_baseline([("K", "K (f.ts)")], baseline, mod._today())
    assert ok == [] and "너무 멀다" in escalate[0]


def test_baseline_entry_without_reason_is_escalated():
    mod = _load_check_env_drift()
    entry = _entry()
    del entry["reason"]
    baseline = {"K": entry}
    ok, escalate = mod._split_high_by_baseline([("K", "K (f.ts)")], baseline, mod._today())
    assert ok == [] and "reason" in escalate[0]


def test_repo_code_read_high_baseline_is_wellformed():
    """저장소에 실제로 커밋된 baseline(13건, 2026-08-07 — #2510 NEXT_PUBLIC_TOSS_CLIENT_KEY
    추가로 14→15, 2026-08-17 — #2728 NEXT_PUBLIC_EE_ENABLED를 cloudbuild.yaml/GHA 배선으로
    해소해 15→14, 2026-08-18 — #e6500272 LICENSE_CONSENT를 backend deploy 스텝 배선으로
    해소해 14→13)이 형식을 지키는지."""
    mod = _load_check_env_drift()
    baseline = mod._load_code_read_high_baseline()
    assert len(baseline) == 13
    for key, entry in baseline.items():
        problem = mod._baseline_entry_expired(entry, mod._today())
        assert problem is None, f"{key}: {problem}"


def test_ac1_full_main_new_high_key_escalates_to_fail(monkeypatch, capsys):
    """⭐라이브 재현 — baseline에 없는 새 ㉠ 하나가 실제로 main()을 exit 1로 떨어뜨리는지
    end-to-end로 본다(AC1이 요구하는 "가드가 빨개지는 것"을 ㉠ 축에서도 만족)."""
    mod = _load_check_env_drift()
    monkeypatch.setattr(mod, "_list_live_services", lambda: ["sprintable-frontend-prod"])
    monkeypatch.setattr(mod, "_live_env_entries", lambda service: [])
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    monkeypatch.setattr(mod, "_iac_covered_keys_for_service", lambda service: set())
    monkeypatch.setattr(mod, "_iac_covered_keys", lambda: set())
    monkeypatch.setattr(
        mod, "_web_env_reads",
        lambda: {"BRAND_NEW_UNBASELINED_KEY": [("fake.ts", None)]},  # 기본값 없음 = ㉠
    )
    monkeypatch.setattr(mod, "_load_code_read_exempt", lambda: set())
    monkeypatch.setattr(mod, "_load_code_read_high_baseline", lambda: {})  # baseline 비어있음

    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 1
    assert "BRAND_NEW_UNBASELINED_KEY" in out and "신규" in out


def test_baseline_count_is_always_printed(monkeypatch, capsys):
    """③ — baseline 수를 «매번» 찍는다(성공 경로에서도). 안 찍으면 baseline이 줄어드는지
    아무도 모른다."""
    mod = _load_check_env_drift()
    monkeypatch.setattr(mod, "_list_live_services", lambda: [])  # 서비스 0개 — 완전 성공 경로
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))

    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 0
    assert "⑤㉠ baseline" in out

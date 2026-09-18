#!/usr/bin/env python3
"""ⓒ 라이브 env 드리프트 가드 — ①키집합 대조 + ②값 대조(story #2098) + ③평문 시크릿 형태 검출.

라이브 Cloud Run 서비스의 env var 키 이름 전체가 (IaC 선언 키 ∪ manual-env-allowlist.yml)
안에 있는지 확認한다(①). 서비스 목록은 `gcloud run services list`로 매 실행 동적 열거 —
하드코딩하지 않는다(mcp-dev 키 유출 사건이 "아무도 안 본 서비스"에서 났다는 교훈).

②(값 대조)는 DRY_RUN을 지원하는 deploy_backend.sh/deploy_frontend.sh 대상(backend-dev/prod,
frontend-dev/prod)만 커버한다 — #2381이 잡은 APP_ENV/FRONTEND_URL/COOKIE_DOMAIN류 버그가
정확히 이 두 스크립트의 계산값 클래스였다. realtime-dev(cloudbuild.yaml 단일 소스)·
mcp-dev/prod(항상 `--set-env-vars` 전체교체라 additive-drift 리스크 자체가 낮음)는 이번
스코프 밖 — 후속으로 넓힐 수 있음(못 잡는 것을 못 잡는다고 적어두는 것).

⛔ ③(평문 시크릿 형태 검출)은 excluded_services 여부와 무관하게 **전 서비스**에 적용한다 —
①②축은 "이 repo의 IaC로 대조 불가"라는 이유로 뺄 수 있지만, ③은 라이브 env value만 보면
판정되는 축이라 IaC 유무와 무관하다(오르테가군 지적, 2026-07-22: "제외"가 "감시 밖"이
되면 이 가드를 만든 이유 자체가 무효화된다 — mcp-dev 사고가 정확히 그 구멍에서 났다).

④(story #2135, 2026-07-24) — Settings 커버리지: app.core.config.Settings를 실제로 쓰는
서비스(backend-dev/prod·realtime-dev — 같은 이미지)의 라이브 env 키가 Settings 필드명(대문자
변환) ∪ manual-env-allowlist.yml의 settings_exempt와 매칭되는지. 오늘 실측된 결함류
("REDIS_CONSUME_ENABLED"가 실제 필드 `event_broker_redis_consume_enabled`와 안 맞아
pydantic-settings의 extra="ignore"가 조용히 삼킨 것)를 배포 시점(CI)에 잡기 위함 —
Settings 클래스 자체를 extra="forbid"로 바꾸는 건 안 함(플랫폼/런타임 주입 키가 기동을
막는 위험, 오르테가 판정 2026-07-24). ⚠️report-only로 시작 — 라이브 env엔 플랫폼 주입키
(K_SERVICE·PORT·PYTHONPATH·GOOGLE_*·CLOUDSDK_* 등)가 반드시 섞여 있어 exempt 목록이
안정화되기 전엔 FAIL 승격하지 않는다(exit code에 반영 안 함 — stdout 열거만). exempt 목록이
triage로 정리된 後 별도 커밋에서 fail로 승격할 것.

⑤(story #2296, 2026-07-28) — 코드가 읽는데 아무도 안 주는 값. ①②③④는 전부 "라이브 ↔
IaC" 두 자리만 본다 — 둘 다 그 값을 모르면(둘 다 안 준다) "드리프트 없음"으로 읽힌다. 오늘
프론트 prod 로그인이 정확히 그 구멍으로 죽었다(`MOBILE_APP_LINK_ORIGIN`·
`FIREBASE_BFF_INTERNAL_SECRET` 둘 다 IaC에도 라이브 어디에도 없었다 — dev는 하드코딩
기본값이 우연히 dev 주소와 같아 "그냥 됐다"). 세 번째 축 "코드가 읽는 이름"을 붙인다 —
`apps/web/src`를 정적 스캔해 `process.env['X']`/`process.env.X` 읽는 키를 전부 뽑고,
IaC∪라이브(그 서비스 것) 어디에도 없는 키를 위험 등급별로 보고한다. 백엔드는 이미 ④(Settings
커버리지)와 pydantic-settings의 필수 필드 검증(기본값 없는 필드는 기동 자체가 실패)이
같은 역할을 구조적으로 하고 있어 이 축의 신규 대상이 아니다 — Next.js는 `process.env.X`가
없어도 그냥 `undefined`로 흘러 기동은 되고 런타임에 조용히 깨지는 게 이 사고의 근본이었다.

값 자체는 절대 출력/기록하지 않는다 — 매치 여부(bool)만 사용, stdout엔 키 이름·서비스만.
⚠️⑤의 "기본값" 판정은 예외다 — 소스 코드에 **리터럴로 박힌** 폴백 문자열(이미 git에
공개돼 있는 것, 예: `'https://dev-app.sprintable.ai'`)만 읽는다. 라이브 Cloud Run env
value는 이 축도 절대 안 읽는다(①이 이미 뽑아 둔 키 «이름» 집합만 재사용).

⑤ 후속(2026-07-31, 민 지적) — `env: NodeJS.ProcessEnv = process.env` DI 관례 블라인드스팟.
⑤가 원래 `process.env['X']`/`process.env.X`만 봐서, process.env를 파라미터(관례상 이름
`env`)로 받아 테스트 가능하게 만드는 함수 안의 읽기(`env['X']`)는 못 봤다. 이 코드베이스에
9개 파일·12개 읽기가 이 패턴이고, `SPRINTABLE_RUNTIME_ROLE`이 정확히 이 구멍으로 빠져 있었다
— apps/web/src/services/background-runtime.ts가 이 값으로 배경 워커(Discord/Slack/Teams
아웃바운드+메모 디스패처) 기동 여부를 정하는데, 값이 없으면 프로덕션에서 `role='web'`으로
조용히 떨어져 instrumentation.ts가 워커를 시작 안 하고 그냥 `return`한다(throw도 로그도
없음). 라이브 실측(2026-07-31): `sprintable-frontend-{dev,prod}` 둘 다 이 값이 없다 —
IaC에도 없다(스크립트 전수 grep 0건). 이 DI 관례를 실제로 선언한 파일에서만 `env[...]`도
추가로 본다(무관 변수명 오탐 방지).

로컬 수동 실행:
    python3 infra/check_env_drift.py

exit code: 0=드리프트 없음, 1=드리프트 발견(FAIL 상세를 stdout에 출력).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

def _find_repo_root(start: Path) -> Path:
    """story #2305 AC5 — '../' 개수를 세지 않고 표식 디렉터리(.git)를 찾아 올라간다.
    이 파일이 옮겨져도(디렉터리 깊이가 바뀌어도) 조용히 엉뚱한 경로를 안 가리킨다.
    ⛔못 찾으면 조용히 넘기지 않고 즉시 실패한다(재료를 못 찾은 가드가 skip으로 통과하면
    안 된다는 원칙 — 2026-07-28 #2600 실사고 교훈)."""
    cur = start.resolve()
    for _ in range(20):
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    raise RuntimeError(f"repo root(.git 표식)를 {start} 위로 못 찾음 — 잘못된 위치에서 실행됐을 가능성")


_REPO_ROOT = _find_repo_root(Path(__file__).resolve().parent)
_REGION = "asia-northeast3"
_ALLOWLIST_PATH = _REPO_ROOT / "infra" / "manual-env-allowlist.yml"


def _env_for_service(service: str) -> str:
    """story #2224 후속(오르테가 판정, 2026-07-31) — 서비스 이름으로 환경(dev/prod)을 가른다.
    두 가지 명명 관례가 실제로 섞여 있다(둘 다 실측 확認):
      ㉠`_SERVICE_SCRIPT_MAP`(마스터) 서비스들 — "-dev"·"-prod" 둘 다 명시(sprintable-
        backend-dev/-prod류). ⛔단 `sprintable-realtime-dev`는 prod 짝이 없다(cloudbuild.yaml
        단일 소스, dev 전용 서비스) — 짝이 없어도 접미사만으로 dev로 판별한다(짝의 존재
        여부와 이 판별은 별개 문제).
      ㉡allowlist의 `excluded_services`(sprintable-admin-web류, 별도 repo IaC 소관) —
        prod는 «접미사 없음»(bare), dev만 "-dev"가 붙는다(sprintable-admin-web ↔
        sprintable-admin-web-dev 쌍으로 실존 확認, manual-env-allowlist.yml 참조).
    ⇒ "-dev"로 끝나면 dev, 그 외(= "-prod"로 끝나거나 접미사 자체가 없는 bare 이름)는
    전부 prod로 취급한다 — ㉡류가 ①②축은 이미 제외돼 있어(별도 repo IaC) 이 구분이
    실제로 영향을 주는 것은 ③(평문 시크릿)뿐인데, ③은 "어느 한 실행에 정확히 한 번" 걸리면
    되므로(두 번 걸리면 중복 로그일 뿐 오탐은 아니나, 정확한 배정이 더 낫다) bare=prod로
    고정한다."""
    return "dev" if service.endswith("-dev") else "prod"

# ④ Settings 커버리지 대상 — app.core.config.Settings를 실제로 임포트해서 쓰는 서비스만
# (같은 이미지). frontend·mcp·admin은 이 클래스 자체를 안 쓰므로 제외(오탐 방지 핵심).
_SETTINGS_CONSUMING_SERVICES = {
    "sprintable-backend-dev", "sprintable-backend-prod", "sprintable-realtime-dev",
}


_SETTINGS_CONFIG_PATH = _REPO_ROOT / "backend" / "app" / "core" / "config.py"
# `    field_name: type = default` 형태의 클래스 필드 선언만 잡는다(4칸 들여쓰기 — Settings
# 클래스 본문 레벨). config.py가 오늘 순수 선언형(82필드 전부 이 형태)이라 정확히 맞는다.
_SETTINGS_FIELD_RE = re.compile(r"^    ([a-z_][a-zA-Z0-9_]*)\s*:\s*[^=\n]+=", re.MULTILINE)


def _settings_field_env_keys() -> set[str]:
    """app/core/config.py를 **static 파싱**해 Settings 필드명을 env var 키로 변환(env_prefix
    없음 ⇒ 필드명 대문자 == env 키, alias 0개 전제 — 전제가 깨지면 이 함수도 갱신 필요).

    ⛔story #2135 라이브 실증(2026-07-24, 오르테가 재트리거) — 원래는 `from app.core.config
    import Settings`로 실제 import했으나, env-drift-guard.yml 워크플로는 gcloud+파싱만
    하는 가벼운 CI라 backend 의존성(pydantic_settings 등)이 설치돼 있지 않다.
    `ModuleNotFoundError: No module named 'pydantic_settings'`로 매일 00:00 크래시하는
    가드를 배포할 뻔했다 — fixture(pytest, backend 의존성 있는 환경) 통과가 라이브 동작을
    보증하지 않는다는 것을 이 사건 자체가 실증한다. **infra 도구가 앱 런타임을 import하면
    안 된다**가 근본 — static 파싱으로 층을 분리한다(import 0·의존성 0).
    ⚠️한계: config.py가 동적으로 필드를 생성하면(현재는 순수 선언형 82필드 전부 이 형태라
    해당 없음) 이 파싱이 놓친다."""
    text = _SETTINGS_CONFIG_PATH.read_text()
    return {name.upper() for name in _SETTINGS_FIELD_RE.findall(text)}


def _load_settings_exempt() -> dict[str, str]:
    """반환: {key: reason} — 플랫폼/런타임 주입 등 Settings가 몰라도 되는 키."""
    import yaml
    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    return {
        entry["key"]: entry.get("reason", "")
        for entry in data.get("settings_exempt", [])
    }

# 서비스 → 그 서비스의 env를 다루는 스크립트/IaC 소스. cloudbuild.yaml/cloud-build.yml은
# 전 서비스 공통으로 파싱해 합집합에 넣는다(어느 스텝이 어느 서비스를 겨냥하는지까지 세밀하게
# 가르지 않음 — v1은 "이 repo의 IaC 전체에 이 키가 한 번이라도 선언된 적 있는가"로 판정).
# 여기 없는 서비스가 gcloud 열거에 나타나면 FAIL로 잡는다(매핑 자체가 최신인지 강제).
#
# ⭐story #2305 — 이 dict의 key 집합(7개)이 서비스명의 **SSOT(마스터)**다. AC1 확定 근거:
# `sprintable-realtime-prod`는 cloudbuild.yaml에 실선언이 아니라 **주석 문장에만** 등장한다
# (deploy-realtime 스텝이 prod에서 아직 스킵 중 — 2026-07-29 직접 확認, grep이 주석을 매칭한
# 오탐이 아님을 실코드로 재확認). `_SETTINGS_CONSUMING_SERVICES`·`_SERVICE_DRY_RUN_MAP`·
# `_WEB_CODE_SERVICES`는 전부 이 마스터의 **부분집합**이어야 한다(서로 같을 필요는 없다 —
# 각자 다른 목적의 의도적 서브셋). `_service_subset_wellformed_violations()`가 이걸 강제한다.
_SERVICE_SCRIPT_MAP: dict[str, list[str]] = {
    "sprintable-backend-dev": ["backend/scripts/deploy_backend.sh"],
    "sprintable-backend-prod": ["backend/scripts/deploy_backend.sh"],
    "sprintable-realtime-dev": [],  # cloudbuild.yaml deploy-realtime 스텝만(공통 파싱에 포함)
    "sprintable-frontend-dev": ["backend/scripts/deploy_frontend.sh"],
    "sprintable-frontend-prod": ["backend/scripts/deploy_frontend.sh"],
    "sprintable-mcp-dev": ["backend/scripts/deploy_mcp_dev.sh"],
    "sprintable-mcp-prod": ["backend/scripts/deploy_mcp_prod.sh"],
    # story #2821 부수 발견(2026-08-19) — office-converter-dev(story #2771, gotenberg 공개
    # 이미지)가 어제 편입됐으나 여기 미등재라 "매핑 안 된 신규 서비스"로도 안 잡히고 있었다
    # (None-크래시가 그 자리를 가리고 있었을 뿐). cloudbuild.yaml deploy-office-converter
    # 스텝이 env 플래그 자체를 안 실어(공통 파싱에 이미 포함) 전용 스크립트가 없다 —
    # sprintable-realtime-dev([])와 동일 패턴.
    "office-converter-dev": [],
    # story #3263(지원v1·5에스컬레이션, 2026-08-31, 페드루 PO 지시) — support-gateway-dev
    # (story #f2a27d2a, cloudbuild.yaml deploy-support-gateway 스텝)가 dev 프로비저닝
    # 완료 후 실행 CI에서 "매핑 안 된 신규 서비스"로 FAIL을 냈다(run 33456055351) — 여기
    # 미등재였을 뿐(office-converter-dev와 동일 클래스). 전용 배포 스크립트가 없다
    # (gcloud run deploy를 cloudbuild.yaml 스텝이 직접 실행) — office-converter-dev([])와
    # 동일 패턴.
    "support-gateway-dev": [],
}

# ② 값 대조 대상 — DRY_RUN=1로 ENV_VARS_SPEC을 stdout에 뽑아낼 수 있는 스크립트만.
_SERVICE_DRY_RUN_MAP: dict[str, tuple[str, str]] = {
    "sprintable-backend-dev": ("backend/scripts/deploy_backend.sh", "dev"),
    "sprintable-backend-prod": ("backend/scripts/deploy_backend.sh", "prod"),
    "sprintable-frontend-dev": ("backend/scripts/deploy_frontend.sh", "dev"),
    "sprintable-frontend-prod": ("backend/scripts/deploy_frontend.sh", "prod"),
}

_KEY_RE = re.compile(r"([A-Z][A-Z0-9_]*)=")

# ③ 평문 시크릿 형태 검출 — 알려진 시크릿 프리픽스 패턴. 새 프리픽스가 생기면 여기 추가.
# ⚠️ 오르테가군 지적(2026-07-22): 앵커(^...$)는 값이 정확히 그 형태일 때만 잡는다 —
# `Bearer sk_live_...`나 URL 쿼리 파라미터·JSON 안에 박혀 있으면 통과해버린다(mcp-dev
# 사고가 마침 단독 값이었을 뿐, 다음엔 다른 형태로 샐 수 있다). search()로 값 어디에
# 박혀 있든 잡히게 무앵커로 바꿨다 — `sk_live_`+15자 이상 영숫자가 우연히 등장할 값은
# 사실상 없어 오탐 위험은 낮다.
# ⚠️ 한계(현재 스코프 밖, 기록만): `sk_live_` 프리픽스만 검출한다 — `sk_test_`·GitHub
# 토큰·GCP 키 등 다른 시크릿 형태는 이 패턴으로 못 잡는다(스코프 확대는 후속).
_SECRET_SHAPE_RE = re.compile(r"sk_live_[A-Za-z0-9]{15,}")


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _load_allowlist() -> tuple[dict[str, set[str]], dict[str, dict]]:
    """반환: {service: {제외된 축 집합}} — ③은 절대 포함되지 않는다(코드에서 강제)."""
    import yaml

    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    excluded_axes: dict[str, set[str]] = {}
    for entry in data.get("excluded_services", []):
        axes = set(entry.get("excluded_axes", []))
        axes.discard("secret_shape")  # ③은 축별 제외 대상에서 원천 배제
        excluded_axes[entry["service"]] = axes
    services = data.get("services", {})
    return excluded_axes, services


def _list_live_services() -> list[str]:
    out = _run([
        "gcloud", "run", "services", "list",
        f"--region={_REGION}", "--format=value(metadata.name)",
    ])
    return [line.strip() for line in out.splitlines() if line.strip()]


def _live_env_entries(service: str) -> list[dict]:
    """서비스의 raw env 리스트(name + value 또는 valueFrom) — ②③이 공유.

    ⛔story #2821 실사고 — `env` 필드가 컨테이너 스펙에 아예 없으면(빈 배열이 아니라 키
    자체 부재) `--format=json(...)` 필드 프로젝션이 literal JSON `null`을 낸다(빈 문자열이
    아니라 텍스트 "null" — `if not out`을 통과해버린다). `json.loads("null")`은 `None`이라
    다음 줄 `data.get(...)`이 AttributeError로 죽는다. 실측(2026-08-19): office-converter-dev
    (gotenberg 공개 이미지, cloudbuild.yaml deploy-office-converter 스텝이 env 플래그
    자체를 안 실음)가 정확히 이 형태 — env 0건은 정상 상태이지 결함이 아니다. 조용히
    삼키지 않고 어느 서비스가 왜 0건으로 처리됐는지 stdout에 남긴다(크래시는 빨강이되
    진단 불가라 반쪽이라는 지적, PO 2026-08-19)."""
    out = _run([
        "gcloud", "run", "services", "describe", service,
        f"--region={_REGION}",
        "--format=json(spec.template.spec.containers[0].env)",
    ])
    if not out:
        print(f"  ℹ️ {service}: describe 결과가 빈 문자열 — env 0건으로 처리")
        return []
    data = json.loads(out)
    if data is None:
        print(
            f"  ℹ️ {service}: describe의 env 필드가 null(컨테이너 스펙에 env 키 자체가 "
            "없음) — env 0건으로 처리"
        )
        return []
    return (
        data.get("spec", {}).get("template", {}).get("spec", {})
        .get("containers", [{}])[0].get("env", [])
    )


def _plain_secret_shaped_keys(envs: list[dict]) -> list[str]:
    """③ — plain(비-secretKeyRef) env value가 알려진 시크릿 형태와 일치하는 키 이름만 반환.

    값 자체는 이 함수 밖으로 절대 나가지 않는다(정규식 매치 결과 bool만 사용) — 호출부는
    반환된 키 이름과 서비스만 로그에 남긴다."""
    hits = []
    for entry in envs:
        value = entry.get("value")
        if value is not None and _SECRET_SHAPE_RE.search(value):
            hits.append(entry["name"])
    return hits


def _live_plain_env_values(envs: list[dict]) -> dict[str, str]:
    """② 대조용 — plain(비-secretKeyRef) env만 key→value. secretKeyRef는 값이 안 보이니
    비교 대상이 아니다(① 키집합 대조가 그 존재 자체는 이미 커버)."""
    return {e["name"]: e["value"] for e in envs if e.get("value") is not None}


def _parse_key_value_spec(spec: str) -> dict[str, str]:
    """`KEY1=val1,KEY2=val2` 또는 `^@^KEY1=val1@KEY2=val2` 류 구분자 무관 파싱.

    `_extract_keys_from_text`와 동일 전제(`[A-Z][A-Z0-9_]*=` 위치 기준) — 각 키 매치의
    시작~다음 키 매치 시작 사이를 값으로 보고, 끝에 남은 구분자 문자(,·@·#·^)만 벗겨낸다.
    """
    matches = list(_KEY_RE.finditer(spec))
    result: dict[str, str] = {}
    for i, m in enumerate(matches):
        key = m.group(1)
        val_start = m.end()
        val_end = matches[i + 1].start() if i + 1 < len(matches) else len(spec)
        result[key] = spec[val_start:val_end].rstrip(",@#^")
    return result


def _dry_run_env_vars_spec(script_rel: str, env_arg: str) -> dict[str, str]:
    """deploy_backend.sh/deploy_frontend.sh를 DRY_RUN=1로 돌려 ENV_VARS_SPEC 계산값을 얻는다.

    실 배포(gcloud run deploy)는 스킵되고 resolved config만 stdout으로 나온다(스크립트
    자체의 DRY_RUN 계약) — network 부작용 없음(단, prod frontend의 FASTAPI_URL 동적
    discovery 자체는 read-only gcloud describe 1콜을 그대로 수행)."""
    script_path = _REPO_ROOT / script_rel
    result = subprocess.run(
        ["bash", str(script_path), env_arg],
        capture_output=True, text=True, check=True,
        env={**os.environ, "DRY_RUN": "1", "COMMIT_SHA": "dry-run-placeholder", "ENV": env_arg},
    )
    for line in result.stdout.splitlines():
        if line.startswith("ENV_VARS_SPEC="):
            return _parse_key_value_spec(line[len("ENV_VARS_SPEC="):])
    return {}


def _extract_keys_from_text(text: str) -> set[str]:
    """--update-env-vars=/--set-env-vars=/ENV_VARS_SPEC 류 문자열에서 KEY= 패턴 전수 추출.

    커스텀 구분자(^@^, ^##^)든 콤마든 상관없이 `[A-Z][A-Z0-9_]*=` 형태만 보므로 구분자
    파싱 자체는 불필요 — 값 안에 등장하는 대문자 패턴 오탐 가능성은 있으나(예: URL 안의
    쿼리 파라미터) 이 repo의 실제 값들 기준으로는 나타나지 않음(v1 실용적 타협).
    """
    return set(_KEY_RE.findall(text))


def _iac_covered_keys_for_service(service: str) -> set[str]:
    """⑤ 전용 — ①의 `_iac_covered_keys()`는 전 서비스 스크립트를 합쳐(global union) 판정한다
    (v1 실용적 타협, 위 클래스 docstring 참고). 그런데 그 합집합이 정확히 이 축의 두 실사고
    중 하나(`FIREBASE_BFF_INTERNAL_SECRET`)를 가린다 — 그 키는 deploy_backend.sh에만 있고
    deploy_frontend.sh엔 없는데, 전역 합집합으로 보면 "IaC 어딘가엔 있다"가 되어 frontend가
    실제로 그 키를 공급받는지와 무관하게 "커버됨"으로 잘못 판정된다. ⑤는 그래서 «이
    서비스를 담당하는 스크립트»로만 좁혀 본다(공유 cloudbuild.yaml/cloud-build.yml은
    여러 서비스가 같은 스텝에서 배선될 수 있어 그대로 포함)."""
    covered: set[str] = set()
    for rel in ("cloudbuild.yaml", ".github/workflows/cloud-build.yml"):
        path = _REPO_ROOT / rel
        if path.exists():
            covered |= _extract_keys_from_text(path.read_text())
    for rel in _SERVICE_SCRIPT_MAP.get(service, []):
        path = _REPO_ROOT / rel
        if path.exists():
            covered |= _extract_keys_from_text(path.read_text())
    return covered


def _iac_covered_keys() -> set[str]:
    covered: set[str] = set()
    for rel in ("cloudbuild.yaml", ".github/workflows/cloud-build.yml"):
        path = _REPO_ROOT / rel
        if path.exists():
            covered |= _extract_keys_from_text(path.read_text())
    for scripts in _SERVICE_SCRIPT_MAP.values():
        for rel in scripts:
            path = _REPO_ROOT / rel
            if path.exists():
                covered |= _extract_keys_from_text(path.read_text())
    return covered


# ⑤ 코드가 읽는데 아무도 안 주는 값 — apps/web/src 정적 스캔 대상.
_WEB_SRC_DIR = _REPO_ROOT / "apps" / "web" / "src"
_ENV_BRACKET_RE = re.compile(r"process\.env\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\]")
_ENV_DOT_RE = re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)")

# ⑤ 후속(2026-07-31) — `env: NodeJS.ProcessEnv = process.env` DI 관례 블라인드스팟. 함수가
# process.env를 파라미터(관례상 이름 `env`)로 받아 테스트 가능하게 만드는 패턴이 이
# 코드베이스에 9개 파일·12개 읽기로 실재한다 — 그 파라미터로 읽으면 문자열 리터럴
# 「process.env」가 없어 위 두 정규식이 못 본다. `SPRINTABLE_RUNTIME_ROLE`이 정확히 이
# 구멍으로 빠졌다(apps/web/src/services/background-runtime.ts:83, `env['SPRINTABLE_RUNTIME_ROLE']`
# — 값이 없으면 apps/web/scripts/background-runtime-worker.ts가 즉시 throw한다).
# ⛔무관 변수명 오탐을 막으려고 "이 DI 관례를 실제로 선언한 파일에서만" 추가로 본다 —
# 아무 파일에서나 `env[...]`를 다 잡으면 관계없는 지역변수까지 오염된다.
_ENV_PARAM_DI_RE = re.compile(r"\benv\s*:\s*NodeJS\.ProcessEnv\s*=\s*process\.env\b")
_ENV_PARAM_BRACKET_RE = re.compile(r"(?<!process\.)\benv\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\]")
_ENV_PARAM_DOT_RE = re.compile(r"(?<!process\.)\benv\.([A-Z][A-Z0-9_]*)\b")
# 매치 직후 200자 안에서 `?? '...'`/`|| '...'`(문자열 리터럴 폴백)만 인식한다 — 함수 호출·
# 변수 등 리터럴이 아닌 폴백은 "기본값 없음"과 동일하게 취급(안전 쪽, ㉠으로 승격).
_DEFAULT_LITERAL_RE = re.compile(r"""^\s*(?:\?\?|\|\|)\s*['"]([^'"]*)['"]""")

# 플랫폼/빌드가 항상 채우거나 이 축의 판정 대상이 아닌 잘 알려진 키.
# NEXT_RUNTIME — Next.js가 빌드/런타임에 자동 주입(nodejs/edge 런타임 구분), 사람이 배포
# 설정으로 "공급"하는 값이 아니다(2026-07-28 실측 확認 — instrumentation.ts가 읽지만 그
# 값은 배포 SSOT/라이브 env var가 아니라 프레임워크가 실행 컨텍스트에 따라 스스로 세팅).
# VERCEL_URL·VERCEL_PROJECT_PRODUCTION_URL — Vercel 플랫폼이 배포 시 자동 주입하는
# 값이다(app-url.ts의 Vercel-auto-env 폴백 계단). 이 저장소는 GCP Cloud Run으로 나가(
# env-drift-guard.yml의 WIF 인증이 그 증거) Vercel에서 도는 일이 없으니 이 두 키는 «항상»
# undefined가 정상이다 — ⑤ 후속(2026-07-31, env: NodeJS.ProcessEnv 파라미터 스캔 확장)에서
# 새로 잡히기 시작해 여기 추가했다(NEXT_RUNTIME과 같은 이유).
_WEB_ENV_IGNORE = {"NODE_ENV", "NEXT_RUNTIME", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"}

# ⑤가 대상으로 삼는 서비스 — apps/web 코드베이스를 실제로 구동하는 라이브 서비스만.
_WEB_CODE_SERVICES = {"sprintable-frontend-dev", "sprintable-frontend-prod"}


# ── ⑥ story #2305: 서비스명 부분집합 wellformed + 외부 IaC 대조 ────────────────────
#
# 배경(doc `duplicate-registry-census-20260728` #9·#10, 원 판정 철회됨): "4곳이 같은 목록이라
# 일치해야 한다"는 애초에 틀린 전제였다 — 넷은 각자 다른 목적의 **의도적 부분집합**이다.
# 진짜 구멍은 「그 부분집합들이 마스터(_SERVICE_SCRIPT_MAP)의 실제 부분집합인지 재는 자가
# 0건」이었다 — 오타로 만든 유령 서비스명이 들어가도 아무도 못 잡는다.
#
# ⛔양방향(집합 동일)으로 재면 안 된다 — 의도적 부분집합이 거짓 불일치로 잡힌다. **한 방향만**
# (subset - master == 공집합) 잰다.
_SERVICE_NAME_RE = re.compile(r"sprintable-[a-z]+-(?:dev|prod)")

# `_SERVICE_NAME_RE`는 모양(`sprintable-*-{dev,prod}`)만 보는 정규식이라, Cloud Run 서비스가
# 아닌 다른 리소스(GCS 버킷 등)의 이름이 우연히 같은 모양이면 구분 못한다.
#
# ⛔story #3117(2026-08-26, PR#3520 카디르 qa:changes) — GCS_AVATARS_BUCKET을 prod에도 명시
# 배선(`GCS_AVATARS_BUCKET=sprintable-avatars-prod`·`BUCKET="sprintable-avatars-prod"`)하자
# 이 스캐너가 그 리터럴을 "유령 서비스"로 오탐해 CI를 3연쇄 실패시켰다. 개별 리터럴을
# `_NON_SERVICE_LITERAL_ALLOWLIST`에 하나씩 추가하는 건 밴드에이드다(다음 버킷/GCS 리소스
# 리터럴마다 재발하는 클래스) — 대신 매치 **직전 컨텍스트**로 "이건 GCS 버킷 참조다"를
# 구조적으로 가른다: 이 저장소의 모든 버킷 참조는 예외 없이 (a) `gs://` 뒤에 오거나
# (b) 이름에 BUCKET이 들어간 키/변수(`_GCS_AVATARS_BUCKET:`·`GCS_AVATARS_BUCKET=`·
# `BUCKET="`류)의 값으로만 등장한다(실측: 이 파일들의 서비스 선언 8종 — SERVICE_NAME=·
# FASTAPI_SERVICE=·FASTAPI_URL=·https:// 자동생성 URL·`gcloud run deploy/services` 커맨드 —
# 그 어느 것도 이름에 BUCKET이 없다). `_looks_like_resource_literal()`이 이 두 컨텍스트를
# 매치 직전 텍스트로 판별한다 — 새 버킷을 몇 개를 더 만들어도 이 두 관례(BUCKET named
# key/`gs://`)만 지키면 이 가드가 자동으로 걸러낸다(마스터 불변식은 그대로 유지).
_NON_SERVICE_LITERAL_ALLOWLIST: dict[str, str] = {}

# BUCKET이 들어간 key/변수명 뒤에(`:`/`=`, 옵션 인용부호) 곧바로 오는 값 — GCS 버킷 참조.
_BUCKET_KEY_CONTEXT_RE = re.compile(r"[A-Za-z_]*BUCKET[A-Za-z_]*\s*[:=]\s*[\"']?$", re.IGNORECASE)


def _looks_like_resource_literal(line: str, match_start: int) -> bool:
    """매치 직전 컨텍스트(같은 줄, 매치 앞부분)로 "Cloud Run 서비스명이 아니라 다른 GCP
    리소스(GCS 버킷 등) 리터럴"인지 판별. `gs://` 직후이거나, BUCKET이 든 key/변수의 값이면
    True(서비스명 후보에서 제외)."""
    prefix = line[:match_start]
    if prefix.endswith("gs://"):
        return True
    return bool(_BUCKET_KEY_CONTEXT_RE.search(prefix))


def _service_subset_wellformed_violations() -> list[str]:
    """`_SERVICE_SCRIPT_MAP`(마스터) 밖의 이름이 나머지 세 목록에 있으면 그 이름을 낸다.
    한 방향만 잰다 — 마스터가 부분집합보다 큰 것(예: mcp-dev/prod가 이 셋 어디에도 없는 것)은
    정상이라 잡지 않는다."""
    master = set(_SERVICE_SCRIPT_MAP)
    violations: list[str] = []
    for label, subset in (
        ("_SETTINGS_CONSUMING_SERVICES", _SETTINGS_CONSUMING_SERVICES),
        ("_SERVICE_DRY_RUN_MAP", set(_SERVICE_DRY_RUN_MAP)),
        ("_WEB_CODE_SERVICES", _WEB_CODE_SERVICES),
    ):
        for ghost in sorted(subset - master):
            violations.append(
                f"{label}: 마스터(_SERVICE_SCRIPT_MAP)에 없는 이름: {ghost!r} "
                f"— 오타인가, 마스터에 추가할 것인가?"
            )
    return violations


def _strip_comment(line: str) -> str:
    """bash·YAML 둘 다 '#'가 주석 시작 — 이 저장소의 대상 파일들엔 문자열 리터럴 안에 '#'이
    없음을 확認했다(2026-07-29). ⛔이걸 안 하면 "sprintable-realtime-prod가 없다"처럼 주석
    문장 안의 서비스명을 실선언으로 오탐한다 — #10 census 항목이 정확히 이 오탐이었다."""
    idx = line.find("#")
    return line if idx == -1 else line[:idx]


def _external_iac_service_literals() -> set[str]:
    """cloudbuild.yaml·.github/workflows/*.yml·deploy_*.sh에서 실선언된(주석 아닌) 서비스명
    리터럴을 정적으로 모은다. ⛔AC5 — 대상 파일이 하나라도 없으면 조용히 skip하지 않고
    즉시 실패한다(재료를 못 찾은 가드가 "통과"로 읽히면 안 된다)."""
    targets = [
        _REPO_ROOT / "cloudbuild.yaml",
        *sorted((_REPO_ROOT / ".github" / "workflows").glob("*.yml")),
        *sorted((_REPO_ROOT / "backend" / "scripts").glob("deploy_*.sh")),
    ]
    missing = [str(p) for p in targets if not p.exists()]
    if missing:
        raise RuntimeError(
            f"서비스명 스캔 대상 파일을 못 찾음(AC5 — skip 대신 실패): {missing}"
        )
    names: set[str] = set()
    for path in targets:
        for line in path.read_text().splitlines():
            stripped = _strip_comment(line)
            for m in _SERVICE_NAME_RE.finditer(stripped):
                if _looks_like_resource_literal(stripped, m.start()):
                    continue
                names.add(m.group(0))
    return names - set(_NON_SERVICE_LITERAL_ALLOWLIST)


def _external_iac_wellformed_violations() -> list[str]:
    """외부 IaC(cloudbuild.yaml·workflows·deploy_*.sh)에 실선언된 서비스명이 마스터
    (_SERVICE_SCRIPT_MAP)에 없으면 그 이름을 낸다 — 한 방향만."""
    master = set(_SERVICE_SCRIPT_MAP)
    external = _external_iac_service_literals()
    return [
        f"외부 IaC(cloudbuild.yaml/workflows/deploy_*.sh)에 있는데 마스터에 없는 이름: "
        f"{ghost!r} — 오타인가, 마스터에 추가할 것인가?"
        for ghost in sorted(external - master)
    ]


def _web_env_reads(src_dir: Path = _WEB_SRC_DIR) -> dict[str, list[tuple[str, str | None]]]:
    """반환: {key: [(file_relpath, default_literal_or_None), ...]}. 소스 «리터럴»만 읽는다
    (git에 이미 공개된 텍스트) — 라이브 env value는 이 함수가 존재를 몰라도 된다."""
    findings: dict[str, list[tuple[str, str | None]]] = {}
    if not src_dir.exists():
        return findings
    paths = sorted(src_dir.rglob("*.ts")) + sorted(src_dir.rglob("*.tsx"))
    for path in paths:
        if ".test." in path.name or ".spec." in path.name:
            continue
        text = path.read_text(errors="ignore")
        try:
            rel = str(path.relative_to(_REPO_ROOT))
        except ValueError:
            rel = str(path)  # src_dir이 repo 밖(테스트의 tmp_path 등)일 때의 폴백
        regexes = [_ENV_BRACKET_RE, _ENV_DOT_RE]
        # ⑤ 후속 — 이 파일이 `env: NodeJS.ProcessEnv = process.env` DI 관례를 실제로
        # 선언했을 때만 env[...]/env.X도 process.env[...]와 같은 자리로 본다.
        if _ENV_PARAM_DI_RE.search(text):
            regexes += [_ENV_PARAM_BRACKET_RE, _ENV_PARAM_DOT_RE]
        for regex in regexes:
            for m in regex.finditer(text):
                key = m.group(1)
                if key in _WEB_ENV_IGNORE:
                    continue
                tail = text[m.end():m.end() + 200]
                dmatch = _DEFAULT_LITERAL_RE.match(tail)
                default = dmatch.group(1) if dmatch else None
                findings.setdefault(key, []).append((rel, default))
    return findings


def _classify_code_read_risk(defaults: list[str | None]) -> str:
    """같은 키를 여러 곳에서 읽으면 «가장 위험한» 등급으로 접는다.
    반환: "highest"(㉡ dev/localhost/test 기본값) · "high"(㉠ 기본값 없음) · "low"(㉢ 무관 상수)."""
    if any(d is not None and re.search(r"dev|localhost|test", d, re.IGNORECASE) for d in defaults):
        return "highest"
    if any(d is None for d in defaults):
        return "high"
    return "low"


def _unsupplied_code_read_findings(
    web_reads: dict[str, list[tuple[str, str | None]]],
    covered_keys: set[str],
    code_read_exempt: set[str],
) -> tuple[list[tuple[str, str]], list[tuple[str, str]], list[tuple[str, str]]]:
    """covered_keys(그 서비스의 IaC∪라이브 키 «이름» 집합)에 없는 키만, 등급별로 3개
    (key, line) 리스트로 나눠 돌려준다(highest, high, low). exempt는 아예 리스트에서
    빠진다(알려진 정상). key를 별도로 주는 이유 — ㉠(high)는 baseline 래칫과 대조해야
    한다(story #2296 후속, 파울로군 지시 2026-07-28)."""
    highest, high, low = [], [], []
    for key in sorted(web_reads):
        if key in covered_keys or key in code_read_exempt:
            continue
        occurrences = web_reads[key]
        tier = _classify_code_read_risk([d for _, d in occurrences])
        sample = ", ".join(sorted({f for f, _ in occurrences})[:2])
        line = f"{key} ({sample})"
        (highest if tier == "highest" else high if tier == "high" else low).append((key, line))
    return highest, high, low


def _load_code_read_exempt() -> set[str]:
    import yaml
    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    return {entry["key"] for entry in data.get("code_read_exempt", [])}


# ⑤ 후속(2026-07-28, 파울로군 지시) — ㉠(high)를 전부 report-only로 영원히 두면 "없는
# 가드"가 된다. 지금 알려진 것을 baseline으로 얼리고, baseline에 없는 «새» high만 FAIL —
# 그러면 지금은 안 빨개지고, 새 구멍은 막히고, baseline을 줄여야 한다는 압력이 남는다.
# ⛔baseline이 "묻어두는 곳"이 되지 않도록 self-expiring(#2280/#2174와 동일 원칙)+매 실행
# 카운트 출력을 강제한다.
_MAX_CODE_READ_BASELINE_HORIZON_DAYS = 30


def _load_code_read_high_baseline() -> dict[str, dict]:
    import yaml
    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    return {entry["key"]: entry for entry in data.get("code_read_high_baseline", [])}


def _baseline_entry_expired(entry: dict, today) -> str | None:
    """infra/mcp_path_contract_guard.py::_expired와 동일 계약(만료·형식 위반이면 사유,
    아니면 None) — 이 가드 계열 전체가 공유하는 규율이라 그대로 재현한다."""
    from datetime import date

    until_raw = entry.get("until")
    if not until_raw:
        return "`until`(만료일)이 없다 — 영원히 사는 baseline은 허용하지 않는다"
    try:
        until = date.fromisoformat(str(until_raw))
    except ValueError:
        return f"`until` 형식이 YYYY-MM-DD가 아니다: {until_raw!r}"
    if until < today:
        return f"baseline이 만료됐다(until={until}) — 재triage 필요"
    horizon = (until - today).days
    if horizon > _MAX_CODE_READ_BASELINE_HORIZON_DAYS:
        return f"`until`이 너무 멀다({until} · {horizon}일 뒤) — 최대 {_MAX_CODE_READ_BASELINE_HORIZON_DAYS}일"
    if not entry.get("reason"):
        return "`reason`(사유)이 없다"
    if not entry.get("declared_by"):
        return "`declared_by`(선언자)가 없다"
    return None


def _split_high_by_baseline(
    high_items: list[tuple[str, str]], baseline: dict[str, dict], today
) -> tuple[list[str], list[str]]:
    """high(㉠) findings를 baseline과 대조 — (baseline_ok_lines, new_or_expired_lines).
    후자는 FAIL로 승격된다(baseline에 없거나, 있어도 만료됐으면)."""
    ok, escalate = [], []
    for key, line in high_items:
        entry = baseline.get(key)
        if entry is None:
            escalate.append(f"{line} — 🔴baseline에 없는 신규")
            continue
        problem = _baseline_entry_expired(entry, today)
        if problem:
            escalate.append(f"{line} — 🔴baseline 등재는 있으나 {problem}")
        else:
            ok.append(f"{line} — baseline(until={entry['until']})")
    return ok, escalate


def _today():
    import os as _os
    from datetime import date, datetime, timezone

    env = _os.environ.get("ENV_DRIFT_GUARD_TODAY")
    if env:
        return date.fromisoformat(env)
    return datetime.now(timezone.utc).date()


def _write_state_file(fail_lines: list[str], *, only_env: str | None) -> None:
    """story #2422 — `ENV_DRIFT_STATE_FILE` 환경변수가 설정돼 있으면(설계상 CI에서만 —
    로컬 수동 실행은 이 변수를 안 주므로 파일을 안 남긴다) 이번 실행의 FAIL 집합을 정렬된
    JSON 목록으로 적는다. 값 자체는 여기 안 실린다 — 이미 위 finding 문자열들이 «키 이름만»
    (①②③⑤ 전부 이 파일 상단 docstring이 보장하는 계약) 담고 있으므로 그대로 옮겨 적어도
    안전하다. FAIL이 0건이어도(빈 리스트) 반드시 쓴다 — "어제는 빨강, 오늘은 초록"이라는
    해소 전이도 다음 실행이 알아야 하기 때문이다(파일 부재와 '빈 목록'을 구분 못 하면
    캐시 미스와 '실제로 깨끗함'을 못 가른다)."""
    import json
    import os as _os

    path = _os.environ.get("ENV_DRIFT_STATE_FILE")
    if not path:
        return
    payload = {"env": only_env, "fail_lines": sorted(set(fail_lines))}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def main(only_env: str | None = None) -> int:
    """story #2224 후속(오르테가 판정, 2026-07-31) — `only_env`("dev"|"prod"|None). 배경:
    이 가드는 스케줄 워크플로우가 checkout한 «한 브랜치»(GHA 스케줄 트리거는 default
    branch=main을 checkout한다)만 보는데, IaC/allowlist의 정본은 dev는 develop·prod는
    main으로 갈린다(#2320/#2205와 같은 클래스 — 스케줄이 checkout하는 브랜치 ≠ 대조해야
    할 정본). 지금까지는 dev 서비스도 main 기준으로 대조돼 «거짓 빨강»이 났다(develop에만
    있는 allowlist 수정이 반영 안 됨, PR#2678 실사례).

    ⛔이 함수 자체는 여전히 «한 checkout 루트»(`_REPO_ROOT`, 이 파일이 실제로 놓인 위치)만
    본다 — 두 브랜치를 한 프로세스에서 동시에 보는 게 아니라, 워크플로우가 **브랜치별로
    이 스크립트를 두 번 따로 실행**(각각 그 브랜치의 checkout 안에 있는 이 파일을 부른다
    — `_find_repo_root`가 그 checkout의 `.git`을 찾으므로 자동으로 맞는 루트가 잡힌다)하고,
    `only_env`로 자기 브랜치가 담당하는 환경의 서비스만 걸러 그 서비스만 검사한다."""
    excluded_axes, allowlist_services = _load_allowlist()
    iac_keys = _iac_covered_keys()
    settings_field_keys = _settings_field_env_keys()
    settings_exempt = _load_settings_exempt()
    web_reads = _web_env_reads()  # ⑤ — repo 정적 스캔, 서비스 루프 밖(반복 파일 IO 방지)
    code_read_exempt = _load_code_read_exempt()
    code_read_baseline = _load_code_read_high_baseline()
    today = _today()

    # ⑥ story #2305 — 순수 정적 대조(라이브 서비스 열거 불필요), 루프 밖에서 한 번만.
    service_subset_violations = (
        _service_subset_wellformed_violations() + _external_iac_wellformed_violations()
    )

    live_services = _list_live_services()
    if only_env is not None:
        live_services = [s for s in live_services if _env_for_service(s) == only_env]
    key_set_failures: list[str] = []
    value_check_failures: list[str] = []
    secret_shape_failures: list[str] = []
    settings_coverage_report: list[str] = []  # ④ report-only — FAIL 집합에 안 넣음(위 docstring).
    code_read_highest_failures: list[str] = []  # ⑤㉡ — FAIL 집합에 들어감(오늘 실제 사고 등급).
    code_read_baseline_escalations: list[str] = []  # ⑤㉠ baseline 밖(신규/만료) — FAIL 집합.
    code_read_baseline_ok_count = 0  # ⑤㉠ baseline 안(알려진 채무) — report-only, 매번 카운트만.
    code_read_report: list[str] = []  # ⑤㉢ — report-only(환경무관, 승격 대상 아님).
    unmapped: list[str] = []

    env_label = f"[{only_env}] " if only_env else ""
    checked = 0
    value_checked = 0
    for service in live_services:
        envs = _live_env_entries(service)

        # ⑤ 코드가 읽는데 아무도 안 주는 값 — apps/web을 구동하는 서비스만.
        # ⛔전역 iac_keys가 아니라 이 서비스 전용 IaC 커버리지를 쓴다(위 함수 docstring 참고 —
        # 전역이면 FIREBASE_BFF_INTERNAL_SECRET류가 "backend 스크립트에 있으니 커버됨"으로
        # 잘못 판정된다).
        if service in _WEB_CODE_SERVICES:
            live_keys_for_web = {e["name"] for e in envs}
            covered = _iac_covered_keys_for_service(service) | live_keys_for_web
            highest, high, low = _unsupplied_code_read_findings(web_reads, covered, code_read_exempt)
            if highest:
                code_read_highest_failures.append(
                    f"{service}: {', '.join(line for _, line in highest)}"
                )
            # ⭐파울로군 지시(2026-07-28) — ㉠을 영원히 report-only로 두면 없는 가드가 된다.
            # baseline(known, self-expiring)에 없는 신규 ㉠만 FAIL로 승격한다.
            baseline_ok, escalate = _split_high_by_baseline(high, code_read_baseline, today)
            code_read_baseline_ok_count += len(baseline_ok)
            if escalate:
                code_read_baseline_escalations.append(f"{service}: {', '.join(escalate)}")
            if low:
                code_read_report.append(
                    f"{service}[㉢환경무관]: {', '.join(line for _, line in low)}"
                )

        # ③ 평문 시크릿 형태 검출 — excluded_services 여부와 무관하게 전 서비스에 적용.
        secret_hits = _plain_secret_shaped_keys(envs)
        if secret_hits:
            secret_shape_failures.append(f"{service}: {', '.join(sorted(secret_hits))}")

        # ④ Settings 커버리지(story #2135, report-only) — Settings 소비 서비스만.
        if service in _SETTINGS_CONSUMING_SERVICES:
            live_keys_for_settings = {e["name"] for e in envs}
            unrecognized = sorted(
                live_keys_for_settings - settings_field_keys - set(settings_exempt)
            )
            if unrecognized:
                settings_coverage_report.append(f"{service}: {', '.join(unrecognized)}")

        # ② 값 대조 — DRY_RUN 지원 스크립트 매핑이 있는 서비스만.
        if service in _SERVICE_DRY_RUN_MAP:
            skip_keys = {
                entry["key"] for entry in allowlist_services.get(service, {}).get("keys", [])
                if entry.get("value_check") == "skip"
            }
            script_rel, env_arg = _SERVICE_DRY_RUN_MAP[service]
            expected = _dry_run_env_vars_spec(script_rel, env_arg)
            live_plain = _live_plain_env_values(envs)
            value_checked += 1
            mismatched = sorted(
                key for key, exp_val in expected.items()
                if key not in skip_keys and key in live_plain and live_plain[key] != exp_val
            )
            if mismatched:
                value_check_failures.append(f"{service}: {', '.join(mismatched)}")

        # ①키집합 대조 — 축별 제외(key_set) 대상이면 스킵.
        if "key_set" in excluded_axes.get(service, set()):
            continue
        if service not in _SERVICE_SCRIPT_MAP:
            unmapped.append(service)
            continue

        checked += 1
        live_keys = {e["name"] for e in envs}
        allowed_keys = {
            entry["key"] for entry in allowlist_services.get(service, {}).get("keys", [])
        }
        covered = iac_keys | allowed_keys
        missing = sorted(live_keys - covered)
        if missing:
            key_set_failures.append(f"{service}: {', '.join(missing)}")

    if unmapped:
        key_set_failures.append(
            "매핑 안 된 신규 서비스(⛔ _SERVICE_SCRIPT_MAP·excluded_services(key_set축) "
            "어느 쪽에도 없음 — gcloud 열거엔 잡히니 무시된 게 아니라 분류가 안 된 것): "
            + ", ".join(unmapped)
        )

    # ⚠️story #2296 후속 자체 발견 — ④(settings_coverage_report)가 "report-only"라는 docstring과
    # 달리, 원래 코드는 이 값이 하나라도 있으면 아래 블록에 들어가 무조건 `return 1`로
    # 떨어지는 latent 버그였다(triage 직후라 지금까지 값이 늘 0이라 안 드러났을 뿐).
    # ⑤㉠㉢도 같은 성질(report-only)로 설계하는 참이라 그대로 물려받으면 안 됨 — FAIL 판정과
    # report-only 판정을 여기서 명시적으로 분리한다.
    has_fail = bool(
        key_set_failures or value_check_failures or secret_shape_failures
        or code_read_highest_failures or code_read_baseline_escalations
        or service_subset_violations
    )
    has_report_only = bool(settings_coverage_report or code_read_report)

    # story #2422 — 나흘째 FAIL이었는데 아무도 못 알아챈 원인: 매일 같은 모양의 알림이
    # "어제와 같은 실패"인지 "새 실패"인지 말해 주지 않았다(빨강이 배경음이 되는 병 —
    # 초록이 알리바이가 되는 것의 반대편). 이 FAIL 집합(has_fail을 만드는 바로 그 목록들)의
    # 안정적인 지문을 남겨 워크플로우가 어제 지문과 대조할 수 있게 한다 — report-only
    # 항목은 지문에 안 넣는다(FAIL 판정과 무관한 축이 바뀌었다고 "새 실패"로 오판하면 안 됨).
    _write_state_file(
        key_set_failures + value_check_failures + secret_shape_failures
        + code_read_highest_failures + code_read_baseline_escalations
        + service_subset_violations,
        only_env=only_env,
    )

    # ⭐파울로군 지시 ③ — baseline 수를 «매번» 찍는다(FAIL이든 성공이든 무관). baseline을
    # 묻어두는 곳으로 쓰지 않으려면 그 크기가 줄어드는지 매 실행 눈에 보여야 한다.
    print(
        f"⑤㉠ baseline(known, self-expiring): {code_read_baseline_ok_count}건 "
        f"— infra/manual-env-allowlist.yml의 code_read_high_baseline 참고"
    )

    if has_fail or has_report_only:
        print(
            f"{env_label}❌ env 드리프트 발견:" if has_fail
            else f"{env_label}⚠️ env 드리프트 report-only 발견(FAIL 아님):"
        )
        if key_set_failures:
            print("  ①키집합 대조:")
            for line in key_set_failures:
                print(f"    - {line}")
        if value_check_failures:
            print("  ②값 대조(⛔ 값은 출력하지 않음 — 키 이름만, 스크립트 계산값 ≠ 라이브):")
            for line in value_check_failures:
                print(f"    - {line}")
        if secret_shape_failures:
            print("  ③평문 시크릿 형태 검출(⛔ 값은 출력하지 않음 — 키 이름만):")
            for line in secret_shape_failures:
                print(f"    - {line}")
        if service_subset_violations:
            print(
                "  ⑥서비스명 부분집합 wellformed(story #2305) — 마스터(_SERVICE_SCRIPT_MAP)에\n"
                "    없는 유령 이름이 부분집합 목록 또는 외부 IaC에 들어왔다:"
            )
            for line in service_subset_violations:
                print(f"    - {line}")
        if code_read_highest_failures:
            print(
                "  ⑤㉡코드가 읽는데 아무도 안 주는 값(기본값이 dev/localhost/test — "
                "prod에서 다른 환경을 가리키는 그 사고 형태, 2026-07-28 실사고):"
            )
            for line in code_read_highest_failures:
                print(f"    - {line}")
        if code_read_baseline_escalations:
            print(
                "  ⑤㉠코드가 읽는데 아무도 안 주는 값 — baseline 밖(신규 또는 만료, FAIL):"
            )
            for line in code_read_baseline_escalations:
                print(f"    - {line}")
        if code_read_report:
            print("  ⑤㉢코드가 읽는데 아무도 안 주는 값(환경무관 상수 — report-only, FAIL 아님):")
            for line in code_read_report:
                print(f"    - {line}")
        if settings_coverage_report:
            print(
                "  ④Settings 커버리지 — 이 키는 IaC가 배포하지만 Settings(app/core/config.py)도\n"
                "    settings_exempt(infra/manual-env-allowlist.yml)도 모른다. 오늘 발견된\n"
                "    REDIS_CONSUME_ENABLED류(pydantic-settings extra=\"ignore\"가 조용히 삼킨)와\n"
                "    같은 결함류일 수 있다:"
            )
            for line in settings_coverage_report:
                print(f"    - {line}")
        else:
            # story #2135 후속(2026-07-24, 오르테가 지적) — 다른 축이 FAIL이어도 ④ 자체는
            # "돌았고 통과했다"를 눈에 보이게 남긴다. 안 그러면 "④가 실행은 됐나"를 출력만
            # 보고는 알 수 없다 — 오늘 반복된 그 계열(성공이 관측 안 되면 성공했는지 모른다).
            print(
                f"  ④Settings 커버리지 — 이상 없음"
                f"({len(_SETTINGS_CONSUMING_SERVICES)}개 서비스 검사·미커버 0건)."
            )
        print(
            "\n→ ①은 파이프라인(cloudbuild.yaml/deploy_*.sh)에 편입하거나 "
            "infra/manual-env-allowlist.yml에 사유와 함께 등재. "
            "②는 스크립트 재실행 시 라이브 값을 되돌릴 위험 — 스크립트를 라이브에 맞게 "
            "고치거나 의도적이면 allowlist에 `value_check: skip`+사유로 등재. "
            "③은 즉시 Secret Manager secretKeyRef로 전환 바라는(평문 유지 시 재확定 시마다 재발). "
            "④는 (a) 플랫폼/런타임 주입 → settings_exempt 등재(어느 파일이 읽는지 명시), "
            "(b) 진짜 무효 배선 → 제거 또는 Settings 필드 추가, (c) 이름만 다른 alias → "
            "Settings 필드명 자체를 그 이름에 맞게 정정. "
            "⑤㉡은 즉시 그 서비스에 실제 값을 채우는 것(오늘 사고와 동일 형태 — 방치하면 그 "
            "환경을 가리키는 채로 조용히 돈다). ⑤㉠ baseline 밖(신규/만료)은 (a) 값을 채우거나 "
            "(b) 정상이면 code_read_high_baseline에 reason/declared_by/until(최대30일)과 "
            "함께 등재하거나 (c) 영구 정상이면 code_read_exempt로 승격 — 셋 다 "
            "infra/manual-env-allowlist.yml. ⑤㉢은 report-only(승격 대상 아님). "
            "⑥은 오타면 그 자리에서 고치고, 정말 새 서비스면 _SERVICE_SCRIPT_MAP(마스터)에 "
            "먼저 추가한 뒤 필요한 부분집합에 편입."
        )
        if not has_fail:
            print("\n(⛔위는 report-only 항목뿐 — FAIL 아님. exit code는 0.)")
        else:
            return 1

    print(
        f"{env_label}✅ 드리프트 없음(FAIL 기준) — ①{checked}개 서비스 키집합"
        f"(제외 {sum(1 for a in excluded_axes.values() if 'key_set' in a)}개), "
        f"②{value_checked}개 서비스 값 대조, "
        f"③{len(live_services)}개 서비스 전체 평문시크릿 스캔 완료(제외 없음), "
        f"④{len(_SETTINGS_CONSUMING_SERVICES)}개 서비스 Settings 커버리지 대조 완료, "
        f"⑤{len(_WEB_CODE_SERVICES & set(live_services))}개 서비스 코드읽기↔공급 대조 완료"
        f"(㉡최고위험 대조 포함), "
        f"⑥서비스명 부분집합 wellformed(마스터 {len(_SERVICE_SCRIPT_MAP)}개 기준) + "
        f"외부 IaC 대조 완료."
    )
    return 0


def _parse_only_env(argv: list[str]) -> str | None:
    """`--only-env dev|prod` — 없으면 None(모든 서비스, 옛 동작 그대로 보존). argparse를 안
    쓴 이유: 이 스크립트는 이 플래그 하나뿐이라 의존성을 늘릴 이유가 없다."""
    if "--only-env" not in argv:
        return None
    idx = argv.index("--only-env")
    if idx + 1 >= len(argv):
        raise SystemExit("--only-env 뒤에 dev 또는 prod가 와야 함")
    value = argv[idx + 1]
    if value not in ("dev", "prod"):
        raise SystemExit(f"--only-env는 dev 또는 prod만 허용(받은 값: {value!r})")
    return value


def _run_cli(argv: list[str]) -> int:
    """CLI 진입점 — story #2821 축③. `_write_state_file`은 `main()`이 정상 완주해야만
    불린다 — 이번 None-크래시처럼 루프 중간에 죽으면 그날의 state 파일이 아예 안 남고,
    `compare_env_drift_state.py`가 "파일 없음"을 fail_lines=[]로 읽어 Discord 알림이
    "상세 없음(호출 경로 오류 의심)"으로 나간다(실측 확認 — 이번 사고가 정확히 이 경로로
    그 문구를 냈다. 별도 결함이 아니라 위 None-크래시와 같은 근본원인).

    한 번 이 구멍을 실측했으니, 다음에 «다른» 미처리 예외가 나도 같은 증상(진단 불가한
    침묵)이 재발하지 않게 최상위에서 잡아 예외 자체를 state 파일에 진단명으로 남기고
    다시 던진다 — exit code·CI FAIL 판정(GHA가 트레이스백을 그대로 보므로)은 그대로다."""
    only_env = _parse_only_env(argv)
    try:
        return main(only_env=only_env)
    except Exception as exc:
        _write_state_file(
            [f"⚠️ check_env_drift.py 크래시(스크립트 결함 — 즉시 조사 필요): {type(exc).__name__}: {exc}"],
            only_env=only_env,
        )
        raise


if __name__ == "__main__":
    sys.exit(_run_cli(sys.argv[1:]))

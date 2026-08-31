#!/usr/bin/env python3
"""story #3140 — cloudbuild.yaml/배포 스크립트가 참조하는 **시크릿명**(Secret Manager 리소스
이름, 값 아님) 전수 추출. 이 모듈은 «참조하는 이름이 뭔지»만 안다 — 그 이름이 GCP에 실재하는지는
모른다(그건 소비자 몫: check_cloudbuild_secret_manifest.py=manifest 대조·
sync_cloudbuild_secret_manifest.py=GCP 실물 대조).

## 배경(#3140 발견, 카디르 QA #3547)
기존 가드(test_deploy_env.py 등 132건+AST 5종)는 `--set-secrets=`/`--update-secrets=` 플래그
"구조"(additive냐 전체교체냐 등)만 본다 — 그 안에 든 시크릿 **이름**이 오탈자여도 전부 통과한다.
이 모듈이 그 이름을 처음으로 한곳에 모은다.

## 소스 3갈래(전부 합쳐야 전수)
① cloudbuild.yaml 자체에 인라인으로 박힌 `--update-secrets=`/`SECRETS_FLAG=`(예: PgBouncer
   스왑 스텝, #3110) — 정규식으로 직접 추출.
② backend/scripts/deploy_backend.sh·deploy_frontend.sh·provision_migrate_job.sh가 내부에서
   조립하는 SECRETS_SPEC/ALEMBIC_SECRET_NAME — 이미 검증된 DRY_RUN 경로(test_deploy_env.py가
   132건 중 다수를 이 경로로 이미 태운다)를 그대로 재사용해 직접 실행+파싱한다(회귀 0, 병렬
   구현 안 만듦).
③ cloudbuild.yaml 안에서 시크릿명 자체가 쉘 변수(`$${VAR}`)로 간접 참조되는 극소수 자리
   (예: `AGENT_KEY_SECRET`) — 같은 파일 안의 `VAR="LITERAL"` 대입을 찾아 해석한다. 못 찾으면
   **조용히 버리지 않고** unresolved로 반환(호출부가 red로 만들지 declare 할지 결정).

## ④(story #3549 QA 후속, story #9d1fde0c) — `backend/scripts/deploy_realtime_gce.sh`
`cloudbuild.yaml`(deploy-realtime-gce 스텝, ~L872)이 호출하는 이 스크립트는 시크릿을
②의 SECRETS_SPEC류 단순 `KEY=NAME:latest` 조립이 아니라 GCE startup-script 안에 임베드된
**base64 fetch-secrets 블록**(story #3071 하드닝 산출물)으로 다룬다 — ②의 `_names_from_spec()`
포맷과 안 맞아 별도 파서가 필요했다.

⛔`SECRET_PAIRS=` DRY_RUN 출력 줄(이미 평문·바로 파싱 가능해 보이는 요약 변수)을 직접 읽지
않는다 — 이 스크립트 자체의 주석(L610-616, story #2142)이 이미 경고한 함정과 같은 클래스:
요약 변수와 실제 생성된 산출물(startup-script에 박히는 `_secret_names=(...)` 배열 리터럴)이
갈라질 수 있다. `GENERATED_FETCH_SECRETS_BLOCK_B64`(진짜 생성된 fetch-secrets.sh 블록 그
자체, story #3071이 이미 이 원칙으로 이 변수를 만들어 둠)를 디코드해 그 안의 배열 리터럴을
읽는다 — "진짜 배포될 것"을 검증하는 이 파일의 다른 두 소스(①②)와 같은 신뢰 수준.
"""
from __future__ import annotations

import base64
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


def _find_repo_root(start: Path) -> Path:
    """check_env_drift.py의 동형 함수와 같은 원칙 — 표식(.git)으로 찾고, 못 찾으면 즉시 실패."""
    cur = start.resolve()
    for _ in range(20):
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    raise RuntimeError(f"repo root(.git 표식)를 {start} 위로 못 찾음")


_REPO_ROOT = _find_repo_root(Path(__file__).resolve().parent)
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"
_SCRIPTS_DIR = _REPO_ROOT / "backend" / "scripts"

# story #3140 — 이 모듈이 정적으로 못 보는 시크릿 소스를 명시 선언한다(조용히 완전한 척 안
# 함). story #9d1fde0c에서 deploy_realtime_gce.sh 커버리지가 선언→실제 파서로 승격됐다 —
# 지금은 빈 사전이지만, 다음에 이 모듈이 또 못 보는 소스가 생기면 여기 등재하는 관례는 유지.
_DECLARED_UNCOVERED_SCRIPTS: dict[str, str] = {}

# ①: `KEY=VALUE:latest`류 안의 VALUE. VALUE는 리터럴 시크릿명 또는 `$${VAR}`/`${VAR}` 참조 —
# group(1)="$"가 하나라도 있으면 변수참조(③ 해석 필요), group(2)=이름 본체. `KEY=`가 존재하는
# «시크릿 바인딩 자리»만 잡는다 — cloudbuild substitution(`${_FOO}`, 소문자+언더스코어 접두
# 관례)은 이 자리에 오면 같이 잡히지만 ③ 해석 단계에서 리터럴을 못 찾으면 unresolved로 넘어가
# 조용히 사라지지 않는다.
#
# ⚠️PO 페드루 리뷰 지적(PR #3549) — GCP Secret Manager 시크릿명은 대문자 SNAKE_CASE만이
# 아니다(manifest 실물의 `cron-secret`·`github-app-webhook-secret-dev` 등 kebab-case 10건).
# 문자군에 `-`가 없으면 이런 이름은 `:latest` 직전에서 매치 자체가 안 끊겨 정규식이 그 자리를
# 통째로 건너뛴다 — resolved도 unresolved도 아닌 **완전 침묵**(가장 나쁜 실패 모드, 가드가
# 못 보는 줄도 모르게 됨). 대문자/소문자/대시/언더스코어 전부 허용하도록 문자군을 넓힌다.
_SECRET_BINDING_RE = re.compile(
    r"[A-Za-z0-9_]+=(\$+)?\{?([A-Za-z_][A-Za-z0-9_-]*)\}?:(?:latest|[0-9]+)"
)


def extract_cloudbuild_inline_refs(cloudbuild_text: str | None = None) -> tuple[set[str], set[str]]:
    """①+③: cloudbuild.yaml 인라인 시크릿 바인딩. (resolved 이름 집합, unresolved 토큰 집합) 반환.

    리터럴 vs 변수참조 판별은 대소문자 모양이 아니라 **`$` 접두 유무**로만 가른다(케밥/스네이크
    양쪽 다 `$` 없이 그 자리에 오면 리터럴 시크릿명 그 자체) — PR #3549 리뷰 지적 fix: 예전엔
    `[A-Z][A-Z0-9_]*` fullmatch로 "대문자 모양"을 리터럴 판정 기준으로 썼는데, 그러면 kebab-case
    리터럴(`github-app-webhook-secret-dev`)이 이 fullmatch에 안 걸려 «변수 이름»으로 오인되고,
    당연히 그런 이름의 셸 대입은 없으니 unresolved로도 못 가고(애초에 정규식 charset이 `-`를
    안 받아 매치 지점 자체가 안 생김) 조용히 사라졌다."""
    text = cloudbuild_text if cloudbuild_text is not None else _CLOUDBUILD_YAML.read_text()
    resolved: set[str] = set()
    unresolved: set[str] = set()
    for dollar_prefix, token in _SECRET_BINDING_RE.findall(text):
        if not dollar_prefix:
            # `$` 접두 없음 = 변수 참조가 아니라 리터럴 시크릿명 그 자체(대문자든 kebab-case든
            # 무관) — 그대로 채택.
            resolved.add(token)
            continue
        # `$`(`$$`) 접두 = 변수 참조(예: `$${AGENT_KEY_SECRET}`) — 같은 파일에서 대입 탐색.
        candidates = _resolve_var(token, text)
        if candidates:
            resolved |= candidates
        else:
            unresolved.add(token)
    return resolved, unresolved


# ③: 같은 파일 안에서 `VAR="LITERAL"` 또는 `VAR='LITERAL'` 대입(조건 분기로 여러 번 있을 수
# 있음 — 전부 수집). LITERAL도 위와 동형으로 대문자/소문자/대시/언더스코어 전부 허용한다.
def _resolve_var(var_name: str, text: str) -> set[str]:
    pattern = re.compile(rf'{re.escape(var_name)}\s*=\s*["\']([A-Za-z_][A-Za-z0-9_-]*)["\']')
    return set(pattern.findall(text))


def _dry_run_spec(script_name: str, env: str, key: str) -> str | None:
    """②: backend/scripts/*.sh를 DRY_RUN=1로 직접 실행 — test_deploy_env.py의 `_resolve()`와
    동형(병렬 구현 아님, 같은 검증된 경로 재사용). 스크립트가 실패하면(로컬에 없는 등) None —
    호출부가 "이 소스는 못 봤다"로 명시 처리(조용한 skip 아님, 반환값이 그 신호)."""
    script = _SCRIPTS_DIR / script_name
    if not script.exists():
        return None
    try:
        proc = subprocess.run(
            ["bash", str(script), env],
            capture_output=True, text=True, env={**os.environ, "DRY_RUN": "1"},
            check=True, timeout=10,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    for line in proc.stdout.strip().splitlines():
        if line.startswith(f"{key}="):
            return line[len(key) + 1:]
    return None


def _names_from_spec(spec: str) -> set[str]:
    """`KEY=NAME:latest,KEY2=NAME2:latest` 형태(SECRETS_SPEC류) → {NAME, NAME2}."""
    names: set[str] = set()
    for entry in spec.split(","):
        if "=" not in entry:
            continue
        _key, _, rest = entry.partition("=")
        name = rest.split(":", 1)[0].strip()
        if name:
            names.add(name)
    return names


def extract_script_refs() -> set[str]:
    """②: deploy_backend.sh·deploy_frontend.sh(dev+prod SECRETS_SPEC)·
    provision_migrate_job.sh(dev+prod ALEMBIC_SECRET_NAME)."""
    names: set[str] = set()
    for env in ("dev", "prod"):
        for script, key in (
            ("deploy_backend.sh", "SECRETS_SPEC"),
            ("deploy_frontend.sh", "SECRETS_SPEC"),
        ):
            spec = _dry_run_spec(script, env, key)
            if spec:
                names |= _names_from_spec(spec)
        alembic = _dry_run_spec("provision_migrate_job.sh", env, "ALEMBIC_SECRET_NAME")
        if alembic:
            names.add(alembic)
    return names


# story #9d1fde0c — 디코드된 fetch-secrets 블록 안의 `_secret_names=( 'a' 'b' ... )` 배열
# 리터럴만 뽑는다(다른 배열도 있을 수 있어 이름으로 앵커). single-quote 리터럴 파싱이라
# 배포 스크립트 자신의 생성 관례(L533-542, 항상 단일따옴표로 감쌈)를 그대로 신뢰한다.
_SECRET_NAMES_ARRAY_RE = re.compile(r"_secret_names=\(([^)]*)\)")


def _extract_secret_names_from_fetch_block(decoded_block: str) -> set[str]:
    match = _SECRET_NAMES_ARRAY_RE.search(decoded_block)
    if not match:
        return set()
    names = set(re.findall(r"'([^']*)'", match.group(1)))
    # `__AR_TOKEN__`은 Secret Manager 시크릿이 아니라 fetch-secrets.sh 내부 sentinel(이
    # 이름이 오면 gcloud auth print-access-token으로 분기, story #3071 L524) — manifest
    # 대조 대상이 아니라서 제외(넣으면 "manifest에 없는 시크릿" 오탐이 뜬다).
    names.discard("__AR_TOKEN__")
    return names


def extract_realtime_gce_secret_refs() -> set[str]:
    """④: `deploy_realtime_gce.sh`(dev+prod) — GENERATED_FETCH_SECRETS_BLOCK_B64(story #3071
    하드닝, "진짜 생성된 산출물" 원칙)를 디코드해 그 안의 `_secret_names=(...)` 배열을 읽는다.
    ②(`_dry_run_spec`)와 동일 DRY_RUN 경로 재사용(병렬 구현 아님) — script/key만 다르다."""
    names: set[str] = set()
    for env in ("dev", "prod"):
        b64 = _dry_run_spec("deploy_realtime_gce.sh", env, "GENERATED_FETCH_SECRETS_BLOCK_B64")
        if not b64:
            continue
        decoded = base64.b64decode(b64).decode("utf-8", errors="replace")
        names |= _extract_secret_names_from_fetch_block(decoded)
    return names


@dataclass
class SecretRefs:
    resolved: set[str] = field(default_factory=set)
    unresolved: set[str] = field(default_factory=set)


def extract_all_secret_refs() -> SecretRefs:
    """전수 추출 진입점 — ①②③④ 전부 합친다. `resolved`=대조 가능한 이름 전체,
    `unresolved`=시크릿 바인딩 자리이긴 한데 정적으로 리터럴을 못 찾은 토큰(가드가 못 잡는
    것으로 별도 선언 — 지어내지 않는다)."""
    inline_resolved, unresolved = extract_cloudbuild_inline_refs()
    script_resolved = extract_script_refs()
    realtime_gce_resolved = extract_realtime_gce_secret_refs()
    return SecretRefs(resolved=inline_resolved | script_resolved | realtime_gce_resolved, unresolved=unresolved)

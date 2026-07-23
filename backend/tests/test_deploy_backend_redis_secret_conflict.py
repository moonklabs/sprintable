"""story #2141(E-ARCH, 2026-07-23): cloudbuild.yaml deploy-backend REDIS_URL env/secret 충돌 방지.

Cloud Build 스텝은 DRY_RUN 모드가 없어(gcloud CLI 스크립트와 다름) deploy_realtime_gce.sh류
DRY_RUN 검증을 그대로 못 쓴다 — 대신 ENV_VARS 조립 로직을 cloudbuild.yaml에서 그대로 추출해
독립 실행하고 dev/prod의 REDIS_URL 포함 여부를 검증한다(오르테가 확定 산출물).

⛔story #2421/#2423 배포 실패 핫픽스(2026-07-23, 2건 연속) — 1차: 이 파일의 첫 버전은 추출한
스크립트를 곧바로 bash로 실행해 통과했지만, 실 Cloud Build에는 여기 없는 층이 하나 더 있다:
args 문자열 전체가 먼저 Cloud Build 자신의 substitution 파서를 거친다. 달러중괄호로 셸 변수를
참조하면 Cloud Build가 "유효한 substitution이 아니다"로 build submit 자체를 거부한다(bash가
실행되기도 전) — 셸에서 직접 돌리면 정상 동작하는 것과 완전히 다른 실패 모드라 그 층을 건너뛴
첫 테스트는 이 결함을 못 잡았다.

2차(더 지독한 재발) — 1차 수정 직후 정적 가드 테스트를 추가했는데, 그 테스트가 "주석 줄은
스캔에서 제외"라는 규칙을 넣었다(자기 자신의 설명 주석이 예시로 문제의 표기를 언급하는 것까지
코드로 오인해 실패하는 것을 막으려던 의도). 그런데 실제 Cloud Build 파서는 args 문자열 전체를
그냥 문자열로 훑을 뿐 bash 주석 여부를 전혀 가리지 않는다 — 그래서 그 사고를 "설명하는" 주석
문장 자신이 예시로 그 표기를 그대로 써서 실제로 build submit을 다시 거부시켰다(계측기가 실제
Cloud Build보다 관대했던 것 — 테스트가 모델링한 계층과 실제 계층이 어긋난 전형적인 형태).
⇒ 주석 제외 규칙을 제거했다 — Cloud Build가 안 가리니 테스트도 안 가려야 한다.

`_apply_cloudbuild_escaping()`이 `$$`→`$` 치환 층을 재현하고,
`test_deploy_backend_no_unescaped_shell_vars_in_cloudbuild_substitution_syntax`가(주석 포함
전문 스캔으로) 회귀를 원천 차단한다(추출한 스크립트를 실행하지 않고 정적으로 스캔 — 셸
계층과 무관).
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"

# cloudbuild.yaml 최상위 substitutions: 블록에 선언된 키 + GCP 내장 substitution.
# story #2421 핫픽스 테스트가 이 목록 밖의 `${...}` 참조를 전부 "이스케이프 안 된 셸 변수"로 간주한다.
_DECLARED_SUBSTITUTIONS = {
    "_AR_REGION", "_AR_REPO", "_DEPLOY_ENV", "_FASTAPI_URL", "_BACKEND_MIN_INSTANCES",
    "_BACKEND_MAX_INSTANCES", "_BACKEND_TIMEOUT", "_REALTIME_MIN_INSTANCES",
    "_REALTIME_MAX_INSTANCES", "_REALTIME_TIMEOUT", "_REALTIME_URL", "_FRONTEND_TIMEOUT",
    "_BACKEND_PG_LISTEN_ENABLED", "_BACKEND_REDIS_CONSUME_ENABLED",
    "_BACKEND_REDIS_DISPATCH_ENABLED", "_BACKEND_REDIS_DUAL_PUBLISH_ENABLED", "_REDIS_URL",
    "_BACKEND_FANOUT_WAKE_REDIS_ENABLED", "_SSE_MULTIPLEX_ENABLED",
    "PROJECT_ID", "PROJECT_NUMBER", "BUILD_ID", "COMMIT_SHA", "SHORT_SHA",
    "REPO_NAME", "BRANCH_NAME", "TAG_NAME", "REVISION_ID", "LOCATION",
}


def _extract_deploy_backend_script() -> str:
    """cloudbuild.yaml의 deploy-backend 스텝 bash 스크립트 본문을 그대로 추출(원문 그대로 — $$ 이스케이프 미처리)."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-backend")
    assert step["entrypoint"] == "bash", "deploy-backend가 더 이상 bash entrypoint가 아님 — 이 테스트 갱신 필요"
    # args: ["-c", "<script>"]
    return step["args"][1]


def _apply_cloudbuild_escaping(script: str) -> str:
    """Cloud Build가 args 문자열을 bash에 넘기기 前 수행하는 `$$` → `$` 치환을 재현.

    story #2421 교훈 — 이 전처리 없이 원문을 바로 bash에 넘기면 `$$`(bash에서 PID로 해석)가
    남아 실제 배포와 다르게 동작한다. 이 함수가 그 간극을 메운다.
    """
    return script.replace("$$", "$")


def _run_env_vars_assembly(deploy_env: str, redis_url: str) -> str:
    """실제 gcloud 호출부만 잘라내고 ENV_VARS 조립 로직까지만 실행 — 실제 배포 없이 결과 문자열만 얻는다."""
    script = _apply_cloudbuild_escaping(_extract_deploy_backend_script())
    # 실제 gcloud run deploy 호출 라인 이후는 잘라내고 ENV_VARS를 echo하도록 붙인다.
    # ⚠️"gcloud run deploy"만으로 찾으면 그 문구를 언급하는 주석(설명 문장)에 먼저 매치된다 —
    # 실제 호출부에만 있는 서비스명까지 포함해 정확히 그 라인을 찾는다.
    marker = "gcloud run deploy sprintable-backend"
    idx = script.index(marker)
    assembly_only = script[:idx] + '\necho "RESULT_ENV_VARS=${ENV_VARS}"\n'

    env = {
        **os.environ,
        "_DEPLOY_ENV": deploy_env,
        "_FASTAPI_URL": "https://example.run.app",
        "_BACKEND_PG_LISTEN_ENABLED": "true",
        "_BACKEND_REDIS_CONSUME_ENABLED": "false",
        "_BACKEND_REDIS_DISPATCH_ENABLED": "false",
        "_BACKEND_REDIS_DUAL_PUBLISH_ENABLED": "false",
        "_BACKEND_FANOUT_WAKE_REDIS_ENABLED": "false",
        "_REDIS_URL": redis_url,
    }
    proc = subprocess.run(
        ["bash", "-c", assembly_only],
        capture_output=True, text=True, env=env, check=True,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("RESULT_ENV_VARS="):
            return line[len("RESULT_ENV_VARS="):]
    raise AssertionError(f"ENV_VARS not found in output: {proc.stdout!r}")


def test_deploy_backend_no_unescaped_shell_vars_in_cloudbuild_substitution_syntax():
    """⭐story #2421/#2423 회귀 방지 핵심 AC — Cloud Build가 build submit 자체를 거부하는 층을 정적으로 잡는다.

    달러중괄호 형태로 스크립트에 등장하는 이름이 cloudbuild.yaml의 substitutions: 선언 또는
    GCP 내장 변수 목록에 없다면, 그건 이스케이프(달러 두 개) 안 된 셸 변수 참조 — 실 Cloud
    Build가 "key ... is not a valid built-in substitution"로 build를 거부한다(부분 배포 없이
    막히지만, dev 파이프라인 전체가 멈춘다 — #2421 실 사고).

    ⛔#2423 재발 교훈 — **주석 줄을 제외하지 않는다.** Cloud Build의 substitution 파서는 args
    문자열 전체를 그냥 문자열로 훑고 bash 주석 여부를 전혀 가리지 않는다. 이전 버전이 주석을
    스캔에서 뺐다가 "이 사고를 설명하는 주석 자신이 그 표기를 예시로 써서 사고를 재현"하는
    것을 놓쳤다 — 그 재발이 이 규칙을 없앤 이유다. 새 주석을 쓸 때도 달러중괄호로 미선언
    이름을 언급하면(설명 목적이라도) 이 테스트가 실패해야 정상이다.
    """
    script = _extract_deploy_backend_script()
    # `$$`(이스케이프)로 시작하는 자리는 실제 셸 변수 참조라 스킵 — `$$` 다음 글자부터 다시 스캔.
    # 정규식으로 `$$` 뒤에 오는 참조는 애초에 매치 대상에서 제외(단일 `$`만 substitution 후보).
    # 주석 포함 스크립트 원문 전체를 스캔한다(주석 제외 금지 — 위 docstring 참조).
    unescaped = re.findall(r"(?<!\$)\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", script)
    unknown = sorted(set(unescaped) - _DECLARED_SUBSTITUTIONS)
    assert not unknown, (
        f"cloudbuild.yaml deploy-backend 스텝에 이스케이프 안 된(달러 두 개 누락) 셸 변수로 "
        f"보이는 미선언 substitution 참조 발견(주석 포함 전문 스캔): {unknown} — 셸 변수라면 "
        f"달러 두 개로 이스케이프할 것. 설명 주석이라도 달러중괄호로 이 이름들을 언급하지 말 것."
    )


def test_deploy_backend_is_bash_entrypoint():
    """story #2141 정정 — env 조건분기를 위해 gcloud 단순 args에서 bash로 전환됐다."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-backend")
    assert step["entrypoint"] == "bash"
    assert "set -euo pipefail" in step["args"][1], "실패 시 배포가 조용히 반쪽 되지 않도록 하는 안전장치 누락"


def test_deploy_backend_dev_includes_plain_redis_url():
    """dev: AUTH 없는 plain Memorystore — 시크릿 바인딩이 없으므로 기존처럼 plain env로 넘긴다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert "REDIS_URL=redis://10.164.120.243:6379" in result


def test_deploy_backend_prod_excludes_plain_redis_url():
    """⭐#2141 핵심 AC — prod는 REDIS_URL을 절대 plain env로 안 넘긴다(Secret Manager 바인딩과
    동명 충돌 방지, 값의 유무와 무관하게 키 자체가 없어야 한다)."""
    result = _run_env_vars_assembly("prod", "")
    assert "REDIS_URL" not in result


def test_deploy_backend_dev_env_vars_unchanged_by_prod_branch():
    """dev 경로 무회귀 — prod 분기 추가가 dev의 다른 필드에 영향을 주지 않는다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert result == (
        "FASTAPI_URL=https://example.run.app,DB_POOL_SIZE=3,DB_MAX_OVERFLOW=1,"
        "PG_LISTEN_ENABLED=true,EVENT_BROKER_REDIS_CONSUME_ENABLED=false,"
        "EVENT_BROKER_REDIS_DISPATCH_ENABLED=false,EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED=false,"
        "FANOUT_WAKE_REDIS_ENABLED=false,REDIS_URL=redis://10.164.120.243:6379"
    )

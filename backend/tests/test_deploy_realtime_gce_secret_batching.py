"""story #3071(재발방지, 2026-08-25) — realtime-gateway GCE startup-script의 시크릿
배치 fetch 회귀가드.

배경: story #3070 그라운딩 — 시크릿 12개+AR 토큰 1개를 매번 별도
`docker run --rm cloud-sdk:slim gcloud ...`로 순차 fetch(컨테이너 13회 개별 기동)하던 것이
신규 서지 VM의 실제 서빙 가능 시점을 3분+로 늘려, MIG 롤링배포(max-surge=zone수·
max-unavailable=0, 설계상 무중단)에도 실측 ~2분 502 창을 만들었다. 컨테이너 기동을
1회로 줄이는 처방(deploy_realtime_gce.sh)의 두 계약을 여기서 고정한다:

①구조: 생성된 startup-script가 실제로 컨테이너 기동을 1회만 쓰는지(docker run 1건).
②동작: NUL(\\0) 구분 재조립이 멀티라인 시크릿(GITHUB_APP_PRIVATE_KEY류 PEM)에서도
  값이 안 섞이고, 각 값이 기존 `$(...)` 개별 fetch와 동일하게 후행 개행만 벗겨진
  채로 정확한 env 변수에 실리는지 — 실 bash 서브프로세스로 스텁 gcloud/docker를 통해
  검증한다(요약이 아니라 생성된 코드 그 자체를 실행).
"""
from __future__ import annotations

import base64
import os
import re
import stat
import subprocess
import tempfile

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DEPLOY_GCE = os.path.join(_SCRIPTS, "deploy_realtime_gce.sh")


def _resolve(env: str) -> dict[str, str]:
    proc = subprocess.run(
        ["bash", _DEPLOY_GCE, env],
        capture_output=True, text=True, env={**os.environ, "DRY_RUN": "1"}, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


def _fetch_secrets_block(env: str = "dev") -> str:
    cfg = _resolve(env)
    return base64.b64decode(cfg["GENERATED_FETCH_SECRETS_BLOCK_B64"]).decode()


# ─── ①구조: 컨테이너 기동 1회(N+1회가 아니라) ─────────────────────────────────

def test_secret_fetch_uses_exactly_one_docker_run_invocation():
    block = _fetch_secrets_block()
    # heredoc(cat > /tmp/fetch-secrets.sh ... FETCH_SECRETS_EOF) 안의 gcloud 호출은
    # 컨테이너 기동이 아니다(컨테이너 「안에서」 도는 프로세스) — 실제 `docker run`
    # 호출 자체만 센다.
    docker_run_calls = re.findall(r"\bdocker run --rm\b", block)
    assert len(docker_run_calls) == 1, f"docker run 호출이 1건이어야 하는데: {docker_run_calls}"


def test_secret_names_array_matches_secret_pairs_order_plus_ar_token():
    cfg = _resolve("dev")
    block = _fetch_secrets_block()
    pair_secret_names = [p.split(":", 1)[0] for p in cfg["SECRET_PAIRS"].split()]
    expected = pair_secret_names + ["__AR_TOKEN__"]

    m = re.search(r"^_secret_names=\(([^)]*)\)", block, flags=re.MULTILINE)
    assert m, "startup-script에 _secret_names 배열이 있어야 한다"
    actual = re.findall(r"'([^']*)'", m.group(1))
    assert actual == expected


def test_secret_env_names_array_matches_secret_pairs_order_plus_ar_token_var():
    cfg = _resolve("dev")
    block = _fetch_secrets_block()
    pair_env_names = [p.split(":", 1)[1] for p in cfg["SECRET_PAIRS"].split()]
    expected = pair_env_names + ["_AR_TOKEN"]

    m = re.search(r"^_secret_env_names=\(([^)]*)\)", block, flags=re.MULTILINE)
    assert m, "startup-script에 _secret_env_names 배열이 있어야 한다"
    actual = re.findall(r"'([^']*)'", m.group(1))
    assert actual == expected


def test_secret_count_mismatch_is_fail_closed():
    """순서가 어긋나 개수가 안 맞으면(예: docker/gcloud 부분 실패) 조용히 진행하지
    않고 명시적으로 죽어야 한다 — «조용한 어긋남보다 배포 중단이 낫다»."""
    block = _fetch_secrets_block()
    assert '"${#_secret_values[@]}" -ne "${#_secret_names[@]}"' in block
    assert "exit 1" in block


# ─── ②동작: NUL 구분 재조립 — 실 bash 서브프로세스, 스텁 gcloud/docker ─────────

_STUB_GCLOUD = """#!/bin/bash
# 테스트 스텁 — 실제 gcloud 대신 알려진 값을 돌려준다. 각 값은 실 Secret Manager
# payload처럼 "그 자체"를 stdout에 낸다(트레일링 개행 유무는 값마다 다르게 둬서
# $(...) 트레일링-개행-스트립 동작이 배치 경로에서도 유지되는지 검증).
if [ "$1" = "auth" ] && [ "$2" = "print-access-token" ]; then
  printf 'stub-ar-token\\n'
  exit 0
fi
# gcloud secrets versions access latest --secret=NAME --project=PROJ
secret_name=""
for arg in "$@"; do
  case "$arg" in
    --secret=*) secret_name="${arg#--secret=}" ;;
  esac
done
case "$secret_name" in
  DATABASE_URL_DEV) printf 'postgresql://u:p@host/db\\n\\n\\n' ;;  # 트레일링 개행 여러 개 — 전부 스트립돼야 함
  github-app-private-key-dev)
    # PEM 멀티라인 — 내부 개행은 절대 깨지면 안 됨(이 테스트의 핵심 대상).
    printf -- '-----BEGIN RSA PRIVATE KEY-----\\nline1\\nline2\\nline3\\n-----END RSA PRIVATE KEY-----\\n'
    ;;
  *) printf 'stub-value-for-%s' "$secret_name" ;;  # 트레일링 개행 아예 없는 값도 커버
esac
"""

_STUB_DOCKER = """#!/bin/bash
# 실 컨테이너 없이 fetch-secrets.sh를 그 자리에서 직접 돈다 — 이 테스트는 "컨테이너를
# 실제로 격리하는가"가 아니라 "생성된 fetch-secrets.sh + 재조립 로직이 올바른가"만
# 본다(컨테이너화 자체는 story #3070/#3071 그라운딩에서 이미 실 배포로 확認됨).
# docker run --rm -e GCP_PROJECT="..." -v /path/fetch-secrets.sh:/fetch-secrets.sh:ro IMAGE bash /fetch-secrets.sh NAME...
# 실 docker는 -e KEY=VALUE를 컨테이너 프로세스 환경에 자동 주입한다 — 스텁도 동일하게
# 그 값을 export해 자식 bash(fetch-secrets.sh)가 $GCP_PROJECT를 받도록 재현한다.
script_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-v" ]; then
    script_path="${arg%%:*}"
  fi
  if [ "$prev" = "-e" ]; then
    export "$arg"
  fi
  prev="$arg"
done
shift_count=0
found_bash=0
args=()
for arg in "$@"; do
  if [ "$found_bash" = "1" ]; then
    if [ "$arg" = "/fetch-secrets.sh" ]; then continue; fi
    args+=("$arg")
  fi
  if [ "$arg" = "bash" ]; then found_bash=1; fi
done
exec bash "$script_path" "${args[@]}"
"""


def test_batched_secret_fetch_preserves_multiline_pem_and_strips_trailing_newlines_only():
    block = _fetch_secrets_block()

    with tempfile.TemporaryDirectory() as tmp:
        stub_bin = os.path.join(tmp, "bin")
        os.makedirs(stub_bin)
        gcloud_path = os.path.join(stub_bin, "gcloud")
        docker_path = os.path.join(stub_bin, "docker")
        with open(gcloud_path, "w") as f:
            f.write(_STUB_GCLOUD)
        with open(docker_path, "w") as f:
            f.write(_STUB_DOCKER)
        os.chmod(gcloud_path, os.stat(gcloud_path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.chmod(docker_path, os.stat(docker_path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        # fetch-secrets.sh 자신은 heredoc이 실제로 /tmp에 쓴다고 가정하지만, 여기선
        # startup-script 전체를 그대로 실행해 그 heredoc이 스스로를 파일로 떨어뜨리게
        # 한다(생성된 코드 자체를 실행 — 재구현 아님). 그 뒤 재조립 결과를 echo로 확인.
        harness = block + "\necho \"__RESULT_DATABASE_URL__=${DATABASE_URL}\"\n"
        harness += "echo \"__RESULT_PEM_BEGIN__\"\n"
        harness += 'printf "%s" "${GITHUB_APP_PRIVATE_KEY}"\n'
        harness += "echo \"__RESULT_PEM_END__\"\n"
        harness += "echo \"__RESULT_AR_TOKEN__=${_AR_TOKEN}\"\n"
        harness += 'echo "__RESULT_JWT__=${JWT_SECRET}"\n'

        proc = subprocess.run(
            ["bash", "-c", harness],
            capture_output=True, text=True,
            env={**os.environ, "PATH": f"{stub_bin}:{os.environ['PATH']}"},
        )
        assert proc.returncode == 0, f"stderr:\n{proc.stderr}\nstdout:\n{proc.stdout}"

        # story #2442류 트레일링 개행 스트립 — 배치 경로도 $(...) 개별 fetch와 바이트 동일해야 함.
        assert "__RESULT_DATABASE_URL__=postgresql://u:p@host/db" in proc.stdout
        assert "postgresql://u:p@host/db\n\n" not in proc.stdout  # 트레일링 개행이 안 남아야 함

        # 멀티라인 PEM — 내부 개행 보존, 다른 시크릿과 안 섞임(NUL 구분의 핵심 증명).
        pem_start = proc.stdout.index("__RESULT_PEM_BEGIN__\n") + len("__RESULT_PEM_BEGIN__\n")
        pem_end = proc.stdout.index("__RESULT_PEM_END__")
        pem_value = proc.stdout[pem_start:pem_end]
        # $(...) 캡처는 모든 시크릿에 대해(멀티라인이어도) 후행 개행만 벗긴다 — 기존
        # per-secret `$(docker run ...)` 캡처와 정확히 동일한 규칙. 내부 개행 3곳은 보존.
        assert pem_value == (
            "-----BEGIN RSA PRIVATE KEY-----\nline1\nline2\nline3\n-----END RSA PRIVATE KEY-----"
        )

        assert "__RESULT_AR_TOKEN__=stub-ar-token" in proc.stdout
        assert "__RESULT_JWT__=stub-value-for-JWT_SECRET" in proc.stdout

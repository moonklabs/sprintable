"""story #3616(라이브 결함, 2026-09-06~07) — realtime-gateway GCE startup-script의
cloud-sql-proxy 재기동 순서 회귀가드.

배경: DB 비밀번호 로테이션 뒤 `rolling-action restart`(재부팅)가 15시간 동안 3대 전부
`cloud-sql-proxy … Unable to mount socket: listen unix /cloudsql/…: bind: address
already in use`로 크래시루프였다. `/mnt/stateful_partition`은 stateful(재부팅에도
보존)이라 이전 부팅의 소켓 파일이 그대로 남아 새 프록시 컨테이너가 그 자리에 bind하지
못했다 — `rolling-action replace`(디스크 재생성)로만 우연히 피해갔을 뿐, startup-script
자체는 restart에 대해 멱등하지 않았다.

이 파일은 생성된 startup-script(DRY_RUN 산출물, `deploy_realtime_gce.sh`의 기존
`GENERATED_*_B64` 관례와 동형)가 실제로 잔존 소켓을 지우는지, 그리고 그 위치가
"컨테이너 제거 후·새 프록시 기동 전"인지(순서가 어긋나면 새 컨테이너가 뜬 뒤에
지워 그 컨테이너 자신의 소켓을 지우는 자기파괴가 됨)를 실 bash 서브프로세스로
검증한다(요약이 아니라 생성된 코드 그 자체)."""
from __future__ import annotations

import base64
import os
import re
import subprocess

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DEPLOY_GCE = os.path.join(_SCRIPTS, "deploy_realtime_gce.sh")


def _resolve(env: str = "dev") -> dict[str, str]:
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


def _cloudsql_proxy_block(env: str = "dev") -> str:
    cfg = _resolve(env)
    return base64.b64decode(cfg["GENERATED_CLOUDSQL_PROXY_BLOCK_B64"]).decode()


def test_stale_socket_dir_removed_before_new_proxy_container_starts():
    """AC1 — 순서: docker rm(옛 컨테이너 제거) → rm -rf(잔존 소켓 정리) → docker run
    (새 컨테이너). 순서가 어긋나면(예: run이 rm -rf보다 먼저) 새로 만든 소켓을 지우는
    자기파괴가 되거나, 여전히 옛 소켓에 막혀 이번 인시던트가 재현된다."""
    block = _cloudsql_proxy_block()
    lines = [ln for ln in block.splitlines() if ln.strip()]

    idx_docker_rm = next(i for i, ln in enumerate(lines) if ln.startswith("docker rm -f cloud-sql-proxy"))
    idx_rm_rf = next(i for i, ln in enumerate(lines) if ln.startswith("rm -rf ") and "cloudsql" in ln)
    idx_docker_run = next(i for i, ln in enumerate(lines) if ln.startswith("docker run -d --name cloud-sql-proxy"))

    assert idx_docker_rm < idx_rm_rf < idx_docker_run, (
        f"순서 위반(회귀) — docker rm={idx_docker_rm}, rm -rf={idx_rm_rf}, "
        f"docker run={idx_docker_run}: {lines}"
    )


def test_stale_socket_cleanup_targets_the_connection_scoped_subdir_not_whole_host_dir():
    """호스트 소켓 dir 전체(`_HOST_SOCKET_DIR`)가 아니라 그 안의 connection-scoped
    서브dir만 지운다 — 전체를 지우면(다른 무관한 상태가 그 자리에 있을 경우) 과도한
    파괴가 될 수 있다. 정확한 경로 형태(`<HOST_DIR>/<SQL_INSTANCE_CONN>`)를 고정한다."""
    cfg = _resolve()
    conn = cfg["SQL_INSTANCE_CONN"]
    block = _cloudsql_proxy_block()

    m = re.search(r'^rm -rf "([^"]+)"$', block, re.MULTILINE)
    assert m, f"rm -rf 라인을 못 찾음: {block}"
    removed_path = m.group(1)
    assert removed_path.endswith(f"/{conn}"), f"connection-scoped 서브dir이 아님: {removed_path}"
    assert removed_path != "/mnt/stateful_partition/cloudsql", "호스트 dir 전체를 지우면 과도한 파괴"


def test_mutation_reordered_rm_rf_after_docker_run_would_fail_the_order_test():
    """뮤테이션 대조 — 위 순서 검사 로직 자체가 실제로 순서 위반을 잡는지, 준비한 가짜
    라인 목록으로 직접 증명한다(레포를 더럽히지 않는다)."""
    fake_lines_wrong_order = [
        "docker rm -f cloud-sql-proxy 2>/dev/null || true",
        "docker run -d --name cloud-sql-proxy --restart=always \\",
        'rm -rf "/mnt/stateful_partition/cloudsql/proj:region:db"',
    ]
    idx_docker_rm = next(i for i, ln in enumerate(fake_lines_wrong_order) if ln.startswith("docker rm -f cloud-sql-proxy"))
    idx_rm_rf = next(i for i, ln in enumerate(fake_lines_wrong_order) if ln.startswith("rm -rf "))
    idx_docker_run = next(i for i, ln in enumerate(fake_lines_wrong_order) if ln.startswith("docker run -d --name cloud-sql-proxy"))
    assert not (idx_docker_rm < idx_rm_rf < idx_docker_run), (
        "이 가짜 순서는 위반이어야 하는데 통과함 — 순서 검사 로직 자체가 무력화됨"
    )

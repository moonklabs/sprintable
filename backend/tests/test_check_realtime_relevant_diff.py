"""story #2089 (a) — check_realtime_relevant_diff.sh 회귀가드.

#2182 그라운딩(2026-08-17)에서 실측: backend 변경 커밋의 75.3%는 realtime이 실제로
참조하는 파일을 안 건드렸는데도 deploy-realtime-gce가 매번 재실행돼 rolling(502 버스트)을
유발했다. 이 스크립트(cloudbuild.yaml deploy-realtime-gce 스텝에서 호출)는 그 판별만
한다 — 순수 git diff 로직이라 임시 git repo만으로 전체 경로(관련 있음/없음/판별불가)를
검증할 수 있다(gcloud 목업 불요, deploy_realtime_gce.sh 자체 테스트들과 다른 축).
"""
from __future__ import annotations

import os
import subprocess

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "check_realtime_relevant_diff.sh")


def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t.com",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t.com"},
    )


def _init_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    for rel in (
        "backend/app/realtime_main.py",
        "backend/app/routers/agent_gateway.py",
        "backend/app/routers/other_unrelated_router.py",
        "apps/web/src/components/unrelated.tsx",
    ):
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("v1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    return repo, base_sha


def _run(repo, from_sha, to_sha="HEAD"):
    return subprocess.run(
        ["bash", _SCRIPT, from_sha, to_sha], cwd=str(repo),
        capture_output=True, text=True,
    )


def test_relevant_path_changed_exits_0_deploy(tmp_path):
    """⭐realtime 전용 파일(agent_gateway.py)이 바뀌면 배포해야 함(exit 0)."""
    repo, base_sha = _init_repo(tmp_path)
    (repo / "backend/app/routers/agent_gateway.py").write_text("v2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch realtime router")

    proc = _run(repo, base_sha)
    assert proc.returncode == 0, f"관련 경로 변경인데 스킵 판정 — stderr={proc.stderr!r}"


def test_irrelevant_path_only_exits_1_skip(tmp_path):
    """⭐realtime과 무관한 파일만 바뀌면 스킵 가능(exit 1) — #2182가 겨눈 그 케이스."""
    repo, base_sha = _init_repo(tmp_path)
    (repo / "backend/app/routers/other_unrelated_router.py").write_text("v2\n")
    (repo / "apps/web/src/components/unrelated.tsx").write_text("v2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch unrelated files only")

    proc = _run(repo, base_sha)
    assert proc.returncode == 1, f"무관 경로만 변경인데 배포 판정 — stderr={proc.stderr!r}"


def test_shared_conservative_path_auth_py_counts_as_relevant(tmp_path):
    """PO 판정(2026-08-17) — 보수적 채택. auth.py(공유 파일)도 realtime-관련으로 잡혀야
    한다(11.1%로 좁히면 stale binary 미탐 위험 — PO가 명시적으로 기각한 선택지)."""
    repo, base_sha = _init_repo(tmp_path)
    (repo / "backend/app/dependencies").mkdir(parents=True, exist_ok=True)
    (repo / "backend/app/dependencies/auth.py").write_text("v1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add auth.py")
    auth_added_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    (repo / "backend/app/dependencies/auth.py").write_text("v2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch auth.py")

    proc = _run(repo, auth_added_sha)
    assert proc.returncode == 0, f"공유 파일(auth.py) 변경인데 스킵 판정 — stderr={proc.stderr!r}"


def test_missing_from_sha_is_fail_safe_deploy(tmp_path):
    """FROM_SHA 미지정 = 판별 불가 — 조용히 스킵하면 안 되고 배포 쪽(exit 0)."""
    repo, _base_sha = _init_repo(tmp_path)
    proc = _run(repo, "")
    assert proc.returncode == 0


def test_unresolvable_from_sha_is_fail_safe_deploy(tmp_path):
    """⭐git diff 자체가 실패하는 경우(옛 SHA가 히스토리에 없음 — 얕은 클론 등)도
    fail-safe로 배포 쪽(exit 0)이어야 한다 — 「필터가 실수로 좁아도 조용히 안 새게」
    라는 PO 요구사항의 핵심 축(스킵은 확실할 때만)."""
    repo, _base_sha = _init_repo(tmp_path)
    proc = _run(repo, "0000000000000000000000000000000000dead")
    assert proc.returncode == 0, f"판별 불가(unresolvable SHA)인데 스킵 판정 — stderr={proc.stderr!r}"

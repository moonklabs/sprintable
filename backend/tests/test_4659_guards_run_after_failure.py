"""story 4659 (PO 08:37Z) — 가드 묶음 잡에서 한 가드가 빨개도 나머지 가드는 다 돈다.

옛 가드는 잡마다 따로 돌았다. 한 묶음 잡에 합치면서 기본 success()가 붙으면 앞 스텝이 실패한 순간
뒤 가드가 전부 건너뛰어 각자 결과가 안 남는다. 그래서 가드 스텝마다 `if: ${{ !cancelled() }}`를 둔다.
잡 자체는 여전히 실패해서 병합이 막힌다. Checkout은 첫 스텝이라 조건 없이 둔다.
"""
import os
import subprocess

import yaml

_CI_YML = os.path.join(os.path.dirname(__file__), "..", "..", ".github", "workflows", "ci.yml")


def test_every_guard_step_still_runs_after_an_earlier_guard_fails():
    with open(_CI_YML) as f:
        ci = yaml.safe_load(f)
    steps = ci["jobs"]["guards"]["steps"]
    unguarded = [s.get("name") for s in steps if s.get("name") != "Checkout" and "!cancelled()" not in str(s.get("if", ""))]
    assert unguarded == [], f"guards steps that would skip after an earlier failure: {unguarded}"


def test_no_guard_step_shallows_the_history_with_a_depth_fetch():
    # 한 스텝의 `git fetch origin <ref> --depth=1`이 .git/shallow 경계를 심으면 뒤의 baseline 스텝
    # merge-base가 공통 조상을 못 찾는다(CI run 38225139375: «merge-base를 못 세웠습니다»). 옛 독립
    # 잡은 각자 checkout을 받아 이 문제가 없었고, 묶음 잡에서는 앞 스텝이 이 경계를 남긴다.
    # 주석 줄은 뺀다 — 실행 줄의 `git fetch … --depth`만 센다.
    with open(_CI_YML) as f:
        ci = yaml.safe_load(f)
    steps = ci["jobs"]["guards"]["steps"]
    shallowing = []
    for s in steps:
        for line in str(s.get("run", "")).splitlines():
            code = line.strip()
            if code.startswith("#"):
                continue
            if "git fetch" in code and "--depth" in code:
                shallowing.append((s.get("name"), code))
    assert shallowing == [], f"guards steps that shallow the history: {shallowing}"


def _tmp_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t.com"}
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True, env=env)
    (repo / "f.txt").write_text("x\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, env=env)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "base"], check=True, env=env)
    return repo


def test_push_before_commit_missing_locally_fails_closed(tmp_path):
    # push 문맥에서 이전 커밋이 로컬에 없으면(강제 push로 사라진 커밋) 통과가 아니라 실패해야 한다.
    # 가드 묶음의 baseline 스텝 4곳 모두 같은 규칙을 따른다 — 실행해서 확인한다.
    import re

    with open(_CI_YML) as f:
        ci = yaml.safe_load(f)
    steps = [s for s in ci["jobs"]["guards"]["steps"] if 'git cat-file -e "${PUSH_BEFORE_SHA}' in str(s.get("run", ""))]
    assert len(steps) == 4, f"expected 4 push-before compare steps, found {len(steps)}"
    repo = _tmp_repo(tmp_path)
    missing = "f" * 40
    for s in steps:
        script = str(s["run"]).replace("${{ github.event.before }}", missing)
        script = re.sub(r"\$\{\{[^}]*\}\}", "", script)
        proc = subprocess.run(["bash", "-c", script], cwd=str(repo), capture_output=True, text=True)
        out = proc.stdout + proc.stderr
        assert proc.returncode != 0 and "fail-closed" in out, (s.get("name"), out)

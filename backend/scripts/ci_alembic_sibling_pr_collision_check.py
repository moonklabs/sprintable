"""story #2401(결함·CI) — alembic 리비전 «형제 PR» 충돌 가드.

배경: #2397(PR #2777·#2781)이 develop 기준 같은 `0221`을 각자 새 리비전으로 만들었다.
기존 게이트(`ci_alembic_single_step_promotion_check.py`, story #2330)는 **자기 브랜치의
alembic.ini만** 읽어 "기존 DB에 head 하나를 얹는" 시나리오를 재현한다 — gh API도, 형제 PR
참조도 없다(2026-08-16 그라운딩에서 코드로 확認: `.qa-worktrees` 등 전 레포 grep 0건). 두
PR 모두 그 게이트를 통과했는데도 dual-head는 머지 «후»에야 드러났다 — 각 PR이 «자기만»
보면 전부 초록이기 때문이다.

이 스크립트는 그 시야를 메운다: 이 PR이 새로 만드는 alembic 리비전이 ①**base 브랜치의
현재(=이 job이 도는 시점) 리비전들** ②**같은 base를 겨냥한 다른 열린 PR들이 새로 만드는
리비전들**과 겹치는지 두 축으로 검사한다.

## 검사 축 (PO 승인, 2026-08-16 — org.moonklabs.work.decision 보강 4)

- **축 A(revision 중복)**: 이 PR의 새 `revision` 값이 base 또는 형제 PR의 어떤 리비전
  값과도 같으면 실패. 판별 정본은 **파일 안 `revision = ...` 값**이다(파일명 4자리 접두가
  아니다) — 파일명과 그 값이 다르면 그 자체도 별도 오류로 잡는다(관례 위반이 조용히
  새어나가면 이 스크립트의 파일명 기반 신규 파일 탐지 자체가 흔들린다).
- **축 B(down_revision 중복 = dual-head)**: revision 값이 서로 달라도, 이 PR과 base/형제
  PR 중 어느 것이든 **같은 down_revision**(=같은 부모)에서 갈라지면 dual-head다(alembic
  `heads`가 head 여러 개로 갈라진다). 이것도 실패.

## 이 가드가 «못 잡는» 것(선언, story #2401 AC4)

- **시간 축**: 이 job이 도는 시점에 아직 «열리지 않은» 형제 PR은 볼 수 없다. 완화책은
  대칭적이다 — 내 PR이 초록으로 먼저 머지된 뒤 형제가 «나중에» 열리면, **형제 쪽 CI가
  자기 축 검사에서 걸린다**(형제가 새로 만들 리비전이 이제 base에 들어간 내 리비전과
  겹치므로 축 A/B가 형제 쪽에서 잡는다) — 즉 "둘 중 나중에 여는/재실행하는 쪽"이 빨간불을
  받는다. 다만 **둘 다 이미 열려 있고 이 job이 각자 그린을 받은 뒤 그대로 머지 순서만
  바뀌는 좁은 창**은 이 job 혼자로는 못 막는다 — **머지 직전 이 잡을 재실행(rerun)** 하는
  것을 권장한다(PO의 "4자 대조 시 낡은 run 주의"와 동일 원리).
- **한 배치 안에서 3개 이상 리비전이 동시에 실리는 상호작용**: #2330 게이트와 동일 한계 —
  이 스크립트는 "새 리비전들의 최종 좌표(revision/down_revision)"만 보고, 그 여러 리비전이
  한 PR 안에서 서로 올바른 체인을 이루는지는 alembic 자체의 `heads` 계산에 맡긴다.
- **`down_revision`이 동적으로 계산되는 경우**(이 코드베이스엔 없음, 정적 리터럴 관례) —
  있다면 AST가 못 읽어 이 스크립트가 조용히 그 리비전을 건너뛴다. 발견 시 별도 처리 필요.
- **GitHub API 페이지네이션/레이트리밋으로 인한 부분 실패** — 이 스크립트는 API 오류 시
  fail-closed(비교 불가 = 통과가 아니라 에러로 종료)한다. 「API가 막혀서 그냥 통과됐다」를
  「검사를 다 마쳤다」로 오해하지 않게 하려는 의도적 선택.

## 사용 (CI 워크플로 계약)

환경변수: `GH_TOKEN`(또는 `GITHUB_TOKEN`, `gh` CLI가 읽음) · `GH_REPO`(`owner/repo`) ·
`PR_NUMBER`(이 PR 번호, 자기 자신을 형제 목록에서 제외하는 데 씀) · `PR_BASE_REF`(base
브랜치명, 예: `develop`). 이 스크립트는 `backend/` 를 working-directory로 실행되고,
`origin/<base>`가 이미 fetch돼 있어야 한다(CI 워크플로가 `git fetch origin <base>` 선행).
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ALEMBIC_REL_DIR = Path("alembic/versions")
FILENAME_REV_RE = re.compile(r"^(\d{4})_.*\.py$")


def _run_git(args: list[str]) -> str:
    """story #2401 hotfix(2026-08-17) — `subprocess.run(check=True)`가 실패하면 Python은
    `CalledProcessError`를 던지는데, `capture_output=True`로 잡힌 stderr는 그 예외의 기본
    `str()`에 안 실린다 — CI 로그엔 "returncode 128"만 남고 «왜»(예: "fatal: no merge base")는
    사라진다. PR #3140 실 CI에서 정확히 이 모양으로 죽었다(shallow-fetch가 심은 경계 때문에
    `git diff origin/develop...HEAD`가 no-merge-base로 실패 — 원인은 워크플로 fetch 스텝에서
    같이 고쳤다). 모든 git 하위명령 호출을 이 헬퍼로 통일해 실패 시 stderr를 명시적으로
    stdout/stderr에 찍은 뒤 fail-closed(exit 2)한다 — `_run_gh_json`이 gh 호출에 이미 쓰는
    것과 같은 관례."""
    result = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"❌ git 호출 실패({' '.join(args)}, exit {result.returncode}):\n{result.stderr}", file=sys.stderr)
        raise SystemExit(2)
    return result.stdout


def _git_root_prefix() -> str:
    """이 스크립트는 backend/를 cwd로 실행되는 계약이지만(위 docstring), git의 몇몇
    하위명령(`show <ref>:<path>`)은 **repo root 기준** 경로를 요구하고 다른 것들
    (`diff --relative`, `ls-tree`는 cwd 기준 pathspec을 주면 cwd 기준으로 출력)은 cwd 기준을
    쓴다 — 이 프리픽스로 둘을 오간다. GitHub API(`pulls/{n}/files`)의 `filename`도 항상
    root 기준이라 마찬가지로 이 프리픽스가 필요하다."""
    return _run_git(["rev-parse", "--show-prefix"]).strip()


_ROOT_PREFIX = _git_root_prefix()
ALEMBIC_ROOT_REL_DIR = (_ROOT_PREFIX + str(ALEMBIC_REL_DIR)).replace("\\", "/")


class RevisionInfo:
    __slots__ = ("path", "revision", "down_revisions", "source")

    def __init__(self, path: str, revision: str | None, down_revisions: set[str], source: str) -> None:
        self.path = path
        self.revision = revision
        self.down_revisions = down_revisions
        self.source = source  # 사람이 읽는 출처 라벨(예: "base:develop", "PR #2781")


def _extract_revision_vars(source_code: str) -> tuple[str | None, object]:
    """AST로 `revision`/`down_revision` 할당값을 뽑는다(타입주석·따옴표 스타일 무관).
    동적 계산(리터럴 아님)이면 해당 값은 None으로 남는다 — 위 docstring 한계 선언 참고."""
    try:
        tree = ast.parse(source_code)
    except SyntaxError:
        return None, None
    revision: str | None = None
    down_revision: object = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        for t in targets:
            if not isinstance(t, ast.Name):
                continue
            if t.id == "revision":
                try:
                    revision = ast.literal_eval(value)
                except Exception:
                    pass
            elif t.id == "down_revision":
                try:
                    down_revision = ast.literal_eval(value)
                except Exception:
                    pass
    return revision, down_revision


def _down_revision_set(down_revision: object) -> set[str]:
    if down_revision is None:
        return set()
    if isinstance(down_revision, (list, tuple, set)):
        return {str(d) for d in down_revision if d is not None}
    return {str(down_revision)}


def _source_from_added_file_patch(patch: str) -> str:
    """GitHub `pulls/{n}/files`의 `patch`(신규 파일 전체가 `+` 라인으로 실린다)에서
    원본 소스를 복원한다. `+++ b/...` 헤더·`@@ ... @@` 헤더는 제외."""
    lines: list[str] = []
    for line in patch.splitlines():
        if line.startswith("+++") or line.startswith("@@"):
            continue
        if line.startswith("+"):
            lines.append(line[1:])
    return "\n".join(lines)


def _run_gh_json(args: list[str]) -> object:
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"❌ gh 호출 실패({' '.join(args)}):\n{result.stderr}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(result.stdout)


def _this_pr_new_files() -> list[Path]:
    """이 PR이 base 대비 새로 추가한 alembic 리비전 파일 목록(git 기준, 정본)."""
    base_ref = os.environ["PR_BASE_REF"]
    out = _run_git(
        ["diff", "--relative", "--name-only", "--diff-filter=A",
         f"origin/{base_ref}...HEAD", "--", str(ALEMBIC_REL_DIR)],
    )
    return [Path(p) for p in out.splitlines() if p.strip()]


def _base_current_revisions() -> list[RevisionInfo]:
    """base 브랜치의 «현재(이 job 실행 시점)» 전체 리비전 — PR이 열린 뒤 base가 진행됐어도
    이 job이 매번 fresh하게 fetch한 base 최신을 본다(축 A/B의 "PR이 못 보는 새 형제" 케이스
    중 「형제가 이미 머지돼 base 자체가 된」 경우를 여기서 잡는다)."""
    base_ref = os.environ["PR_BASE_REF"]
    tree_out = _run_git(
        ["ls-tree", "-r", "--name-only", f"origin/{base_ref}", "--", str(ALEMBIC_REL_DIR)],
    )
    infos: list[RevisionInfo] = []
    for rel_path in tree_out.splitlines():
        rel_path = rel_path.strip()
        if not rel_path or not rel_path.endswith(".py"):
            continue
        content = _run_git(
            ["show", f"origin/{base_ref}:{_ROOT_PREFIX}{rel_path}"],
        )
        revision, down_revision = _extract_revision_vars(content)
        if revision is None:
            continue
        infos.append(RevisionInfo(rel_path, revision, _down_revision_set(down_revision), f"base:{base_ref}"))
    return infos


def _sibling_open_pr_revisions() -> list[RevisionInfo]:
    """같은 base를 겨냥한 다른 열린 PR들이 새로 만드는 alembic 리비전."""
    repo = os.environ["GH_REPO"]
    base_ref = os.environ["PR_BASE_REF"]
    own_pr_number = os.environ.get("PR_NUMBER", "")

    prs = _run_gh_json([
        "api", f"repos/{repo}/pulls",
        "-X", "GET",
        "-f", f"base={base_ref}", "-f", "state=open", "-f", "per_page=100",
        "--paginate",
    ])
    if not isinstance(prs, list):
        prs = [prs]

    infos: list[RevisionInfo] = []
    for pr in prs:
        number = str(pr.get("number", ""))
        if not number or number == own_pr_number:
            continue
        files = _run_gh_json([
            "api", f"repos/{repo}/pulls/{number}/files",
            "-X", "GET", "-f", "per_page=100", "--paginate",
        ])
        if not isinstance(files, list):
            files = [files]
        for f in files:
            path = f.get("filename", "")
            status = f.get("status", "")
            if status != "added" or not path.startswith(f"{ALEMBIC_ROOT_REL_DIR}/") or not path.endswith(".py"):
                continue
            patch = f.get("patch")
            if not patch:
                # 파일이 너무 커서 GitHub가 patch를 생략한 경우 — alembic 리비전 파일 치고
                # 비정상적으로 크다는 뜻이라 fail-closed(비교 불가로 에러).
                print(
                    f"❌ PR #{number}의 {path}가 patch 없이 반환됨(파일이 너무 크거나 binary로 "
                    "간주됨) — 형제 비교를 완결할 수 없다. fail-closed.",
                    file=sys.stderr,
                )
                raise SystemExit(2)
            source_code = _source_from_added_file_patch(patch)
            revision, down_revision = _extract_revision_vars(source_code)
            if revision is None:
                continue
            infos.append(RevisionInfo(path, revision, _down_revision_set(down_revision), f"PR #{number}"))
    return infos


def main() -> int:
    new_files = _this_pr_new_files()
    if not new_files:
        print("SKIP: 이 PR은 새 alembic 리비전을 추가하지 않는다 — 형제-충돌 검사 대상 아님")
        return 0

    print(f"[1/3] 이 PR의 신규 alembic 리비전 {len(new_files)}개 파싱")
    own: list[RevisionInfo] = []
    filename_mismatch_errors: list[str] = []
    for rel_path in new_files:
        content = Path(rel_path).read_text(encoding="utf-8")
        revision, down_revision = _extract_revision_vars(content)
        if revision is None:
            print(f"  ⚠️  {rel_path}: revision 값을 정적으로 못 읽음(동적 계산? AST 파싱 실패?) — 건너뜀")
            continue
        m = FILENAME_REV_RE.match(Path(rel_path).name)
        if m and m.group(1) != str(revision):
            filename_mismatch_errors.append(
                f"{rel_path}: 파일명 접두 '{m.group(1)}' != 파일 안 revision 값 '{revision}' — "
                "관례 위반(파일명 기반 신규파일 탐지 자체가 흔들린다)"
            )
        own.append(RevisionInfo(str(rel_path), str(revision), _down_revision_set(down_revision), "this PR"))
        print(f"  - {rel_path}: revision={revision!r} down_revision={_down_revision_set(down_revision)!r}")

    print("[2/3] base 브랜치 현재 리비전 + 형제 열린 PR 리비전 수집")
    others = _base_current_revisions() + _sibling_open_pr_revisions()
    print(f"  base+형제 합계 {len(others)}건 수집")

    errors: list[str] = list(filename_mismatch_errors)
    for mine in own:
        for other in others:
            if other.source == "this PR":
                continue
            if other.revision == mine.revision:
                errors.append(
                    f"[축 A: revision 중복] {mine.path}(revision={mine.revision})가 "
                    f"{other.source}의 {other.path}와 같은 revision 번호를 씁니다."
                )
            shared_parent = mine.down_revisions & other.down_revisions
            if shared_parent and other.revision != mine.revision:
                errors.append(
                    f"[축 B: down_revision 중복=dual-head] {mine.path}(down_revision="
                    f"{sorted(mine.down_revisions)})가 {other.source}의 {other.path}"
                    f"(down_revision={sorted(other.down_revisions)})와 같은 부모({sorted(shared_parent)})"
                    "에서 갈라집니다 — 번호가 달라도 head가 두 갈래로 나뉩니다."
                )

    print("[3/3] 판정")
    print(
        "⚠️ 이 가드의 시간 축 한계: 이 job 실행 «이후» 새로 열리는 형제 PR은 지금은 못 본다 — "
        "그 형제 쪽 CI가 자기 축 검사에서 걸리는 방식으로 대칭 보완된다. 이미 둘 다 열려 "
        "그린을 받은 뒤 머지 순서만 바뀌는 좁은 창은 이 job 재실행(rerun) 권장(머지 직전)."
    )

    if errors:
        print(f"\n❌ 리비전 충돌 {len(errors)}건 발견:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("\nOK: 형제 PR/base 대비 리비전 충돌 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())

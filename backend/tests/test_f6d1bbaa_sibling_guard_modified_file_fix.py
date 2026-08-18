"""story #f6d1bbaa 후속(2026-08-18) — ci_alembic_sibling_pr_collision_check.py 위양성 fix.

## fix① (M 사각)
#70bc4bc3 hotfix(PR #3196)에서 실측된 사고: PR이 기존 리비전(0254)의 down_revision을
재부모화(0253→0253a)해도, 가드가 base의 재부모화 前 stale 버전을 계속 읽어 "이 PR의
신규 리비전(0253a)과 그 stale 0254가 같은 부모(0253)를 공유한다"는 가짜 dual-head를
보고했다 — 실제 PR 트리는 0253→0253a→0254로 선형인데도.

## fix② (D/R 사각, 페드루 PR #3199 리뷰 지적)
fix①은 `diff --diff-filter=M`으로만 "PR이 수정한 파일"을 잡았다 — PR이 리비전 파일을
**삭제**하면 base 쪽 유령 엔트리가 stale 상태로 계속 남아 위양성/위음성을 만들고,
**리네임**은 git의 rename-heuristic에 따라 M이 아니라 R로 분류돼 새 경로가 놓칠 수
있었다. 집합 차집합(PR HEAD 경로 vs base 경로) 기반으로 재설계해 A/M/D/R 전부를
git의 diff-filter 문자와 무관하게 균일하게 처리한다.

이 테스트는 git/gh 호출을 전부 monkeypatch로 대체해(라이브 네트워크·서브프로세스 없이)
순수 비교 로직만 검증한다."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import ci_alembic_sibling_pr_collision_check as guard  # noqa: E402


@pytest.fixture
def patch_git_gh(monkeypatch):
    """_run_git·_run_gh_json·Path.read_text를 전부 인메모리 fixture로 치환."""
    state = {"base_ls": [], "pr_head_ls": [], "sibling_prs": [], "own_content": {}}

    def fake_run_git(args):
        if args[0] == "ls-tree":
            ref = args[3]
            if ref == "HEAD":
                return "\n".join(state["pr_head_ls"])
            return "\n".join(state["base_ls"])
        if args[0] == "rev-parse":
            return ""
        return ""

    def fake_run_gh_json(args):
        return state["sibling_prs"]

    def fake_read_text(self, encoding="utf-8"):
        key = str(self)
        if key in state["own_content"]:
            return state["own_content"][key]
        raise FileNotFoundError(key)

    monkeypatch.setattr(guard, "_run_git", fake_run_git)
    monkeypatch.setattr(guard, "_run_gh_json", fake_run_gh_json)
    monkeypatch.setattr(Path, "read_text", fake_read_text)
    monkeypatch.setattr(guard, "_ROOT_PREFIX", "backend/")
    monkeypatch.setenv("PR_BASE_REF", "develop")
    monkeypatch.setenv("PR_NUMBER", "9999")
    monkeypatch.setenv("GH_REPO", "moonklabs/sprintable")
    return state


def test_reparented_existing_file_does_not_false_positive_dual_head(patch_git_gh):
    """fix① 재현 — #3196 시나리오: 신규 0253a(down=0253) + 재부모화된 0254(down=0253a,
    PR HEAD 기준)가 base의 stale 0254(down=0253)와 비교돼도 dual-head 오탐이 없어야 한다."""
    state = patch_git_gh

    state["base_ls"] = ["alembic/versions/0253_x.py", "alembic/versions/0254_y.py"]
    state["pr_head_ls"] = ["alembic/versions/0253_x.py", "alembic/versions/0254_y.py",
                            "alembic/versions/0253a_replay.py"]
    state["own_content"] = {
        "alembic/versions/0253_x.py": 'revision = "0253"\ndown_revision = "0252"\n',
        "alembic/versions/0254_y.py": 'revision = "0254"\ndown_revision = "0253a"\n',  # PR HEAD(재부모화 後)
        "alembic/versions/0253a_replay.py": 'revision = "0253a"\ndown_revision = "0253"\n',
    }
    state["sibling_prs"] = []

    assert guard.main() == 0


def test_deleted_revision_excluded_not_stale_ghost(patch_git_gh):
    """fix② 재현① — 이 PR이 base의 기존 리비전 파일을 «삭제»하면, 그 파일은 유령으로
    남아 비교되면 안 된다(삭제 자체가 위양성을 만들지 않아야 함)."""
    state = patch_git_gh

    # base: 0253 -> 0253_deleteme(새 head) 존재. 이 PR이 0253_deleteme를 삭제하고
    # 자기 자신의 신규 0253_new를 0253 뒤에 얹는다 — 원래는 0253_deleteme와 0253_new가
    # 둘 다 down=0253이라 "삭제 반영 안 하면" dual-head 오탐이 났을 상황.
    state["base_ls"] = ["alembic/versions/0253_root.py", "alembic/versions/0253a_deleteme.py"]
    state["pr_head_ls"] = ["alembic/versions/0253_root.py", "alembic/versions/0253a_new.py"]
    state["own_content"] = {
        "alembic/versions/0253_root.py": 'revision = "0253"\ndown_revision = "0252"\n',
        "alembic/versions/0253a_new.py": 'revision = "0253a"\ndown_revision = "0253"\n',
        # 삭제된 파일의 «원래» 내용 — 신규 0253a_new.py와 정확히 같은 revision/down_
        # revision을 씀. 가드가 삭제를 제대로 반영 안 하고 이걸 읽어버리면(뮤테이션 시)
        # 축A(revision 중복) 충돌이 실제로 발생해야 한다 — 그래야 이 테스트가 "제대로
        # 제외됐는지"를 진짜로 검증하는 게 된다.
        "alembic/versions/0253a_deleteme.py": 'revision = "0253a"\ndown_revision = "0253"\n',
    }
    state["sibling_prs"] = []

    assert guard.main() == 0


def test_renamed_new_path_detected_as_own_new_file(patch_git_gh):
    """fix② 재현② — git이 리네임(R)으로 감지할 수 있는 케이스(옛 경로 사라지고 새 경로
    등장)도 집합 차집합으로 "이 PR의 신규 파일"로 정확히 잡혀야 한다."""
    state = patch_git_gh

    state["base_ls"] = ["alembic/versions/0253_root.py", "alembic/versions/0254_oldname.py"]
    # 0254_oldname.py -> 0254_newname.py로 리네임(git rename-heuristic 여부와 무관하게
    # ls-tree 스냅샷 비교만으로 판별).
    state["pr_head_ls"] = ["alembic/versions/0253_root.py", "alembic/versions/0254_newname.py"]
    state["own_content"] = {
        "alembic/versions/0253_root.py": 'revision = "0253"\ndown_revision = "0252"\n',
        "alembic/versions/0254_newname.py": 'revision = "0254"\ndown_revision = "0253"\n',
    }
    state["sibling_prs"] = []

    assert guard.main() == 0


def test_genuine_dual_head_still_caught(patch_git_gh):
    """음성대조① — 진짜 dual-head(무관한 신규 리비전끼리 같은 부모 공유)는 여전히
    잡혀야 한다(fix가 탐지력 자체를 약화시키지 않았는지 확認)."""
    state = patch_git_gh

    state["base_ls"] = ["alembic/versions/0253_x.py"]
    state["pr_head_ls"] = ["alembic/versions/0253_x.py", "alembic/versions/0254_a.py"]
    state["own_content"] = {
        "alembic/versions/0253_x.py": 'revision = "0253"\ndown_revision = "0252"\n',
        "alembic/versions/0254_a.py": 'revision = "0254a"\ndown_revision = "0253"\n',
    }

    def fake_run_gh_json(args):
        if "pulls/42/files" in " ".join(args):
            return [{
                "filename": "backend/alembic/versions/0254b_sibling.py",
                "status": "added",
                "patch": "@@ -0,0 +1,2 @@\n+revision = \"0254b\"\n+down_revision = \"0253\"\n",
            }]
        return [{"number": 42}]

    guard._run_gh_json = fake_run_gh_json  # type: ignore[attr-defined]

    assert guard.main() == 1


def test_revision_duplication_still_caught(patch_git_gh):
    """음성대조② — 축 A(revision 값 자체 중복)도 이 fix 후 여전히 잡혀야 한다."""
    state = patch_git_gh

    state["base_ls"] = ["alembic/versions/0253_x.py"]
    state["pr_head_ls"] = ["alembic/versions/0253_x.py", "alembic/versions/0253_dup.py"]
    state["own_content"] = {
        "alembic/versions/0253_x.py": 'revision = "0253"\ndown_revision = "0252"\n',
        "alembic/versions/0253_dup.py": 'revision = "0253"\ndown_revision = "0252"\n',
    }
    state["sibling_prs"] = []

    assert guard.main() == 1

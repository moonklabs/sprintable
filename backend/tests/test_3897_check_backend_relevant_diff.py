"""story #3897 — check_backend_relevant_diff.sh(+extract_fe_paths_referenced_by_backend_tests.py)
회귀가드.

3889 사고(2026-09-14): PR 4294가 apps/web/messages/ko.json의 한 문구를 해요체로 바꿨는데,
ci.yml의 detect-changed-scope가 "FE-only PR"로 판단해 백엔드 pytest 레인을 통째로 skip했다
(그 PR 자체 CI는 success). 하지만 backend/tests/test_3815_youtube_publish.py가 바로 그
ko.json 파일을 직접 읽어 BE i18n_catalog 원문과 바이트 대조하는 파리티 테스트라, 경로 기반
스킵이 그 참조를 몰라 develop CI에서만(머지된 뒤에야) RED가 터졌다.

CHANGES 1(페드루 PO 리뷰, 2026-09-15) — PO가 실 develop 트리에서 이 스크립트를 돌려
os.path.join(dirname(__file__), "..", "..", "apps", "web", "src", ...) 콤마 세그먼트
형태(여러 줄에 걸침) 4곳이 최초 버전(형태 ①②만)에서 «조용히» 빠지는 걸 발견 — 이 카드가
막으려는 바로 그 클래스가 스크립트 자신 안에서 재발했다. 처방: 형태 ③(os.path.join 콤마
조인) 추가 + 완전성 fail-closed(파일에 apps/packages 리터럴이 있는데 3형 다 0건이면
exit 1 — "4번째 미지의 형태"로 보고 조용히 넘어가지 않는다).

check_backend_relevant_diff.sh/extract_fe_paths_referenced_by_backend_tests.py는 순수
git diff + backend/tests/**/*.py 코드 스캔 로직이라 임시 git repo(backend/tests 안에 그
스캔 대상이 될 파일 몇 개만 있으면 됨)만으로 전체 판정 경로(관련/무관/추출 실패 fail-closed
/완전성 위반 fail-closed)를 검증할 수 있다(cloudbuild·GitHub Actions 목업 불요 —
check_realtime_relevant_diff.sh 테스트와 같은 설계).
"""
from __future__ import annotations

import os
import subprocess

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DECISION_SCRIPT = os.path.join(_SCRIPTS_DIR, "check_backend_relevant_diff.sh")
_EXTRACT_SCRIPT = os.path.join(_SCRIPTS_DIR, "extract_fe_paths_referenced_by_backend_tests.py")
_REAL_BACKEND_TESTS_DIR = os.path.dirname(__file__)


def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t.com",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t.com"},
    )


def _write(repo, rel, content="v1\n"):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def _init_repo(tmp_path, *, with_parity_test=True):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")

    (repo / "backend" / "scripts").mkdir(parents=True, exist_ok=True)
    for script in (_EXTRACT_SCRIPT, _DECISION_SCRIPT):
        dest = repo / "backend" / "scripts" / os.path.basename(script)
        dest.write_text(open(script).read())
        dest.chmod(0o755)

    _write(repo, "apps/web/messages/ko.json", '{"a": "b"}\n')
    _write(repo, "apps/web/messages/en.json", '{"a": "b"}\n')
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 1\n")
    _write(repo, "backend/app/routers/other.py", "x = 1\n")
    _write(repo, "docs/notes.md", "# notes\n")

    if with_parity_test:
        _write(
            repo, "backend/tests/test_fake_i18n_parity.py",
            'from pathlib import Path\n'
            'REPO_ROOT = Path(__file__).resolve().parents[2]\n'
            'def test_parity():\n'
            '    fe_ko = (REPO_ROOT / "apps/web/messages/ko.json").read_text()\n',
        )

    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    return repo, base_sha


def _run_decision(repo, base_sha, head_sha="HEAD"):
    return subprocess.run(
        ["bash", "backend/scripts/check_backend_relevant_diff.sh", base_sha, head_sha],
        cwd=str(repo), capture_output=True, text=True,
    )


def _run_extract(repo, test_root="backend/tests"):
    return subprocess.run(
        ["python3", "backend/scripts/extract_fe_paths_referenced_by_backend_tests.py", test_root],
        cwd=str(repo), capture_output=True, text=True,
    )


# ── extract_fe_paths_referenced_by_backend_tests.py — 형태 ①② ──────────────

def test_extract_finds_single_string_literal_path(tmp_path):
    repo, _ = _init_repo(tmp_path)
    proc = _run_extract(repo)
    assert proc.returncode == 0, proc.stderr
    assert "apps/web/messages/ko.json" in proc.stdout.splitlines()


def test_extract_finds_segmented_pathlib_join(tmp_path):
    repo, _ = _init_repo(tmp_path, with_parity_test=False)
    _write(
        repo, "backend/tests/test_fake_segmented.py",
        'from pathlib import Path\n'
        'P = Path(__file__).resolve().parents[2] / "apps" / "web" / "messages" / "ko.json"\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add segmented ref")
    proc = _run_extract(repo)
    assert proc.returncode == 0, proc.stderr
    assert "apps/web/messages/ko.json" in proc.stdout.splitlines()


def test_extract_ignores_unquoted_prose_mention(tmp_path):
    """⭐따옴표 없는 산문 언급("...apps/web 쪽 자체 테스트...")은 실제 코드 참조가
    아니므로 추출 대상이 아니다 — 과소포함이 아니라 «따옴표로 감싼 리터럴만»이라는
    설계 경계가 실제로 지켜지는지 확認."""
    repo, _ = _init_repo(tmp_path)  # with_parity_test=True(기본) — base commit에 실 참조 1건 있음
    _write(
        repo, "backend/tests/test_fake_prose_only.py",
        '"""이 파일의 관심사는 BE 축만이다(apps/web 쪽은 자체 테스트 파일에서 다룬다)."""\n'
        'def test_noop():\n'
        '    assert True\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add prose-only file")
    proc = _run_extract(repo)
    assert proc.returncode == 0, proc.stderr
    results = proc.stdout.splitlines()
    assert "apps/web" not in results
    assert "apps/web/messages/ko.json" in results


def test_extract_zero_results_is_fail_closed(tmp_path):
    """⭐backend/tests 안에 FE 경로 리터럴 참조가 «전혀 없으면» — 정규식이 깨졌거나
    테스트 트리가 소실된 신호로 보고 fail-closed(exit 1)해야 한다(「0건」을 «FE 의존
    없음»으로 조용히 읽지 않는다)."""
    repo, _ = _init_repo(tmp_path, with_parity_test=False)
    _write(repo, "backend/tests/test_no_fe_refs.py", "def test_noop():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "no fe refs")
    proc = _run_extract(repo)
    assert proc.returncode == 1, f"추출 0건인데 exit 0 — fail-closed 계약 위반: {proc.stdout!r}"


def test_extract_missing_test_root_is_fail_closed(tmp_path):
    repo, _ = _init_repo(tmp_path)
    proc = _run_extract(repo, test_root="backend/does-not-exist")
    assert proc.returncode == 1


# ── extract_fe_paths_referenced_by_backend_tests.py — 형태 ③(CHANGES 1) ─────

def test_extract_finds_os_path_join_comma_segments_multiline(tmp_path):
    """⭐CHANGES 1 핵심 재현 — os.path.join(dirname(__file__), "..", "..", "apps", "web",
    "src", ..., "billing-tab.tsx") 콤마 세그먼트(여러 줄에 걸침, PO가 실 develop
    test_e_org_multi_s5_3_polar_checkout.py:146 등에서 실측한 형태 그대로)에서 ".."는
    버리고 "apps"부터 재조립해 apps/web/src/ee/components/billing/billing-tab.tsx를
    뽑아야 한다."""
    repo, _ = _init_repo(tmp_path, with_parity_test=False)
    _write(
        repo, "backend/tests/test_fake_os_path_join.py",
        'import os\n\n'
        'def test_billing_tab_has_checkout_ui():\n'
        '    path = os.path.join(\n'
        '        os.path.dirname(__file__), "..", "..", "apps", "web", "src",\n'
        '        "ee", "components", "billing", "billing-tab.tsx"\n'
        '    )\n'
        '    with open(path) as f:\n'
        '        content = f.read()\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add os.path.join comma-segment ref")
    proc = _run_extract(repo)
    assert proc.returncode == 0, proc.stderr
    assert "apps/web/src/ee/components/billing/billing-tab.tsx" in proc.stdout.splitlines()


def test_extract_on_real_repo_tree_finds_s5_paths_and_ko_json(tmp_path):
    """⭐실 트리 표본(합성 fixture 말고 이 리포의 진짜 backend/tests/ 전체) — PO가 지적한
    실 파일(test_e_org_multi_s5_3_polar_checkout.py 등)의 billing-tab.tsx 경로와
    AC1 최소 기대(ko.json)가 동시에 뽑히는지 실물로 확認."""
    backend_dir = os.path.abspath(os.path.join(_REAL_BACKEND_TESTS_DIR, ".."))
    proc = subprocess.run(
        ["python3", "scripts/extract_fe_paths_referenced_by_backend_tests.py", "tests"],
        cwd=backend_dir, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    results = proc.stdout.splitlines()
    assert "apps/web/messages/ko.json" in results
    assert "apps/web/messages/en.json" in results
    assert "apps/web/src/ee/components/billing/billing-tab.tsx" in results
    assert "apps/web/src/components/nav/create-organization-dialog.tsx" in results


# ── extract_fe_paths_referenced_by_backend_tests.py — 완전성 fail-closed(CHANGES 1) ──

def test_extract_completeness_fail_closed_on_unknown_form(tmp_path):
    """⭐완전성 양성대조 — 어떤 파일이 따옴표로 감싼 "apps" 토큰을 갖고 있는데(진짜 참조가
    있다는 강한 신호) 알려진 3형 어디로도 안 걸리면(예: 4번째 미지의 형태), 이 스크립트가
    그 파일 하나만 조용히 빠뜨리는 대신 «전체를» fail-closed(exit 1)해야 한다 — 정확히
    이번 CHANGES 1이 잡은 재발 클래스."""
    repo, _ = _init_repo(tmp_path)  # with_parity_test=True — 정상 참조 1건도 같이 있음
    _write(
        repo, "backend/tests/test_fake_unknown_form.py",
        # "apps" 토큰은 따옴표로 감싸져 있지만(강한 신호) ①②③ 어느 형태에도 해당하지 않는
        # 가짜 4번째 형태(예: 리스트 컴프리헨션 join) — 의도적으로 추출기가 못 잡게 구성.
        'SEGS = ["apps", "web", "messages", "ko.json"]\n'
        'PATH = "/".join([s for s in SEGS])\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add unknown-form file")
    proc = _run_extract(repo)
    assert proc.returncode == 1, (
        f"완전성 위반(미지 형태)인데 exit 0 — fail-closed 계약 위반: {proc.stdout!r}"
    )
    assert "test_fake_unknown_form.py" in proc.stderr


def test_extract_completeness_check_does_not_false_positive_on_docstring_boundary(tmp_path):
    """⭐완전성 음성대조(CHANGES 1 자기회귀 — PO 리뷰 중 실 재현) — 독스트링이 우연히
    `\"\"\"apps/web/...` 로 시작해도(트리플쿼트의 마지막 "가 "apps/web/" 바로 앞에 옴) 이건
    실 코드 참조가 아니라 문서 경계 우연이다. 실 파일(test_email_shell.py 형태)로
    재현 — 완전성 체크가 이걸 «미지 형태」로 오탐하면 이 리포의 실 backend/tests 스캔
    자체가 상시 fail-closed에 빠져 카드의 목적(정확한 판정)이 무너진다."""
    repo, _ = _init_repo(tmp_path)  # with_parity_test=True — 정상 참조 1건 있음
    _write(
        repo, "backend/tests/test_fake_docstring_boundary.py",
        '"""apps/web/src/lib/legal/business-info.ts와 글자 단위 일치 확認(이 파일은 import\n'
        '못 하는 별도 런타임이라 값을 손으로 맞춰 유지)."""\n'
        'def test_noop():\n'
        '    assert True\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add docstring-boundary file")
    proc = _run_extract(repo)
    assert proc.returncode == 0, (
        f"독스트링 트리플쿼트 경계 우연을 미지 형태로 오탐(완전성 fail-closed 오발) — {proc.stderr!r}"
    )


# ── check_backend_relevant_diff.sh (전체 판정) ───────────────────────────────

def test_fe_only_pr_without_parity_touch_is_irrelevant(tmp_path):
    """⭐AC2 음성대조 — backend/tests가 참조 안 하는 FE 컴포넌트만 바뀌면 무관(exit 1,
    백엔드 무거운 잡 skip 가능) — 기존 스킵 효과가 그대로 보존돼야 한다."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch unrelated FE file")

    proc = _run_decision(repo, base_sha)
    assert proc.returncode == 1, f"무관 PR인데 관련 판정 — stderr={proc.stderr!r}"


def test_fe_only_pr_touching_parity_dependency_is_relevant(tmp_path):
    """⭐AC2 양성대조(3889 사고 재현) — backend/tests가 실제로 읽는 apps/web/messages/
    ko.json만 바뀌어도(다른 backend/ 파일 무접촉) 관련(exit 0, 백엔드 전량 실행)이어야
    한다 — 이게 이 카드의 핵심 계약."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "apps/web/messages/ko.json", '{"a": "c"}\n')
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch ko.json (3889-style)")

    proc = _run_decision(repo, base_sha)
    assert proc.returncode == 0, f"파리티 의존 경로 변경인데 무관 판정(3889 재발) — stderr={proc.stderr!r}"
    assert "ko.json" in proc.stderr


def test_fe_only_pr_touching_os_path_join_dependency_is_relevant(tmp_path):
    """⭐AC2 양성대조 ②(CHANGES 1 — 형태 ③) — os.path.join 콤마 세그먼트로만 참조되는
    FE 파일(billing-tab.tsx류)이 바뀌어도 관련 판정이어야 한다."""
    repo, base_sha = _init_repo(tmp_path)
    _write(
        repo, "backend/tests/test_fake_os_path_join.py",
        'import os\n\n'
        'def test_billing_tab_has_checkout_ui():\n'
        '    path = os.path.join(\n'
        '        os.path.dirname(__file__), "..", "..", "apps", "web", "src",\n'
        '        "ee", "components", "billing", "billing-tab.tsx"\n'
        '    )\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add os.path.join fixture")
    base_sha2 = _git(repo, "rev-parse", "HEAD").stdout.strip()

    _write(repo, "apps/web/src/ee/components/billing/billing-tab.tsx", "export const X = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch billing-tab.tsx")

    proc = _run_decision(repo, base_sha2)
    assert proc.returncode == 0, f"os.path.join 의존 경로 변경인데 무관 판정 — stderr={proc.stderr!r}"


def test_backend_file_touch_is_relevant_as_before(tmp_path):
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/app/routers/other.py", "x = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch backend file")

    proc = _run_decision(repo, base_sha)
    assert proc.returncode == 0


def test_docs_only_pr_is_irrelevant_as_before(tmp_path):
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "docs/notes.md", "# more notes\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch docs")

    proc = _run_decision(repo, base_sha)
    assert proc.returncode == 1


def test_extraction_failure_forces_relevant_fail_closed(tmp_path):
    """⭐backend/tests 트리 자체가(레포 사고 등으로) 스캔 대상 0건이 되면 — 추출이
    fail-closed exit 1 → 전체 판정도 그걸 삼키지 않고 관련(exit 0)으로 전파돼야 한다."""
    repo, base_sha = _init_repo(tmp_path, with_parity_test=False)
    # backend/tests 아예 비움(FE 경로 리터럴 참조가 하나도 없는 실 상태를 재현).
    _write(repo, "backend/tests/__init__.py", "")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "empty backend/tests")
    base_sha2 = _git(repo, "rev-parse", "HEAD").stdout.strip()

    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 3\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "touch unrelated FE file, no parity tests exist")

    proc = _run_decision(repo, base_sha2)
    assert proc.returncode == 0, "추출 0건인데 무관(exit 1) 판정 — fail-closed 계약 위반"


def test_missing_base_sha_is_fail_closed_relevant(tmp_path):
    repo, _base_sha = _init_repo(tmp_path)
    proc = _run_decision(repo, "")
    assert proc.returncode == 0

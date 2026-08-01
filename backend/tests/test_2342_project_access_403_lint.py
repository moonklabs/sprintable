"""story #2342 AC7 — lint_project_access_403.py의 정탐/오탐 회귀 가드. 실물 파일이 아니라
합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2335 lint와 동형)."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_project_access_403 import find_violations  # noqa: E402


def _write(tmp_path: Path, name: str, source: str) -> Path:
    p = tmp_path / name
    p.write_text(source)
    return p


def test_detects_403_after_has_project_access_denial(tmp_path):
    src = '''
async def get_thing(id, session, auth, org_id):
    if not await has_project_access(session, auth.user_id, project_id, org_id):
        raise HTTPException(status_code=403, detail="no access")
    return thing
'''
    path = _write(tmp_path, "bad.py", src)
    violations = find_violations(path)
    assert len(violations) == 1
    assert violations[0][2] == "get_thing"


def test_404_after_has_project_access_denial_is_not_flagged(tmp_path):
    """story #2342로 고쳐진 형태(404) — 위반이 아니다."""
    src = '''
async def get_thing(id, session, auth, org_id):
    if not await has_project_access(session, auth.user_id, project_id, org_id):
        raise HTTPException(status_code=404, detail="not found")
    return thing
'''
    path = _write(tmp_path, "good.py", src)
    assert find_violations(path) == []


def test_403_unrelated_to_project_access_is_not_flagged(tmp_path):
    """has_project_access와 무관한 403(예: agent-only 게이트)은 이 lint 범위 밖 — 오탐 방지."""
    src = '''
async def adopt(id, auth):
    if auth.actor_type != "human":
        raise HTTPException(status_code=403, detail="human only")
    return None
'''
    path = _write(tmp_path, "unrelated.py", src)
    assert find_violations(path) == []


def test_has_project_access_check_without_403_is_not_flagged(tmp_path):
    """has_project_access를 쓰지만 403을 안 던지면(다른 처리) 위반이 아니다."""
    src = '''
async def get_thing(id, session, auth, org_id):
    if not await has_project_access(session, auth.user_id, project_id, org_id):
        raise HTTPException(status_code=404, detail="not found")
    if some_other_check:
        raise HTTPException(status_code=403, detail="unrelated gate")
    return thing
'''
    path = _write(tmp_path, "mixed.py", src)
    # 403은 has_project_access 분기 밖(다른 if)에 있으므로 위반이 아니어야 한다.
    assert find_violations(path) == []


def test_mutation_removing_403_check_causes_zero_detections():
    """뮤테이션: _raises_403이 늘 False를 반환하게 하면 위 양성 테스트가 깨져야 한다 —
    이 lint의 핵심 로직이 실제로 테스트에 의해 지켜지는지 자가 검증."""
    import lint_project_access_403 as mod

    original = mod._raises_403
    try:
        mod._raises_403 = lambda node: False
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "bad.py"
            path.write_text('''
async def get_thing(id, session, auth, org_id):
    if not await has_project_access(session, auth.user_id, project_id, org_id):
        raise HTTPException(status_code=403, detail="no access")
''')
            violations = mod.find_violations(path)
        assert violations == [], "뮤테이션 후에는 탐지가 0이어야 정상(로직이 실제로 그 판정에 의존함을 증명)"
    finally:
        mod._raises_403 = original


def test_current_repo_has_no_new_violations_beyond_baseline():
    """실물 app/routers 전체를 스캔해 베이스라인 밖 새 위반이 0건인지 — CI가 도는 그 검사
    자체를 pytest로도 한 번 더 고정한다(이중 확인, story #2335 lint와 동일 이유는 아니고
    이건 그냥 회귀 조기 발견용)."""
    import lint_project_access_403 as mod

    violations = mod.scan_repo()
    baseline = mod.load_baseline()
    new = [v for v in violations if mod.violation_key(v[0], v[2]) not in baseline]
    assert new == [], f"베이스라인 밖 새 위반 발견: {new}"

"""story 4659 (PO 08:37Z) — 가드 묶음 잡에서 한 가드가 빨개도 나머지 가드는 다 돈다.

옛 가드는 잡마다 따로 돌았다. 한 묶음 잡에 합치면서 기본 success()가 붙으면 앞 스텝이 실패한 순간
뒤 가드가 전부 건너뛰어 각자 결과가 안 남는다. 그래서 가드 스텝마다 `if: ${{ !cancelled() }}`를 둔다.
잡 자체는 여전히 실패해서 병합이 막힌다. Checkout은 첫 스텝이라 조건 없이 둔다.
"""
import os

import yaml

_CI_YML = os.path.join(os.path.dirname(__file__), "..", "..", ".github", "workflows", "ci.yml")


def test_every_guard_step_still_runs_after_an_earlier_guard_fails():
    with open(_CI_YML) as f:
        ci = yaml.safe_load(f)
    steps = ci["jobs"]["guards"]["steps"]
    unguarded = [s.get("name") for s in steps if s.get("name") != "Checkout" and "!cancelled()" not in str(s.get("if", ""))]
    assert unguarded == [], f"guards steps that would skip after an earlier failure: {unguarded}"

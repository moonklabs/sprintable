"""story #3773 — FE `stageRoleLabel()`(apps/web/src/lib/stage-role.ts)가 번역하는 프리셋
role 값 집합이 실제로 이 마이그레이션(0260, event_definitions.stage_metadata 프리셋 시드)의
`_rows()`가 내는 값과 정확히 같은지 고정한다. 프리셋은 마이그레이션으로만 늘어나므로(런타임
증가 없음, dev DB 라이브 실측으로 재확認) 이 테스트가 그 유일한 소스를 직접 읽는다 —
「FE 룩업 표를 손으로 옮겨 적다 하나 빠뜨림」 클래스를 막는다."""
from __future__ import annotations

import importlib.util
import os

_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions",
    "0260_compile_workflow_recipes_to_cycle_events.py",
)

# story #3773(유나 定 2026-09-10) — apps/web/src/lib/stage-role.ts의 STAGE_ROLE_KEY와
# 정확히 같은 13개 값이어야 한다(대칭 고정 — 한쪽만 바뀌면 이 테스트가 RED).
_FE_STAGE_ROLE_KEYS = frozenset({
    "Agent", "Any", "Approver", "Dev", "Executor", "Human",
    "Lead", "Maker", "Member", "PO", "QA", "Reviewer", "Worker",
})


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0260", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _all_seed_role_values(mig) -> set[str]:
    roles: set[str] = set()
    for _slug, _name, _description, _stage_slugs, stage_metadata in mig._rows():
        for meta in stage_metadata.values():
            if "role" in meta:
                roles.add(meta["role"])
    return roles


# ⭐되돌리면 RED — FE STAGE_ROLE_KEY에서 값 하나를 지우거나(또는 이 마이그레이션에 새
# 프리셋 role 값이 추가되고 FE가 안 따라가면) 이 대조가 어긋난다.
def test_be_seed_role_values_match_fe_stage_role_keys():
    mig = _load_migration()
    seed_roles = _all_seed_role_values(mig)
    assert seed_roles == set(_FE_STAGE_ROLE_KEYS), (
        f"BE 시드(0260) role 값 집합과 FE stage-role.ts의 STAGE_ROLE_KEY가 어긋남 — "
        f"BE에만 있음: {seed_roles - _FE_STAGE_ROLE_KEYS} · FE에만 있음: "
        f"{_FE_STAGE_ROLE_KEYS - seed_roles}"
    )


def test_be_seed_has_exactly_13_preset_role_values():
    mig = _load_migration()
    assert len(_all_seed_role_values(mig)) == 13

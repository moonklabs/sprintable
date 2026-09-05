"""story #3510(BE·결함·소형, 페드루 PO 確定 2026-09-05) — `PATCH /org-members/{id}`
role 변경이 `org_members.role`만 갱신하고 앵커 `members.org_role`을 안 옮겨,
`member_ssot_resolver_shadow=true`(dev)의 `_resolve_member_anchor`가 옛 역할로
게이트를 판정하던 결함. 세팅 헬퍼는 test_3471_org_content_rules_lint.py와 동형
(중복 재발명 금지).

fix = `OrgMemberRepository.update()`가 role 변경 시 같은 트랜잭션에서
`members.org_role`도 동기화(members 행이 없는 grant-only 휴먼은 조용히 no-op).
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_human_with_anchor(session, org_id, *, role="member"):
    """0075 ID 보존 불변식(members.id == org_member.id) 그대로 — org_members + members
    앵커를 같은 id로 함께 심는다(드리프트 재현/검증에 둘 다 필요)."""
    from app.models.project import OrgMember
    from app.models.member import Member
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    m = Member(
        id=om.id, org_id=org_id, type="human", user_id=user.id,
        name=f"human-{om.id}", org_role=role, is_active=True,
    )
    session.add(m)
    await session.commit()
    return user.id, om.id


async def _seed_human_without_anchor(session, org_id, *, role="member"):
    """grant-only 휴먼(members-sync 갭 재현) — org_members만, members 앵커 없음."""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id, om.id


async def _get_member_org_role(session, member_id):
    from sqlalchemy import select
    from app.models.member import Member
    row = (await session.execute(select(Member.org_role).where(Member.id == member_id))).scalar_one_or_none()
    return row


async def _get_org_member_role(session, om_id):
    from sqlalchemy import select
    from app.models.project import OrgMember
    row = (await session.execute(select(OrgMember.role).where(OrgMember.id == om_id))).scalar_one_or_none()
    return row


# ─── PATCH 후 두 표 동기화 ────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_patch_role_syncs_member_anchor_org_role():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_user_id, owner_om_id = await _seed_human_with_anchor(s, org_id, role="owner")
            target_user_id, target_om_id = await _seed_human_with_anchor(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id)
        async with _client_for(app) as client:
            r = await client.patch(f"/api/v2/org-members/{target_om_id}", json={"role": "admin"})
        assert r.status_code == 200, r.text

        async with Session() as s:
            assert await _get_org_member_role(s, target_om_id) == "admin"
            assert await _get_member_org_role(s, target_om_id) == "admin", (
                "PATCH가 org_members.role만 갱신하고 members.org_role 앵커를 안 옮기면 "
                "여기서 옛 값('member')이 남는다 — #3510 원 증상."
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_role_no_anchor_row_is_noop_not_crash():
    """grant-only 휴먼(members 행 없음) — sync UPDATE가 0행이어도 200(크래시 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_user_id, _owner_om_id = await _seed_human_with_anchor(s, org_id, role="owner")
            target_user_id, target_om_id = await _seed_human_without_anchor(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id)
        async with _client_for(app) as client:
            r = await client.patch(f"/api/v2/org-members/{target_om_id}", json={"role": "admin"})
        assert r.status_code == 200, r.text

        async with Session() as s:
            assert await _get_org_member_role(s, target_om_id) == "admin"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── shadow 리졸버(anchor)에서 승격/강등이 즉시 게이트에 먹는지 ──────────────────


@pytest.mark.anyio
async def test_shadow_anchor_promotion_gate_passes_after_patch(monkeypatch):
    """AC2 전반 — admin으로 승격 뒤(anchor 리졸버 기준) owner|admin 게이트가 200."""
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "member_ssot_resolver_shadow", True)

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_user_id, _owner_om_id = await _seed_human_with_anchor(s, org_id, role="owner")
            target_user_id, target_om_id = await _seed_human_with_anchor(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id)
        async with _client_for(app) as client:
            r = await client.patch(f"/api/v2/org-members/{target_om_id}", json={"role": "admin"})
        assert r.status_code == 200, r.text

        _setup_org_scoped_app(app, Session, org_id, user_id=target_user_id)
        async with _client_for(app) as client:
            r_gate = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": []}, "expected_version": 0},
            )
        assert r_gate.status_code == 200, (
            f"shadow anchor 리졸버가 여전히 옛 role(member)로 판정하면 403: {r_gate.text}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_shadow_anchor_demotion_gate_403_after_patch_no_privilege_lingers(monkeypatch):
    """AC2 후반 — admin→member 강등 뒤(anchor 리졸버 기준) 권한 잔존 0(403)."""
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "member_ssot_resolver_shadow", True)

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_user_id, _owner_om_id = await _seed_human_with_anchor(s, org_id, role="owner")
            target_user_id, target_om_id = await _seed_human_with_anchor(s, org_id, role="admin")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id)
        async with _client_for(app) as client:
            r = await client.patch(f"/api/v2/org-members/{target_om_id}", json={"role": "member"})
        assert r.status_code == 200, r.text

        _setup_org_scoped_app(app, Session, org_id, user_id=target_user_id)
        async with _client_for(app) as client:
            r_gate = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": []}, "expected_version": 0},
            )
        assert r_gate.status_code == 403, (
            f"강등됐는데 옛 anchor role(admin)이 남아 게이트를 통과하면 권한 잔존: {r_gate.text}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 백필 마이그 ──────────────────────────────────────────────────────────────


_BACKFILL_SQL = """
    UPDATE members
    SET org_role = org_members.role
    FROM org_members
    WHERE members.id = org_members.id
      AND members.type = 'human'
      AND org_members.deleted_at IS NULL
      AND members.org_role IS DISTINCT FROM org_members.role
"""
# 페드루 PO 기록(2026-09-05, PR#3852 리뷰, 비차단) — 이 테스트는 마이그 0335의 SQL
# 문자열을 alembic 구동 없이 직접 복제 실행한다(destructive_schema가 create_all
# 기반이라 alembic 리비전 그래프 밖에 있어서 — 이 스위트의 다른 파일들과 동일한
# 관례). 즉 이 테스트는 "0335가 실제로 이 문장을 담고 있는가"까지는 못 잠근다 —
# 마이그 파일의 SQL이 나중에 바뀌면 이 복제본은 따라오지 않는 한 겹 얕은 원본이다.


@pytest.mark.anyio
async def test_backfill_migration_fixes_existing_drift_human_only():
    """마이그 0335 SQL 자체(직접 실행) — 기존 드리프트 행(휴먼)만 org_members 기준으로
    정정, 에이전트 members 행(org_role 개념 없음)은 건드리지 않는다."""
    from sqlalchemy import text as sa_text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            # 드리프트 재현: org_members=admin, members.org_role=member(수동 심기 — PATCH 우회).
            _user_id, om_id = await _seed_human_with_anchor(s, org_id, role="admin")
            await s.execute(sa_text(
                "UPDATE members SET org_role = 'member' WHERE id = :id"
            ), {"id": str(om_id)})
            await s.commit()

            # 페드루 PO 기록(PR#3852 리뷰, 비차단) — 표본이 휴먼 1명뿐이면 "에이전트
            # 행 불변" 단언이 0인 채로 통과할 수 있다. 에이전트 members 행(org_role
            # 임의값)을 같이 심어 백필이 그 행을 절대 건드리지 않는지 직접 확인한다.
            from app.models.member import Member
            agent_member_id = uuid.uuid4()
            s.add(Member(
                id=agent_member_id, org_id=org_id, type="agent", user_id=None,
                name="agent-drift-control", org_role="owner", is_active=True,
            ))
            await s.commit()

            assert await _get_member_org_role(s, om_id) == "member"

            # 마이그 0335의 실제 SQL(alembic 별도 구동 없이 동일 문 직접 실행 — 이 스위트는
            # create_all 기반 destructive_schema라 alembic 리비전 그래프 밖에 있다).
            await s.execute(sa_text(_BACKFILL_SQL))
            await s.commit()

            assert await _get_member_org_role(s, om_id) == "admin"
            assert await _get_member_org_role(s, agent_member_id) == "owner", (
                "에이전트 members 행(type != 'human')은 백필 대상이 아닌데 바뀌었다"
            )
    finally:
        await engine.dispose()

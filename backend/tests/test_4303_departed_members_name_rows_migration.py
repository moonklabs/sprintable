"""story #4303(PO 02:15Z · C안) — 마이그 0414: 0075가 빠뜨린 떠난 사람에게 이름만 든 members 행.

0075는 `org_members.deleted_at IS NULL`인 사람만 members 행 · 별칭을 만들었다. 그때 이미 떠났거나 org_members 행이 없는 옛 사람의
기록은 옛 team_members_legacy id 그대로라 이름 풀이가 «알 수 없는 구성원». 0414는 그 id로 이름 · 종류만 든 members 행을 만든다.

- 대상: legacy 휴먼 · 별칭 없음 · 같은 id의 members 없음 · 남아 있는 org_members 없음. 남아 있는 사람(별칭만 빠짐) · 별칭 있는 사람 · 에이전트는 0.
- 모양: 이름 · type human · user_id/avatar/org_role/handle NULL · is_active false · deleted_at = org_members 떠난 시각 > legacy deleted_at > 마이그 시각.
- 다른 조직의 떠난 사람은 **그 조직의** 행으로(조직 섞임 0).
- 다운: 같은 술어로 이 모양의 행만 지운다 — 떠남 흐름이 남긴 행(user_id 있음 · deleted_at NULL) · 남의 행은 그대로. 업 두 번 = 한 번.

CI destructive 샤드는 create_all 템플릿이라 team_members_legacy(0088 rename의 실 테이블 · ORM 모델 없음)가 없다 → 이 파일이
0414 술어가 읽는 칸만 가진 legacy 테이블을 만든다(마이그 DB엔 이미 있음 → IF NOT EXISTS).
"""
from __future__ import annotations

import importlib.util
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

pytestmark = pytest.mark.destructive_schema

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0414_departed_members_name_rows.py")

# 떠난 시각 · legacy 시각은 지금 기준 상대값(벽시계 고정 리터럴 금지 — lint_no_hardcoded_iso_timestamp). 둘을 달리 둬 어느 쪽을 골랐는지 가른다.
_OM_LEFT_AT = (datetime.now(UTC) - timedelta(days=120)).replace(microsecond=0)
_LEGACY_DELETED_AT = (datetime.now(UTC) - timedelta(days=180)).replace(microsecond=0)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0414", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _run(eng, mig, fn_name: str) -> None:
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with eng.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            getattr(mig, fn_name)()


def _engine():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    return sa.create_engine(sync_url)


def _seed(c):
    """조직 A · B. legacy 행 일곱 갈래와 떠남 흐름이 남긴 members 행 하나를 심는다. 돌려주는 값 = 갈래 이름 → id.
    ORM 테이블은 Core insert로 심는다 — 모델의 파이썬 쪽 기본값(plan · role · login_fail_count 등)이 채워지게."""
    import sqlalchemy as sa

    from app.models.member import Member, MemberIdentityAlias
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    def ins(model, **values) -> None:
        c.execute(model.__table__.insert().values(**values))

    c.execute(sa.text(
        "CREATE TABLE IF NOT EXISTS team_members_legacy ("
        " id uuid PRIMARY KEY, project_id uuid, org_id uuid NOT NULL, type text NOT NULL, user_id uuid,"
        " name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)"
    ))
    org = {k: uuid.uuid4() for k in ("a", "b")}
    project = {}
    for k, oid in org.items():
        ins(Organization, id=oid, name=f"Org {k}", slug=f"org-{oid.hex[:8]}")
        project[k] = uuid.uuid4()
        ins(Project, id=project[k], org_id=oid, name=f"P {k}")

    def user(key: str) -> uuid.UUID:
        uid = uuid.uuid4()
        ins(User, id=uid, email=f"{key}-{uid.hex[:8]}@test.com", hashed_password="x", display_name=f"사용자 {key}")
        return uid

    def org_member(org_key: str, uid: uuid.UUID, left_at: datetime | None) -> uuid.UUID:
        omid = uuid.uuid4()
        ins(OrgMember, id=omid, org_id=org[org_key], user_id=uid, role="member", deleted_at=left_at)
        return omid

    def legacy(org_key: str, uid: uuid.UUID | None, name: str, *, type_: str = "human", deleted_at: datetime | None = None) -> uuid.UUID:
        lid = uuid.uuid4()
        c.execute(sa.text(
            "INSERT INTO team_members_legacy (id, project_id, org_id, type, user_id, name, deleted_at)"
            " VALUES (:id, :p, :o, :t, :u, :n, :d)"
        ), {"id": lid, "p": project[org_key], "o": org[org_key], "t": type_, "u": uid, "n": name, "d": deleted_at})
        return lid

    ids: dict[str, uuid.UUID] = {"org_a": org["a"], "org_b": org["b"]}
    # ① 떠난 사람(org_members 떠난 시각 있음) — 대상 · deleted_at = 그 시각.
    u = user("left")
    org_member("a", u, _OM_LEFT_AT)
    ids["left_om"] = legacy("a", u, "떠난 사람")
    # ② org_members 행이 아예 없는 옛 사람 · legacy deleted_at 있음 — 대상 · deleted_at = legacy 시각.
    ids["no_om_legacy_deleted"] = legacy("a", user("old1"), "옛 사람 하나", deleted_at=_LEGACY_DELETED_AT)
    # ③ org_members 없음 · legacy deleted_at도 없음 — 대상 · deleted_at = 마이그 시각(떠난 때를 지어내지 않음).
    ids["no_om_no_time"] = legacy("a", user("old2"), "옛 사람 둘")
    # ④ 남아 있는 사람인데 별칭만 없음 — 대상 아님(떠난 사람으로 지어내지 않음).
    u = user("stayer")
    org_member("a", u, None)
    ids["stayer_no_alias"] = legacy("a", u, "남은 사람")
    # ⑤ 별칭 있는 사람 — 대상 아님(0075가 이미 이음).
    u = user("aliased")
    om_aliased = org_member("a", u, None)
    ins(Member, id=om_aliased, org_id=org["a"], type="human", user_id=u, name="이어진 사람", is_active=True)
    ids["aliased"] = legacy("a", u, "이어진 사람")
    ins(MemberIdentityAlias, alias_id=ids["aliased"], member_id=om_aliased, org_id=org["a"], project_id=project["a"],
        alias_source="human_team_member")
    # ⑥ 에이전트 legacy 행 — 대상 아님.
    ids["agent"] = legacy("a", None, "옛 에이전트", type_="agent")
    # ⑦ 다른 조직의 떠난 사람 — 대상 · 그 조직(B)의 행.
    u = user("other")
    org_member("b", u, _OM_LEFT_AT)
    ids["other_org_left"] = legacy("b", u, "다른 조직의 떠난 사람")
    # 떠남 흐름(delete_org_member)이 남긴 members 행 — user_id 있음 · deleted_at NULL · is_active false. 다운이 건드리면 안 된다.
    u = user("flow")
    om_flow = org_member("a", u, _OM_LEFT_AT)
    ins(Member, id=om_flow, org_id=org["a"], type="human", user_id=u, name="떠남 흐름", is_active=False)
    ids["flow_member"] = om_flow
    return ids


def _members(c, ids: list[uuid.UUID]):
    import sqlalchemy as sa

    rows = c.execute(sa.text(
        "SELECT id, org_id, type, user_id, name, avatar_url, org_role, handle, is_active, deleted_at, message_policy_mode"
        " FROM members WHERE id = ANY(:ids)"
    ), {"ids": ids}).mappings().all()
    return {r["id"]: dict(r) for r in rows}


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_upgrade_creates_name_only_rows_for_departed_and_downgrade_removes_only_them():
    import sqlalchemy as sa

    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 싣는다.
    from app.core.database import Base

    eng = _engine()
    mig = _load_migration()
    try:
        # destructive 파일은 conftest가 실행 전 스키마를 비운다 → 모델 테이블을 짓고(legacy는 _seed가) 시작.
        Base.metadata.create_all(eng)
        with eng.begin() as c:
            ids = _seed(c)
        targets = ["left_om", "no_om_legacy_deleted", "no_om_no_time", "other_org_left"]
        non_targets = ["stayer_no_alias", "aliased", "agent"]
        watched = [ids[k] for k in targets + non_targets] + [ids["flow_member"]]
        with eng.begin() as c:
            before = _members(c, watched)
            before_total = c.execute(sa.text("SELECT count(*) FROM members")).scalar_one()
        assert all(ids[k] not in before for k in targets)

        started = datetime.now(UTC)
        _run(eng, mig, "upgrade")
        with eng.begin() as c:
            after = _members(c, watched)
            after_total = c.execute(sa.text("SELECT count(*) FROM members")).scalar_one()

        # 대상 넷만 생긴다(업 전 dry-run 수와 같은 셈).
        assert after_total - before_total == len(targets)
        for k in targets:
            row = after[ids[k]]
            assert row["type"] == "human"
            assert (row["user_id"], row["avatar_url"], row["org_role"], row["handle"]) == (None, None, None, None), k
            assert row["is_active"] is False, k
            assert row["deleted_at"] is not None, k
            assert row["message_policy_mode"] == "creator_only"
        assert after[ids["left_om"]]["name"] == "떠난 사람"
        assert after[ids["left_om"]]["org_id"] == ids["org_a"]
        # deleted_at 근거: org_members 떠난 시각 > legacy deleted_at > 마이그 시각.
        assert after[ids["left_om"]]["deleted_at"] == _OM_LEFT_AT
        assert after[ids["no_om_legacy_deleted"]]["deleted_at"] == _LEGACY_DELETED_AT
        assert after[ids["no_om_no_time"]]["deleted_at"] >= started
        # 다른 조직의 떠난 사람은 그 조직의 행.
        assert after[ids["other_org_left"]]["org_id"] == ids["org_b"]
        # 대상 아님: 남은 사람(별칭만 없음) · 별칭 있는 사람 · 에이전트 — 새 행 0.
        for k in non_targets:
            assert ids[k] not in after, k
        # 떠남 흐름 행은 그대로.
        assert after[ids["flow_member"]] == before[ids["flow_member"]]

        # 업 두 번 = 한 번(ON CONFLICT DO NOTHING).
        _run(eng, mig, "upgrade")
        with eng.begin() as c:
            assert c.execute(sa.text("SELECT count(*) FROM members")).scalar_one() == after_total

        _run(eng, mig, "downgrade")
        with eng.begin() as c:
            downed = _members(c, watched)
            downed_total = c.execute(sa.text("SELECT count(*) FROM members")).scalar_one()
        # 다운 = 원상: 대상 넷만 사라지고 떠남 흐름 행 · 나머지는 그대로.
        assert downed_total == before_total
        assert downed == before
    finally:
        eng.dispose()

"""story #3635(BE·결함 클래스 근본·prod, 페드루 PO 確定 2026-09-07) — 휴먼 org_member의
members 앵커 부재를 뿌리에서 닫는다. #3627/#3629/#3634가 자리별로(is_human_member_
condition·filter_human_member_ids·ensure_human_member lazy call) 막은 것을, 이 스토리는
데이터(백필 마이그)+생성 경로(OrgMemberRepository.create) 전수로 뿌리에서 닫는다.

세팅 헬퍼는 test_2301_story_body_mentions_realdb.py·test_2288_command_center_gate_
type_waiting_realdb.py 재사용(중복 재발명 금지, #3629/#3634와 동일 관례) — 실 alembic
마이그레이션 스키마 대상(team_members는 read-only VIEW라 create_all 기반 픽스처를 못 쓴다,
test_member_ssot_parity_realdb.py가 obsolete로 skip된 이유와 동형)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL, _make_org, _make_project, _session_factory
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_org_member_only_human(session, org_id, *, role="member"):
    """team_members/members 앵커가 아예 없는 SSOT-only 휴먼 — org_members 딱 1행만
    (#3629/#3634와 동일 헬퍼 모양)."""
    from app.models.user import User
    from app.models.project import OrgMember

    user = User(id=uuid.uuid4(), email=f"story3635-{uuid.uuid4().hex[:8]}@t.test", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return om.id, user.id


async def _count_orphan_active_org_members(session, org_id) -> int:
    """AC1 불변식 — 활성 휴먼 org_member 중 members 앵커 행이 없는 것의 수(0이어야 정상)."""
    from sqlalchemy import select
    from app.models.member import Member
    from app.models.project import OrgMember

    rows = (await session.execute(
        select(OrgMember.id)
        .outerjoin(Member, Member.id == OrgMember.id)
        .where(OrgMember.org_id == org_id, OrgMember.deleted_at.is_(None), Member.id.is_(None))
    )).scalars().all()
    return len(rows)


# ─── AC2 — OrgMemberRepository.create()가 이제 앵커를 멱등 생성한다 ────────────


@pytest.mark.anyio
async def test_org_member_repository_create_ensures_member_anchor():
    """관리자 직접 추가(org_members.py:154, OrgMemberRepository.create 유일 호출부)도
    이제 members 앵커를 만든다 — 이전엔 이 자리만 ensure_human_member를 안 불렀다."""
    from app.models.member import Member
    from app.repositories.org_member import OrgMemberRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            repo = OrgMemberRepository(s, org.id)
            user_id = uuid.uuid4()
            om = await repo.create(user_id=user_id, role="member")

            anchor = await s.get(Member, om.id)
            assert anchor is not None
            assert anchor.type == "human"
            assert anchor.org_id == org.id

            assert await _count_orphan_active_org_members(s, org.id) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_member_repository_create_anchor_removed_is_orphan_regression(monkeypatch):
    """뮤테이션 — ensure_human_member 호출을 없애면(옛 동작 재현) 불변식 카운트가
    다시 1로 뜬다(이 카운트 테스트가 실제로 그 결함을 잡는다는 증거)."""
    import app.repositories.org_member as org_member_module

    async def _never_ensures(session, org_member_id):
        return False

    monkeypatch.setattr(
        "app.services.agent_anchor_sync.ensure_human_member", _never_ensures,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            repo = org_member_module.OrgMemberRepository(s, org.id)
            await repo.create(user_id=uuid.uuid4(), role="member")

            assert await _count_orphan_active_org_members(s, org.id) == 1
    finally:
        await engine.dispose()


# ─── AC2b — OrganizationRepository.create(owner_member_id=...)도 앵커를 만든다
# (4번째 생성 경로, PR#3987 qa:changes·카디르 재발견·페드루 코드 재확認 2026-09-07) ────


async def _seed_project_scoped_human(session, org_id, project_id):
    """team_members VIEW가 실제로 행을 내려면 project_access가 있어야 한다(0110 뷰 정의
    — project_access와의 JOIN이 필수). 완전 앵커된 휴먼(기존 test_2288 패턴 그대로,
    새 세팅 발명 0) — 이 스토리의 관심사는 「이 사람을 새 org의 owner로 지정했을 때 그
    새 org_member」쪽이지, 이 소스 멤버 자체의 앵커 상태가 아니다."""
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@t.test", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Owner")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id  # m.id == team_members.id(0110 뷰: SELECT m.id FROM members m ...)


@pytest.mark.anyio
async def test_organization_repository_create_with_owner_member_id_ensures_member_anchor():
    """POST /organizations에 owner_member_id를 지정한 생성 경로 — repositories/
    organization.py::create()의 owner_member_id 갈래(원자 INSERT ... FROM team_members)가
    이제 새로 만든 org의 org_member에도 members 앵커를 보장한다. 이전엔 organizations.py
    라우터의 owner_member_id=None 갈래만 ensure_human_member를 불렀다(4번째 생성 경로 갭)."""
    from sqlalchemy import select
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.repositories.organization import OrganizationRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            source_org = await _make_org(s)
            project = await _make_project(s, source_org.id)
            owner_member_id, owner_user_id = await _seed_project_scoped_human(s, source_org.id, project.id)

            repo = OrganizationRepository(s)
            new_org = await repo.create(
                name="New Org", slug=f"neworg-{uuid.uuid4().hex[:8]}", owner_member_id=owner_member_id,
            )
            await s.commit()

            new_om = (await s.execute(
                select(OrgMember).where(OrgMember.org_id == new_org.id, OrgMember.user_id == owner_user_id)
            )).scalar_one()
            anchor = await s.get(Member, new_om.id)
            assert anchor is not None, "owner_member_id 갈래로 만든 새 org의 org_member에 members 앵커가 없다"
            assert anchor.type == "human"
            assert anchor.org_id == new_org.id

            assert await _count_orphan_active_org_members(s, new_org.id) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_organization_repository_create_owner_member_id_anchor_removed_is_orphan_regression(monkeypatch):
    """뮤테이션 — 위 자리의 ensure_human_member 호출을 없애면(4번째 경로의 옛 결함
    재현) 새 org에도 다시 orphan org_member가 생긴다."""
    import app.repositories.organization as org_repo_module

    async def _never_ensures(session, org_member_id):
        return False

    # org_repo_module.create()가 함수 안에서 `from app.services.agent_anchor_sync import
    # ensure_human_member`를 그때그때 다시 부른다(지연 import, org_member.py 선례와 동형) —
    # 원본 모듈의 속성을 갈아끼우면 그 다음 호출부터 이 대역이 잡힌다.
    monkeypatch.setattr("app.services.agent_anchor_sync.ensure_human_member", _never_ensures)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            source_org = await _make_org(s)
            project = await _make_project(s, source_org.id)
            owner_member_id, owner_user_id = await _seed_project_scoped_human(s, source_org.id, project.id)

            repo = org_repo_module.OrganizationRepository(s)
            new_org = await repo.create(
                name="New Org", slug=f"neworg-{uuid.uuid4().hex[:8]}", owner_member_id=owner_member_id,
            )
            await s.commit()

            assert await _count_orphan_active_org_members(s, new_org.id) == 1, "뮤테이션이 걸리지 않았다"
    finally:
        await engine.dispose()


# ─── AC1 — 백필 마이그가 기존 갭을 채운다(마이그 SQL을 직접 재현·회귀) ─────────


@pytest.mark.anyio
async def test_backfill_query_fills_pre_existing_gap():
    """0352 마이그의 INSERT SELECT를 그대로 재현 — 백필 前엔 갭 1, 백필 뒤엔 0.

    story #3987 CI 실사고(2026-09-07, run 34121108303) — 대상 지정
    `ON CONFLICT (id) DO NOTHING`은 이 org_member의 (org_id, user_id)에 이미 id가
    다른 active human member 행이 있으면(공유 비-destructive DB에서 다른 자리가
    먼저 앵커를 만들어 둔 경우 등, uq_members_active_human 부분 유니크 인덱스)
    PK 충돌이 아니라서 그대로 UniqueViolation으로 죽는다 — 백필의 목표(그
    (org_id, user_id)에 앵커가 있다)는 이미 달성된 상태인데도 크래시하는 과잉이었다.
    마이그를 대상 없는 bare `ON CONFLICT DO NOTHING`으로 고쳤다 — 이 테스트도 그에
    맞춰 「id==om_id인 특정 행」이 아니라 「그 (org_id, user_id)에 active human
    anchor가 존재한다」는 백필의 실제 목표 자체를 단언한다(어느 경로로 채워졌든
    통과 — Pedro PO 방향)."""
    from sqlalchemy import select, text
    from app.models.member import Member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            om_id, user_id = await _seed_org_member_only_human(s, org.id)

            assert await _count_orphan_active_org_members(s, org.id) == 1

            # alembic/versions/0352_member_anchor_backfill_root_fix.py와 동일 SQL.
            await s.execute(text(
                """
                INSERT INTO members (id, org_id, type, user_id, owner_member_id, name, org_role, is_active, created_at, updated_at)
                SELECT om.id, om.org_id, 'human', u.id, NULL,
                       COALESCE(u.display_name, u.email, om.user_id::text),
                       om.role, true, om.created_at, now()
                FROM org_members om
                JOIN organizations o ON o.id = om.org_id
                LEFT JOIN users u ON u.id = om.user_id
                WHERE om.deleted_at IS NULL
                ON CONFLICT DO NOTHING
                """
            ))
            await s.commit()

            assert await _count_orphan_active_org_members(s, org.id) == 0
            anchor = (await s.execute(
                select(Member).where(
                    Member.org_id == org.id, Member.user_id == user_id,
                    Member.type == "human", Member.deleted_at.is_(None),
                )
            )).scalar_one()
            assert anchor.user_id == user_id
    finally:
        await engine.dispose()


# ─── AC4 — member_resolver 두 갈래(legacy/anchor)가 같은 id를 낸다 ─────────────


@pytest.mark.anyio
async def test_legacy_and_anchor_resolver_agree_after_anchor_exists():
    """백필로 앵커가 채워진 뒤(또는 정상 생성 경로로 이미 있는 뒤) legacy 갈래
    (org_members 직조회)와 anchor 갈래(members 조회)가 같은 id를 낸다 — 백필이
    「레거시 휴먼」 갈래를 「정상 앵커됨」 갈래로 옮겨도 신원(id)이 안 바뀜을
    못박는다(페드루 PO 지시)."""
    from unittest.mock import MagicMock
    from app.services.member_resolver import _resolve_member_anchor, _resolve_member_legacy
    from app.repositories.org_member import OrgMemberRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            repo = OrgMemberRepository(s, org.id)
            user_id = uuid.uuid4()
            om = await repo.create(user_id=user_id, role="member")  # 이제 앵커 자동 생성.

            auth = MagicMock()
            auth.user_id = str(user_id)
            auth.claims = {"app_metadata": {}}

            legacy = await _resolve_member_legacy(auth, org.id, s)
            anchor = await _resolve_member_anchor(auth, org.id, s)

            assert legacy.id == anchor.id == om.id
            assert legacy.type == anchor.type == "human"
    finally:
        await engine.dispose()


# ─── AC5 — is_human_member_condition의 deleted_at 가드(카디르 #3983 발견 흡수) ──


@pytest.mark.anyio
async def test_is_human_member_condition_excludes_soft_deleted_org_member_directly():
    """filter_human_member_ids를 거치지 않고 is_human_member_condition 자체를 직접
    단위 테스트한다(#3629는 filter_human_member_ids만 간접으로 잡았다 — 카디르 #3983
    지적).

    ⚠️ member_id_col에 OrgMember.id를 그대로 넣고 outer select도 OrgMember에서
    걸면(alias 없이) EXISTS 서브쿼리가 outer 행 자기 자신과 자동 상관돼(같은
    미별칭 테이블) "이 행이 존재하는가"라는 항진명제로 무너진다(memory:
    feedback_sqlalchemy_exists_alias_correlation_trap과 동형 함정). 실사용(예:
    filter_human_member_ids)은 항상 다른 테이블의 컬럼(ConversationParticipant.
    member_id 등)을 넘겨 이 문제가 없다 — 이 테스트는 리터럴 UUID 바인드 값을
    넘겨(어떤 테이블에도 안 묶임) 같은 함정을 피한다."""
    from sqlalchemy import literal, select, update
    from app.models.project import OrgMember
    from app.services.member_resolver import is_human_member_condition

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            om_id, _ = await _seed_org_member_only_human(s, org.id)

            # soft-delete 前 — 조건이 True.
            is_human_before = (await s.execute(
                select(is_human_member_condition(literal(om_id)))
            )).scalar_one()
            assert is_human_before is True

            await s.execute(update(OrgMember).where(OrgMember.id == om_id).values(deleted_at=datetime.now(timezone.utc)))
            await s.commit()

            is_human_after = (await s.execute(
                select(is_human_member_condition(literal(om_id)))
            )).scalar_one()
            assert is_human_after is False, "soft-delete된 org_member는 휴먼으로 인정되면 안 된다"
    finally:
        await engine.dispose()

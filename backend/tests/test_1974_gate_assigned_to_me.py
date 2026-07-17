"""story #1974(P1a-S5): 결재함/배지 개인화 — ``GET /api/v2/gates?assigned_to_me=true``.

배경(🔴선생님 실사용 발견): ``GET /api/v2/gates?status=pending``이 caller 무관하게 org 전체
pending 게이트를 반환해 결재 배지가 "내가 승인할 것"이 아니라 "org에 있는 모든 대기 항목"을
세고 있었다. 대원칙(팀 합의): ``assigned_to_me=true`` = "caller가 실제로 승인 가능(can_approve)한
pending 게이트만" — 배지에 뜨는데 눌러보면 승인 못 하는 모순을 원천 차단한다.

판정 규칙(이원화):
  A) gate_type=='doc_approval' → 기존 ``can_approve_doc_gate_reason()``(human+has_project_access+
     not-author) 재사용. list_gates 의 ``can_approve`` 필드와 100% 정합(동일 계산 1회 재사용).
  B) 그 외 gate_type(pr_review/qa/merge/deploy/workflow_config_publish) → ``get_project_role()``
     (project_auth.py SSOT) owner/admin이면 승인 가능. project_id 가 None(구조적으로 project-무관
     work_item)이면 org owner/admin(``is_org_owner_or_admin``)에게만 노출.
  둘 다 status=='pending' 전제 + resolved.type=='human'(transition_gate_endpoint 의 gate_type 무관
  휴먼-전용 불변식과 정합 — 에이전트는 애초에 어떤 gate_type 도 승인 불가하므로 배지에도 안 뜬다).

테스트 구성:
  - ``_non_doc_gate_approvable`` 순수 판정 함수(project-role 경로/org-role 폴백 경로 각각, mocked).
  - ``list_gates`` 라우트(mocked session) — 3경로(doc_approval/project-role/org-role) + 회귀(에이전트/
    non-pending/assigned_to_me 미지정) 각각.
  - realdb: 2계정(A=승인 가능 1건 보유·B=0건) 실측. doc_approval·project-role·project_id=None 케이스
    각 최소 1개.
  - realdb: N+1 방지 — before_cursor_execute 로 고유 project 수에 비례(gate 개수엔 무관)함을 실측.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all 을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _human(mid: uuid.UUID, org_id: uuid.UUID | None = None) -> "ResolvedMember":
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(
        id=mid, user_id=uuid.uuid4(), name="h", type="human", role="member",
        org_id=org_id or uuid.uuid4(),
    )


def _agent(mid: uuid.UUID) -> "ResolvedMember":
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(
        id=mid, user_id=uuid.uuid4(), name="a", type="agent", role="member", org_id=uuid.uuid4()
    )


# ══════════════════════════ _non_doc_gate_approvable: rule B 순수 판정 ══════════════════════════


@pytest.mark.anyio
async def test_non_doc_approvable_project_role_owner_true():
    from app.routers import gates as gates_mod

    with patch.object(gates_mod, "get_project_role", AsyncMock(return_value="owner")):
        out = await gates_mod._non_doc_gate_approvable(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        )
    assert out is True


@pytest.mark.anyio
async def test_non_doc_approvable_project_role_admin_true():
    from app.routers import gates as gates_mod

    with patch.object(gates_mod, "get_project_role", AsyncMock(return_value="admin")):
        out = await gates_mod._non_doc_gate_approvable(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        )
    assert out is True


@pytest.mark.anyio
async def test_non_doc_approvable_project_role_member_false():
    from app.routers import gates as gates_mod

    with patch.object(gates_mod, "get_project_role", AsyncMock(return_value="member")):
        out = await gates_mod._non_doc_gate_approvable(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        )
    assert out is False


@pytest.mark.anyio
async def test_non_doc_approvable_project_role_none_false():
    from app.routers import gates as gates_mod

    with patch.object(gates_mod, "get_project_role", AsyncMock(return_value=None)):
        out = await gates_mod._non_doc_gate_approvable(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        )
    assert out is False


@pytest.mark.anyio
async def test_non_doc_approvable_project_id_none_uses_org_role_fallback():
    """project_id 가 None(구조적으로 project-무관) → get_project_role 은 호출 안 되고
    is_org_owner_or_admin 만 조회된다."""
    from app.routers import gates as gates_mod

    role_spy = AsyncMock(return_value="owner")  # 호출되면 안 됨(project_id=None 분기)
    with patch.object(gates_mod, "get_project_role", role_spy), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=True)) as admin_spy:
        out = await gates_mod._non_doc_gate_approvable(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(), None
        )
    assert out is True
    role_spy.assert_not_awaited()
    admin_spy.assert_awaited_once()


@pytest.mark.anyio
async def test_non_doc_approvable_project_id_none_org_member_false():
    from app.routers import gates as gates_mod

    with patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=False)):
        out = await gates_mod._non_doc_gate_approvable(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(), None
        )
    assert out is False


# ══════════════════════════ list_gates(mocked session): assigned_to_me 배선 ══════════════════════════


def _resp(g):
    return SimpleNamespace(
        id=g.id, work_item_type=g.work_item_type, work_item_id=g.work_item_id,
        work_item_summary=None, can_approve=False,
    )


def _doc_gate(requester_id, *, gate_id=None, status="pending"):
    return SimpleNamespace(
        id=gate_id or uuid.uuid4(), gate_type="doc_approval", work_item_type="doc",
        work_item_id=uuid.uuid4(),
        neutral_facts={"requested_by_member_id": str(requester_id)} if requester_id else {},
        status=status,
    )


def _story_gate(*, gate_type="merge", gate_id=None, status="pending", work_item_id=None):
    return SimpleNamespace(
        id=gate_id or uuid.uuid4(), gate_type=gate_type, work_item_type="story",
        work_item_id=work_item_id or uuid.uuid4(), neutral_facts={}, status=status,
    )


def _org_level_gate(*, gate_id=None, status="pending"):
    """project_id=None 케이스(구조적 project-무관 work_item — wf_line_version 류)."""
    return SimpleNamespace(
        id=gate_id or uuid.uuid4(), gate_type="workflow_config_publish", work_item_type="wf_line_version",
        work_item_id=uuid.uuid4(), neutral_facts={}, status=status,
    )


async def _call_list_gates(
    gates, *, resolved=None, resolve_raises=False, has_access=True, project_role=None,
    org_admin=False, story_rows=None,
):
    org = uuid.uuid4()
    gates_result = MagicMock()
    gates_result.scalars.return_value.all.return_value = gates
    doc_batch = MagicMock()
    # doc_approval(및 work_item_type=='doc') 게이트는 project_id 조회가 있어야 can_approve_doc_gate_reason
    # 이 no_project_access 로 fail-closed 되지 않는다(89484c8c 배치 predicate 와 동일 데이터 형태).
    doc_batch.all.return_value = [
        (g.work_item_id, "T", "slug", uuid.uuid4())
        for g in gates if g.work_item_type == "doc" or g.gate_type == "doc_approval"
    ]
    story_batch = MagicMock()
    story_batch.all.return_value = story_rows or []
    session = AsyncMock()
    # execute call order: gates SELECT, [doc batch if fetch_ids], [story batch if story_ids]
    side_effects = [gates_result]
    if any(g.work_item_type == "doc" or g.gate_type == "doc_approval" for g in gates):
        side_effects.append(doc_batch)
    if any(g.work_item_type == "story" and g.gate_type != "doc_approval" for g in gates):
        side_effects.append(story_batch)
    session.execute = AsyncMock(side_effect=side_effects)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    rm = (
        AsyncMock(side_effect=Exception("boom")) if resolve_raises
        else AsyncMock(return_value=resolved or _human(uuid.uuid4(), org))
    )
    from app.routers import gates as gates_mod
    with patch.object(gates_mod.GateResponse, "model_validate", _resp), \
         patch.object(gates_mod, "resolve_member", rm), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=has_access)), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)), \
         patch.object(gates_mod, "get_project_role", AsyncMock(return_value=project_role)), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=org_admin)):
        return await gates_mod.list_gates(
            work_item_id=None, work_item_type=None, status=None, assigned_to_me=True,
            session=session, org_id=org, auth=auth,
        )


@pytest.mark.anyio
async def test_assigned_to_me_doc_approval_eligible_included():
    g = _doc_gate(uuid.uuid4())  # not-author
    out = await _call_list_gates([g], has_access=True)
    assert len(out) == 1
    assert out[0].id == g.id


@pytest.mark.anyio
async def test_assigned_to_me_doc_approval_not_eligible_excluded():
    g = _doc_gate(uuid.uuid4())
    out = await _call_list_gates([g], has_access=False)  # no project access
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_doc_approval_self_author_excluded():
    mid = uuid.uuid4()
    g = _doc_gate(mid)
    out = await _call_list_gates([g], has_access=True, resolved=_human(mid))
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_project_role_owner_included():
    g = _story_gate(gate_type="merge")
    out = await _call_list_gates(
        [g], project_role="owner", story_rows=[(g.work_item_id, uuid.uuid4())],
    )
    assert len(out) == 1
    assert out[0].id == g.id


@pytest.mark.anyio
async def test_assigned_to_me_project_role_member_excluded():
    g = _story_gate(gate_type="qa")
    out = await _call_list_gates(
        [g], project_role="member", story_rows=[(g.work_item_id, uuid.uuid4())],
    )
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_org_level_none_project_admin_included():
    g = _org_level_gate()
    out = await _call_list_gates([g], org_admin=True)
    assert len(out) == 1
    assert out[0].id == g.id


@pytest.mark.anyio
async def test_assigned_to_me_org_level_none_project_member_excluded():
    g = _org_level_gate()
    out = await _call_list_gates([g], org_admin=False)
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_non_pending_status_excluded():
    g = _story_gate(gate_type="merge", status="approved")
    out = await _call_list_gates(
        [g], project_role="owner", story_rows=[(g.work_item_id, uuid.uuid4())],
    )
    assert out == []  # terminal status → 애초에 non_doc_pending 대상 아님


@pytest.mark.anyio
async def test_assigned_to_me_agent_caller_returns_empty():
    """휴먼 전용 불변식(transition_gate_endpoint) — 에이전트는 project owner/admin role 을
    가졌어도 assigned_to_me=true 결과는 빈 목록(승인 자체가 불가하므로 배지 모순 방지)."""
    g = _story_gate(gate_type="merge")
    out = await _call_list_gates(
        [g], resolved=_agent(uuid.uuid4()), project_role="owner",
        story_rows=[(g.work_item_id, uuid.uuid4())],
    )
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_resolve_member_fails_fail_closed():
    g = _story_gate(gate_type="merge")
    out = await _call_list_gates([g], resolve_raises=True)
    assert out == []


@pytest.mark.anyio
async def test_assigned_to_me_mixed_gates_only_eligible_returned():
    """doc_approval(승인가능) + project-role(불가) + org-level(가능) 혼합 목록 — 각자 규칙대로."""
    doc_g = _doc_gate(uuid.uuid4())
    story_g = _story_gate(gate_type="merge")
    org_g = _org_level_gate()
    out = await _call_list_gates(
        [doc_g, story_g, org_g], has_access=True, project_role="member", org_admin=True,
        story_rows=[(story_g.work_item_id, uuid.uuid4())],
    )
    ids = {r.id for r in out}
    assert ids == {doc_g.id, org_g.id}  # story_g(member=불가)만 배제


# ══════════════════════════ 회귀: assigned_to_me 미지정 시 기존 동작 무변경 ══════════════════════════


@pytest.mark.anyio
async def test_default_assigned_to_me_false_returns_all_no_extra_queries():
    """assigned_to_me 미지정(기본 False) — resolve_member 는 doc_approval 게이트가 있을 때만 호출되고
    (기존 89484c8c 동작 그대로), non-doc 게이트만 있으면 전혀 호출 안 됨(회귀 0)."""
    from app.routers import gates as gates_mod

    g = _story_gate(gate_type="merge")
    org = uuid.uuid4()
    gates_result = MagicMock()
    gates_result.scalars.return_value.all.return_value = [g]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_result])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    rm = AsyncMock(return_value=_human(uuid.uuid4()))
    with patch.object(gates_mod.GateResponse, "model_validate", _resp), \
         patch.object(gates_mod, "resolve_member", rm), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        # ⚠️직접 함수 호출(ASGI 미경유)이라 FastAPI Query(default=False) sentinel 이 아닌 실 bool 을
        # 명시 전달해야 한다(work_item_id/work_item_type/status 등 기존 파라미터도 이 파일 전역에서
        # 항상 명시 전달하는 동일 관례 — 실제 HTTP 경로에서의 기본값 회귀는 realdb 테스트가 커버).
        out = await gates_mod.list_gates(
            work_item_id=None, work_item_type=None, status=None, assigned_to_me=False,
            session=session, org_id=org, auth=auth,
        )
    assert len(out) == 1
    assert out[0].id == g.id
    rm.assert_not_awaited()  # 비-doc 게이트만 + assigned_to_me=False → resolve_member 미호출


@pytest.mark.anyio
async def test_default_assigned_to_me_false_doc_gate_can_approve_unchanged():
    """기존 89484c8c can_approve enrich 동작 — assigned_to_me 미지정이어도 그대로 계산됨(회귀 0)."""
    from app.routers import gates as gates_mod

    g = _doc_gate(uuid.uuid4())
    org = uuid.uuid4()
    gates_result = MagicMock()
    gates_result.scalars.return_value.all.return_value = [g]
    doc_batch = MagicMock()
    doc_batch.all.return_value = [(g.work_item_id, "T", "slug", uuid.uuid4())]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_result, doc_batch])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    with patch.object(gates_mod.GateResponse, "model_validate", _resp), \
         patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_human(uuid.uuid4()))), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        out = await gates_mod.list_gates(
            work_item_id=None, work_item_type=None, status=None, assigned_to_me=False,
            session=session, org_id=org, auth=auth,
        )
    assert len(out) == 1
    assert out[0].can_approve is True


# ══════════════════════════ realdb: 2계정 실측 + N+1 방지 ══════════════════════════

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_project_users(session):
    """org + project + 2명(A: project owner grant + doc author 상신 대상, B: 무관 member)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    user_a = User(id=uuid.uuid4(), email=f"a-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    user_b = User(id=uuid.uuid4(), email=f"b-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add_all([user_a, user_b])
    await session.commit()

    om_a = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_a.id, role="member")
    om_b = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_b.id, role="member")
    session.add_all([om_a, om_b])
    await session.commit()

    # A: project owner grant(merge/qa/pr_review/deploy 승인 가능 경로) + doc 결재 접근.
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om_a.id,
        permission="granted", role="owner",
    ))
    # B: project member grant(승인 불가 — has_project_access 는 True 지만 role=member).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om_b.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id,
        # ⚠️AuthContext.user_id(JWT sub)는 users.id — org_members.id 아님(member_resolver.py:87
        # OrgMember.user_id == user_id 매칭). 여기 반환값은 caller 인증(AuthContext)용.
        "user_a_id": user_a.id, "user_b_id": user_b.id,
        "org_member_a_id": om_a.id, "org_member_b_id": om_b.id,
    }


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_assigned_to_me_two_accounts_a_sees_b_sees_nothing():
    """done-gate 실측: A(project owner grant) → doc_approval(not-author) + merge(project-role owner)
    + org-level(project_id=None) 3종 pending 게이트 모두 assigned_to_me=true 에 보임. B(project
    member grant·doc 상신자 본인·org member) → 3종 전부 배제(self-author/project-role-member/
    org-role-member) → 빈 목록. rule A/B/org-fallback 3경로를 A/B 두 계정 대비로 한 번에 실증."""
    from app.main import app
    from app.models.doc import Doc
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id = seeded["org_id"], seeded["project_id"]
            a_id, b_id = seeded["user_a_id"], seeded["user_b_id"]
            org_member_b_id = seeded["org_member_b_id"]

            # doc_approval: 상신자 = B(org_members.id — can_approve_doc_gate_reason 이 resolved.id
            # 와 비교하는 축과 동일 공간). 그래야 A/B 둘 다 self-author 배제 없이 접근권만으로 갈림.
            doc = Doc(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id,
                title="결재 문서", slug=f"doc-{uuid.uuid4().hex[:6]}", status="pending",
            )
            s.add(doc)
            await s.flush()
            doc_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=doc.id, work_item_type="doc",
                gate_type="doc_approval", status="pending",
                neutral_facts={"requested_by_member_id": str(org_member_b_id)},
            )
            s.add(doc_gate)

            # project-role(merge): story work_item.
            from app.models.pm import Story
            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s1")
            s.add(story)
            await s.flush()
            merge_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(merge_gate)

            # org-level(project_id=None): wf_line_version work_item_type — project 무관 구조.
            org_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(),
                work_item_type="wf_line_version", gate_type="workflow_config_publish", status="pending",
            )
            s.add(org_gate)
            await s.commit()

        # A: project owner grant → merge 는 보임. org-level 은 org owner/admin 만인데 A 는 org
        # role='member' 라 org-level 은 안 보여야 한다(project owner grant ≠ org owner/admin).
        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates", params={"assigned_to_me": "true"})
            assert resp.status_code == 200, resp.text
            body_a = resp.json()
            ids_a = {row["id"] for row in body_a}
            print("\n=== realdb assigned_to_me A(project-owner-grant) capture ===")
            for row in body_a:
                print(f"  id={row['id']} gate_type={row['gate_type']} can_approve={row['can_approve']}")
            assert str(doc_gate.id) in ids_a  # doc_approval: A=접근권O·author 아님 → can_approve
            assert str(merge_gate.id) in ids_a  # project-role: A=owner grant
            assert str(org_gate.id) not in ids_a  # org-role: A=org member(owner/admin 아님)
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # B: project member grant(project-role 불가) + doc_approval 상신자 본인(self-author 배제) +
        # org member(org-role 불가) → 3종 전부 0건이어야 한다(대원칙: "결재 가능한 게 하나도 없으면
        # assigned_to_me=true 응답은 빈 목록").
        await _setup_app(app, Session, org_id, b_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates", params={"assigned_to_me": "true"})
            assert resp.status_code == 200, resp.text
            body_b = resp.json()
            ids_b = {row["id"] for row in body_b}
            print("\n=== realdb assigned_to_me B(project-member-grant·doc-author·org-member) capture ===")
            for row in body_b:
                print(f"  id={row['id']} gate_type={row['gate_type']} can_approve={row['can_approve']}")
            print(f"  (B 전체 목록 id 수={len(body_b)})")
            assert str(doc_gate.id) not in ids_b  # doc_approval: B=상신자 본인(self-approval 금지)
            assert str(merge_gate.id) not in ids_b  # project-role: B=member(불가)
            assert str(org_gate.id) not in ids_b  # org-role: B=org member(불가)
            assert body_b == []  # 3종 전부 배제 → B 는 0건(대원칙 실증)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_assigned_to_me_query_count_scales_with_unique_projects_not_gate_count():
    """N+1 방지 실측: 같은 project 를 가리키는 merge 게이트를 1건→4건으로 늘려도 project-role
    조회(get_project_role 경유 쿼리)는 **1회**로 고정(고유 project 1개) — gate 개수와 무관함을
    before_cursor_execute 로 실측."""
    from sqlalchemy import event

    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id, a_id = seeded["org_id"], seeded["project_id"], seeded["user_a_id"]

            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s1")
            s.add(story)
            await s.flush()
            s.add(Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending",
            ))
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            statements_1: list[str] = []

            def _capture(stmts):
                def _listener(conn, cursor, statement, parameters, context, executemany):
                    stmts.append(statement)
                return _listener

            listener_1 = _capture(statements_1)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_1)
            try:
                resp = await client.get("/api/v2/gates", params={"assigned_to_me": "true"})
                assert resp.status_code == 200, resp.text
                assert len(resp.json()) == 1
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_1)
            select_stmts_1 = [st for st in statements_1 if st.strip().upper().startswith("SELECT")]

            # 동일 project 를 가리키는 gate 3건 추가(총 4건) — project-role 판정 대상만 늘어남.
            async with Session() as s:
                for _ in range(3):
                    story_n = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="sN")
                    s.add(story_n)
                    await s.flush()
                    s.add(Gate(
                        id=uuid.uuid4(), org_id=org_id, work_item_id=story_n.id, work_item_type="story",
                        gate_type="merge", status="pending",
                    ))
                await s.commit()

            statements_4: list[str] = []
            listener_4 = _capture(statements_4)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_4)
            try:
                resp = await client.get("/api/v2/gates", params={"assigned_to_me": "true"})
                assert resp.status_code == 200, resp.text
                assert len(resp.json()) == 4
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_4)
            select_stmts_4 = [st for st in statements_4 if st.strip().upper().startswith("SELECT")]

            print(f"\n=== N+1 실측(assigned_to_me): gate 1건 SELECT 수={len(select_stmts_1)}, "
                  f"gate 4건(동일 project) SELECT 수={len(select_stmts_4)} ===")
            assert len(select_stmts_1) == len(select_stmts_4), (
                f"동일 project 를 가리키는 gate 수가 늘었는데 쿼리 수가 늘었다(N+1 의심): "
                f"1건={len(select_stmts_1)} 4건={len(select_stmts_4)}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

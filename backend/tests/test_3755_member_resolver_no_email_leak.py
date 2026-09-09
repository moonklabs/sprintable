"""story #3755(BE·표시명·결함 클래스·high·별건 ④, 페드루 PO 決 2026-09-09) — member_resolver.py
전 경로(5자리: _resolve_member_legacy·_resolve_member_anchor·_lookup_members_by_ids_legacy·
_lookup_members_by_ids_anchor·resolve_member_identity)가 휴먼 display_name이 없을 때
`user.email`이나 id 문자열을 name으로 지어내지 않고 정직하게 None을 돌리는지 고정한다.

#3747에서 `resolve_member_display_name()`(content-rules 화면 하나)만 이 계약을 가졌었고,
같은 email 폴백이 5자리 전부에 그대로 남아 있었다(활동 로그·대화·이벤트 등 이 모듈을 쓰는
모든 화면에 email이 새고 있었다) — 이 파일이 그 클래스 자체가 닫혔음을 5자리 전부에서
개별 pin한다. 양성대조 = display_name이 NULL인 휴먼 사용자(email은 항상 채워져 있다는
전제 — User.email NOT NULL — 이라 폴백이 살아있으면 반드시 「@」가 새로 보인다).

fixture는 실 org/실 사용자를 안 건드리는 순수 mock(테스트 org만, 페드루 PO 지시)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.member_resolver import (
    lookup_members_by_ids,
    resolve_member,
    resolve_member_identity,
)

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
NO_EMAIL_LEAK_SENTINEL = "ghost-no-display-name@test.example"  # display_name=None인 휴먼의 email — name에 절대 새면 안 된다.


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.claims = {"app_metadata": {}}
    return ctx


def _sql_result(*, scalar=None, first=None, all_=None, rows=None):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar
    r.scalars.return_value.first.return_value = first
    r.scalars.return_value.all.return_value = all_ if all_ is not None else []
    r.all.return_value = rows if rows is not None else []
    return r


def _assert_no_email_leak(name: str | None) -> None:
    assert name is None, f"display_name 없는 휴먼의 name이 None이 아니다(email/id 폴백 의심): {name!r}"
    # 이중 확認 — None이 아닌데 값이 있었다면 반드시 여기서도 걸린다(assert 위에서 이미
    # 멈추지만, 호출부가 실수로 None 대신 "" 등 다른 falsy를 넣는 회귀까지 방어).
    if name is not None:
        assert "@" not in name


# ── resolve_member — legacy(_resolve_member_legacy) ────────────────────────────

@pytest.mark.anyio
async def test_resolve_member_legacy_human_no_display_name_is_none(monkeypatch):
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", False)
    monkeypatch.setattr(mr, "has_project_access", AsyncMock(return_value=True))

    om = MagicMock(spec=["id", "user_id", "org_id", "role", "deleted_at"])
    om.id = uuid.uuid4(); om.user_id = USER_ID; om.org_id = ORG_ID; om.role = "member"; om.deleted_at = None

    user = MagicMock()
    user.display_name = None
    user.email = NO_EMAIL_LEAK_SENTINEL

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_sql_result(scalar=om), _sql_result(scalar=user)])

    resolved = await mr.resolve_member(_auth(USER_ID), ORG_ID, session, project_id=None)
    _assert_no_email_leak(resolved.name)
    assert resolved.id == om.id  # 신원 축(.id)은 name과 무관하게 그대로 유지.


@pytest.mark.anyio
async def test_resolve_member_legacy_human_with_display_name_positive_control(monkeypatch):
    """양성대조 — display_name이 있으면 그 값이 그대로 나온다(테스트가 항상 None만 통과시키는
    허수아비가 아님을 증명)."""
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", False)
    monkeypatch.setattr(mr, "has_project_access", AsyncMock(return_value=True))

    om = MagicMock(spec=["id", "user_id", "org_id", "role", "deleted_at"])
    om.id = uuid.uuid4(); om.user_id = USER_ID; om.org_id = ORG_ID; om.role = "member"; om.deleted_at = None

    user = MagicMock()
    user.display_name = "테스트 사용자"
    user.email = NO_EMAIL_LEAK_SENTINEL

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_sql_result(scalar=om), _sql_result(scalar=user)])

    resolved = await mr.resolve_member(_auth(USER_ID), ORG_ID, session, project_id=None)
    assert resolved.name == "테스트 사용자"


# ── resolve_member — anchor(_resolve_member_anchor), members 앵커 매칭 분기 ────

@pytest.mark.anyio
async def test_resolve_member_anchor_member_found_human_no_display_name_is_none(monkeypatch):
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    monkeypatch.setattr(mr, "has_project_access", AsyncMock(return_value=True))

    m = MagicMock()
    m.id = uuid.uuid4(); m.org_id = ORG_ID; m.org_role = "member"; m.avatar_url = None

    user = MagicMock()
    user.display_name = None
    user.email = NO_EMAIL_LEAK_SENTINEL

    session = AsyncMock()
    # Member(human) 매칭 → User 조회.
    session.execute = AsyncMock(side_effect=[_sql_result(scalar=m), _sql_result(scalar=user)])

    resolved = await mr.resolve_member(_auth(USER_ID), ORG_ID, session, project_id=None)
    _assert_no_email_leak(resolved.name)


# ── resolve_member — anchor, members 앵커 없어 org_members 폴백 분기 ───────────

@pytest.mark.anyio
async def test_resolve_member_anchor_org_member_fallback_no_display_name_is_none(monkeypatch):
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)
    monkeypatch.setattr(mr, "has_project_access", AsyncMock(return_value=True))

    om = MagicMock(spec=["id", "user_id", "org_id", "role", "deleted_at"])
    om.id = uuid.uuid4(); om.user_id = USER_ID; om.org_id = ORG_ID; om.role = "member"; om.deleted_at = None

    user = MagicMock()
    user.display_name = None
    user.email = NO_EMAIL_LEAK_SENTINEL

    session = AsyncMock()
    # Member(human) → None(앵커 미존재) → User(email 조회) → OrgMember(폴백).
    session.execute = AsyncMock(side_effect=[
        _sql_result(scalar=None), _sql_result(scalar=user), _sql_result(scalar=om),
    ])

    resolved = await mr.resolve_member(_auth(USER_ID), ORG_ID, session, project_id=None)
    _assert_no_email_leak(resolved.name)


# ── lookup_members_by_ids — legacy(_lookup_members_by_ids_legacy), OrgMember 분기 ──

@pytest.mark.anyio
async def test_lookup_members_by_ids_legacy_org_member_no_display_name_is_none(monkeypatch):
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", False)

    mid = uuid.uuid4()
    om = MagicMock(spec=["id", "user_id", "org_id", "role"])
    om.id = mid; om.user_id = USER_ID; om.org_id = ORG_ID; om.role = "member"

    user = MagicMock()
    user.id = USER_ID
    user.display_name = None

    session = AsyncMock()
    # TeamMember.in_ → []  /  OrgMember.in_(missing) → [om]  /  User.in_(user_ids) → [user]
    session.execute = AsyncMock(side_effect=[
        _sql_result(all_=[]), _sql_result(all_=[om]), _sql_result(all_=[user]),
    ])

    out = await lookup_members_by_ids({mid}, session)
    _assert_no_email_leak(out[mid].name)


# ── lookup_members_by_ids — anchor(_lookup_members_by_ids_anchor), 휴먼 배치 조회 ──
#
# 이 경로는 select(User.id, User.display_name)처럼 «컬럼 프로젝션»이라 .all()이 순수
# (uuid, str|None) 튜플을 돌려준다 — 단일-resolve 경로(ORM 객체 통째 반환, .display_name/
# .email이 서로 다른 속성이라 자연히 판별됨)와 달리, 정적 튜플 하나만 mock하면 어느 컬럼을
# 실제로 select했는지에 무관하게 같은 값이 나와 뮤테이션을 못 죽인다(껍데기 통과 위험 —
# [[feedback_guard_must_declare_what_it_misses]] 동형 자기점검으로 발견). 그래서 이 자리는
# 실행된 SELECT문의 선택 컬럼명을 직접 들여다보는 side_effect로 email/display_name을
# 구분해 진짜 DB처럼 응답한다(email은 NOT NULL 실 제약 반영 — 값이 있고, display_name은
# 이 픽스처 사용자에게 없다는 실 상태 반영 — None).
def _selected_column_names(stmt) -> set[str]:
    return {c.key for c in stmt.selected_columns}


@pytest.mark.anyio
async def test_lookup_members_by_ids_anchor_human_no_display_name_is_none(monkeypatch):
    import app.services.member_resolver as mr

    monkeypatch.setattr(mr.settings, "member_ssot_resolver_shadow", True)

    mid = uuid.uuid4()
    m = MagicMock()
    m.id = mid; m.user_id = USER_ID; m.type = "human"; m.org_role = "member"; m.org_id = ORG_ID
    m.avatar_url = None

    calls = [_sql_result(all_=[m])]  # 1) Member.in_ → [m]

    async def _execute(stmt, *args, **kwargs):
        if calls:
            return calls.pop(0)
        # 2) 휴먼 배치 조회 — 실제로 select된 컬럼명으로 email/display_name을 구분한다.
        cols = _selected_column_names(stmt)
        if "email" in cols:
            return _sql_result(rows=[(USER_ID, NO_EMAIL_LEAK_SENTINEL)])  # email NOT NULL(실 제약) — 항상 값 있음.
        assert "display_name" in cols, f"예상 밖 컬럼 select: {cols}"
        return _sql_result(rows=[(USER_ID, None)])  # 이 픽스처 사용자는 display_name 미설정.

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=_execute)

    out = await lookup_members_by_ids({mid}, session)
    _assert_no_email_leak(out[mid].name)


# ── resolve_member_identity — OrgMember(grant-only 휴먼) 분기 ──────────────────

@pytest.mark.anyio
async def test_resolve_member_identity_org_member_no_display_name_is_none():
    om = MagicMock(spec=["id", "user_id", "org_id", "role", "deleted_at"])
    om.id = uuid.uuid4(); om.user_id = USER_ID; om.org_id = ORG_ID; om.role = "member"; om.deleted_at = None

    user = MagicMock()
    user.display_name = None
    user.email = NO_EMAIL_LEAK_SENTINEL

    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = None  # TeamMember 미존재.

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        tm_result, _sql_result(scalar=om), _sql_result(scalar=user),
    ])

    resolved = await resolve_member_identity(om.id, ORG_ID, session)
    assert resolved is not None
    _assert_no_email_leak(resolved.name)


@pytest.mark.anyio
async def test_resolve_member_identity_org_member_with_display_name_positive_control():
    """양성대조 — display_name이 있으면 email이 아니라 그 값이 나온다."""
    om = MagicMock(spec=["id", "user_id", "org_id", "role", "deleted_at"])
    om.id = uuid.uuid4(); om.user_id = USER_ID; om.org_id = ORG_ID; om.role = "member"; om.deleted_at = None

    user = MagicMock()
    user.display_name = "그란트온리 휴먼"
    user.email = NO_EMAIL_LEAK_SENTINEL

    tm_result = MagicMock()
    tm_result.scalars.return_value.first.return_value = None

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        tm_result, _sql_result(scalar=om), _sql_result(scalar=user),
    ])

    resolved = await resolve_member_identity(om.id, ORG_ID, session)
    assert resolved is not None
    assert resolved.name == "그란트온리 휴먼"

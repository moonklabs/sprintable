"""story #3287([도메인탈고정·축1 Phase1] org 표시 라벨 레이어) — 서비스+라우터 단위
테스트(mock session, test_gate_config_s4.py와 동형 하네스 — hitl_gate_config의 org 레이어
테스트와 정확히 같은 모양). AC1(마이그 무변경 실증)·AC3(기존 로직 무변경 실증)는 실 PG
테스트(test_3287_domain_label_realdb.py)가 겨냥한다 — 이 파일은 이 스토리가 신설하는
코드 자체(검증·권한·upsert/delete 로직)만 겨냥."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    return a


# ── canonical_slugs_for / 검증 ────────────────────────────────────────────────


def test_canonical_slugs_for_entity_type():
    from app.services.domain_label import canonical_slugs_for

    assert canonical_slugs_for("entity_type") == {"story", "task", "epic", "sprint"}


def test_canonical_slugs_for_status_reuses_workflow_violation_ssot():
    """⭐새 어휘 발명 0 pin — workflow_violation.STATUS_ORDER와 정확히 같은 값이어야 한다."""
    from app.services.domain_label import canonical_slugs_for
    from app.services.workflow_violation import STATUS_ORDER

    assert canonical_slugs_for("status") == frozenset(STATUS_ORDER)


def test_canonical_slugs_for_unknown_domain_returns_empty():
    from app.services.domain_label import canonical_slugs_for

    assert canonical_slugs_for("bogus") == frozenset()


# ── set_org_domain_label — 검증+upsert ────────────────────────────────────────


@pytest.mark.anyio
async def test_set_domain_label_invalid_domain_rejected():
    from app.services.domain_label import set_org_domain_label

    with pytest.raises(ValueError, match="domain must be one of"):
        await set_org_domain_label(
            MagicMock(), org_id=uuid.uuid4(), domain="bogus", canonical_slug="story",
            label_ko="x", label_en="x", created_by=uuid.uuid4(),
        )


@pytest.mark.anyio
async def test_set_domain_label_invalid_slug_for_domain_rejected():
    """domain='status'인데 entity_type 슬러그를 주면 거부(교차 오용 방지)."""
    from app.services.domain_label import set_org_domain_label

    with pytest.raises(ValueError, match="canonical_slug for domain='status'"):
        await set_org_domain_label(
            MagicMock(), org_id=uuid.uuid4(), domain="status", canonical_slug="story",
            label_ko="x", label_en="x", created_by=uuid.uuid4(),
        )


@pytest.mark.anyio
async def test_set_domain_label_upserts_and_returns_row():
    from app.services.domain_label import set_org_domain_label

    org_id = uuid.uuid4()
    session = MagicMock()
    session.execute = AsyncMock()
    session.flush = AsyncMock()
    expected_row = MagicMock(domain="entity_type", canonical_slug="story", label_ko="캠페인", label_en="Campaign")
    # 첫 execute=upsert(INSERT..ON CONFLICT), 두 번째=재조회(SELECT) — side_effect로 분기.
    select_result = MagicMock()
    select_result.scalars.return_value.one.return_value = expected_row
    session.execute = AsyncMock(side_effect=[MagicMock(), select_result])

    row = await set_org_domain_label(
        session, org_id=org_id, domain="entity_type", canonical_slug="story",
        label_ko="캠페인", label_en="Campaign", created_by=uuid.uuid4(),
    )
    assert row is expected_row
    session.flush.assert_awaited_once()


# ── delete_org_domain_label ───────────────────────────────────────────────────


@pytest.mark.anyio
async def test_delete_domain_label_true_when_row_removed():
    from app.services.domain_label import delete_org_domain_label

    session = MagicMock()
    res = MagicMock()
    res.rowcount = 1
    session.execute = AsyncMock(return_value=res)
    out = await delete_org_domain_label(
        session, org_id=uuid.uuid4(), domain="entity_type", canonical_slug="story"
    )
    assert out is True


@pytest.mark.anyio
async def test_delete_domain_label_false_when_none():
    from app.services.domain_label import delete_org_domain_label

    session = MagicMock()
    res = MagicMock()
    res.rowcount = 0
    session.execute = AsyncMock(return_value=res)
    out = await delete_org_domain_label(
        session, org_id=uuid.uuid4(), domain="entity_type", canonical_slug="story"
    )
    assert out is False  # 멱등 — 없는 오버라이드 삭제는 False


# ── 라우터 — GET(org 멤버 read) ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_get_domain_labels_org_mismatch_403():
    from fastapi import HTTPException

    from app.routers import domain_labels as dl

    with pytest.raises(HTTPException) as ei:
        await dl.get_domain_labels(
            uuid.uuid4(), session=MagicMock(), verified_org_id=uuid.uuid4(), auth=_auth()
        )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_get_domain_labels_returns_only_overrides():
    """미설정 canonical_slug는 목록에 안 나옴 — 호출부가 "미설정=시스템 기본값"을 스스로 판정."""
    from app.routers import domain_labels as dl

    oid = uuid.uuid4()
    row = MagicMock(domain="status", canonical_slug="backlog", label_ko="아이디어", label_en="Idea")
    with patch("app.routers.domain_labels.list_org_domain_labels", new=AsyncMock(return_value=[row])):
        out = await dl.get_domain_labels(oid, session=MagicMock(), verified_org_id=oid, auth=_auth())
    assert len(out) == 1
    assert out[0].label_ko == "아이디어"


# ── 라우터 — PUT/DELETE(org owner/admin write) ────────────────────────────────


def _put_body():
    from app.routers import domain_labels as dl

    return dl.SetDomainLabelRequest(domain="entity_type", canonical_slug="story", label_ko="캠페인")


@pytest.mark.anyio
async def test_put_domain_label_admin_sets_override():
    from app.routers import domain_labels as dl

    oid = uuid.uuid4()
    session = MagicMock()
    session.commit = AsyncMock()
    row = MagicMock(domain="entity_type", canonical_slug="story", label_ko="캠페인", label_en=None)
    with patch(
        "app.routers.domain_labels.is_org_owner_or_admin", new=AsyncMock(return_value=True)
    ), patch("app.routers.domain_labels.set_org_domain_label", new=AsyncMock(return_value=row)):
        out = await dl.put_domain_label(oid, _put_body(), session=session, verified_org_id=oid, auth=_auth())
    assert out.label_ko == "캠페인"
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_put_domain_label_non_admin_403():
    from fastapi import HTTPException

    from app.routers import domain_labels as dl

    oid = uuid.uuid4()
    with patch("app.routers.domain_labels.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await dl.put_domain_label(oid, _put_body(), session=MagicMock(), verified_org_id=oid, auth=_auth())
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_put_domain_label_org_mismatch_403():
    from fastapi import HTTPException

    from app.routers import domain_labels as dl

    with pytest.raises(HTTPException) as ei:
        await dl.put_domain_label(
            uuid.uuid4(), _put_body(), session=MagicMock(), verified_org_id=uuid.uuid4(), auth=_auth()
        )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_put_domain_label_invalid_slug_400():
    from fastapi import HTTPException

    from app.routers import domain_labels as dl

    oid = uuid.uuid4()
    body = dl.SetDomainLabelRequest(domain="status", canonical_slug="not-a-real-status")
    with patch("app.routers.domain_labels.is_org_owner_or_admin", new=AsyncMock(return_value=True)):
        with pytest.raises(HTTPException) as ei:
            await dl.put_domain_label(oid, body, session=MagicMock(), verified_org_id=oid, auth=_auth())
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_delete_domain_label_non_admin_403():
    from fastapi import HTTPException

    from app.routers import domain_labels as dl

    oid = uuid.uuid4()
    with patch("app.routers.domain_labels.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await dl.delete_domain_label(
                oid, domain="entity_type", canonical_slug="story",
                session=MagicMock(), verified_org_id=oid, auth=_auth(),
            )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_delete_domain_label_admin_removes_override():
    from app.routers import domain_labels as dl

    oid = uuid.uuid4()
    session = MagicMock()
    session.commit = AsyncMock()
    with patch(
        "app.routers.domain_labels.is_org_owner_or_admin", new=AsyncMock(return_value=True)
    ), patch("app.routers.domain_labels.delete_org_domain_label", new=AsyncMock(return_value=True)):
        await dl.delete_domain_label(
            oid, domain="entity_type", canonical_slug="story",
            session=session, verified_org_id=oid, auth=_auth(),
        )
    session.commit.assert_awaited_once()

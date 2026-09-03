"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 저장/조회.

**서버 chokepoint**(story 본문 §2): work item의 external_publish 게이트가 approved/
auto_passed가 아니면 발행 자체가 안 된다 — git 커밋이 승인 증거였던 자리를, 이 SitePost 행의
gate_id·created_at이 그대로 대신한다."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.site_post import SitePost

_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_LANG_RE = re.compile(r"^[a-z]{2}(-[A-Z]{2})?$")

_APPROVED_STATUSES = ("approved", "auto_passed")


class InvalidSitePostInputError(ValueError):
    """slug/lang이 서버 형식 규칙을 어김(422)."""


class ExternalPublishGateNotApprovedError(Exception):
    """work item의 external_publish 게이트가 approved/auto_passed가 아님(403). gate_id·
    status를 담아 사유 문구에 그대로 노출한다(story 본문 §2 명시)."""

    def __init__(self, *, gate_id: uuid.UUID | None, status: str | None):
        self.gate_id = gate_id
        self.status = status
        detail = (
            f"external_publish 게이트가 승인되지 않았습니다(gate_id={gate_id}, status={status})"
            if gate_id is not None
            else "이 work item에 승인된 external_publish 게이트가 없습니다"
        )
        super().__init__(detail)


def _validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise InvalidSitePostInputError(f"slug 형식이 올바르지 않습니다: {slug!r}")


def _validate_lang(lang: str) -> None:
    if not _LANG_RE.match(lang):
        raise InvalidSitePostInputError(f"lang 형식이 올바르지 않습니다: {lang!r}")


async def _resolve_approved_gate(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, gate_id: uuid.UUID | None,
) -> Gate:
    """gate_id가 주어지면 그 게이트 자체를 검증(work_item/타입 일치 + 승인 상태). 없으면 이
    work item의 external_publish 게이트를 찾아 검증(가장 최근 것 — story #2150 재제출 리셋
    관례상 같은 (work_item, gate_type)엔 사실상 행 1개만 산다)."""
    if gate_id is not None:
        gate = (await db.execute(
            select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
        )).scalar_one_or_none()
        if (
            gate is None
            or gate.work_item_id != work_item_id
            or gate.gate_type != "external_publish"
            or gate.status not in _APPROVED_STATUSES
        ):
            raise ExternalPublishGateNotApprovedError(
                gate_id=gate_id, status=gate.status if gate is not None else None,
            )
        return gate

    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.gate_type == "external_publish",
        )
        .order_by(Gate.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if gate is None or gate.status not in _APPROVED_STATUSES:
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None, status=gate.status if gate is not None else None,
        )
    return gate


async def publish_site_post(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    gate_id: uuid.UUID | None,
    title: str,
    slug: str,
    lang: str,
    summary: str,
    tags: list,
    body_md: str,
    created_by_member_id: uuid.UUID,
) -> SitePost:
    _validate_slug(slug)
    _validate_lang(lang)
    gate = await _resolve_approved_gate(db, org_id=org_id, work_item_id=work_item_id, gate_id=gate_id)

    now = datetime.now(timezone.utc)
    stmt = pg_insert(SitePost).values(
        id=uuid.uuid4(), org_id=org_id, lang=lang, slug=slug, title=title, summary=summary,
        tags=tags, body_md=body_md, published_at=now, source_story_id=work_item_id,
        gate_id=gate.id, created_by_member_id=created_by_member_id, unpublished_at=None,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_site_posts_org_lang_slug",
        set_={
            "title": title, "summary": summary, "tags": tags, "body_md": body_md,
            "published_at": now, "source_story_id": work_item_id, "gate_id": gate.id,
            "unpublished_at": None, "updated_at": now,
            # created_by_member_id는 최초 발행자 그대로 — 재발행이 저자를 안 바꾼다.
        },
    ).returning(SitePost)
    row = (await db.execute(stmt)).scalar_one()
    await db.commit()
    return row


async def get_published_site_post(db: AsyncSession, *, org_id: uuid.UUID, lang: str, slug: str) -> SitePost | None:
    return (await db.execute(
        select(SitePost).where(
            SitePost.org_id == org_id, SitePost.lang == lang, SitePost.slug == slug,
            SitePost.unpublished_at.is_(None),
        )
    )).scalar_one_or_none()


async def list_published_site_posts(db: AsyncSession, *, org_id: uuid.UUID, lang: str) -> list[SitePost]:
    stmt = (
        select(SitePost)
        .where(SitePost.org_id == org_id, SitePost.lang == lang, SitePost.unpublished_at.is_(None))
        .order_by(SitePost.published_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())

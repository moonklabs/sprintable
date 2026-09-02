"""story #3287([도메인탈고정·축1 Phase1]) — org별 엔티티/상태 "표시 라벨" 오버라이드
read/write. canonical slug(DB 저장값) 검증만 하고, 그 값을 쓰는 어떤 기존 로직(workflow_
violation·advance_story_to_done·Gate 회수)도 이 파일이 건드리지 않는다 — 그 로직들은 이
테이블의 존재를 모른 채 canonical_slug만 계속 본다(설계 doc §Phase 1, AC3)."""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.domain_label import DOMAINS, ENTITY_TYPE_SLUGS, OrgDomainLabel
from app.services.workflow_violation import STATUS_ORDER

STATUS_SLUGS = frozenset(STATUS_ORDER)

_CANONICAL_SLUGS_BY_DOMAIN: dict[str, frozenset[str]] = {
    "entity_type": ENTITY_TYPE_SLUGS,
    "status": STATUS_SLUGS,
}


def canonical_slugs_for(domain: str) -> frozenset[str]:
    return _CANONICAL_SLUGS_BY_DOMAIN.get(domain, frozenset())


async def list_org_domain_labels(session: AsyncSession, *, org_id: uuid.UUID) -> list[OrgDomainLabel]:
    """org 단위 오버라이드만(project_id IS NULL — 이 슬라이스가 쓰는 유일한 계층, AC5)."""
    result = await session.execute(
        select(OrgDomainLabel).where(
            OrgDomainLabel.org_id == org_id, OrgDomainLabel.project_id.is_(None)
        )
    )
    return list(result.scalars().all())


async def set_org_domain_label(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    domain: str,
    canonical_slug: str,
    label_ko: str | None,
    label_en: str | None,
    created_by: uuid.UUID | None,
) -> OrgDomainLabel:
    """(org, domain, canonical_slug) 축당 1행 upsert. check-then-insert TOCTOU를 피하려고
    부분 유니크 인덱스(uq_org_domain_label_org_default)를 conflict target으로 원자
    upsert한다 — hitl_gate_config::set_gate_level과 동일 관례(동시 PUT 2건이 둘 다
    INSERT를 시도해 500이 나는 레이스 방지)."""
    if domain not in DOMAINS:
        raise ValueError(f"domain must be one of {DOMAINS}")
    allowed = canonical_slugs_for(domain)
    if canonical_slug not in allowed:
        raise ValueError(f"canonical_slug for domain={domain!r} must be one of {sorted(allowed)}")

    vals = dict(
        org_id=org_id, project_id=None, domain=domain, canonical_slug=canonical_slug,
        label_ko=label_ko, label_en=label_en, created_by=created_by,
    )
    stmt = pg_insert(OrgDomainLabel.__table__).values(**vals)
    stmt = stmt.on_conflict_do_update(
        index_elements=["org_id", "domain", "canonical_slug"],
        index_where=OrgDomainLabel.project_id.is_(None),
        set_={"label_ko": label_ko, "label_en": label_en, "updated_at": func.now()},
    )
    await session.execute(stmt)
    await session.flush()

    # ⚠️populate_existing 필수 — 위 upsert는 raw Core insert().on_conflict_do_update()라
    # ORM unit-of-work를 안 거친다. 같은 세션 안에서 이 행이 이미 identity map에 있으면(예:
    # 직전 호출의 재조회) 이 SELECT가 DB에서 새 값을 읽어와도 SQLAlchemy가 캐시된 파이썬
    # 객체를 그대로 돌려줘 방금 UPDATE한 label이 반영 안 된 걸로 보인다(실측: 이 옵션 없이
    # 같은 세션에서 두 번 upsert하면 두 번째 반환값이 첫 번째 값으로 stale — realdb 테스트로
    # 재현·고정됨). populate_existing=True가 캐시된 객체의 속성을 이 쿼리 결과로 강제 갱신한다.
    row = (
        await session.execute(
            select(OrgDomainLabel).execution_options(populate_existing=True).where(
                OrgDomainLabel.org_id == org_id,
                OrgDomainLabel.project_id.is_(None),
                OrgDomainLabel.domain == domain,
                OrgDomainLabel.canonical_slug == canonical_slug,
            )
        )
    ).scalars().one()
    return row


async def delete_org_domain_label(
    session: AsyncSession, *, org_id: uuid.UUID, domain: str, canonical_slug: str
) -> bool:
    """오버라이드 삭제(↺ 시스템 기본값 복귀). 삭제 행 있었으면 True(멱등 — 없어도 에러 아님)."""
    from sqlalchemy import delete

    result = await session.execute(
        delete(OrgDomainLabel).where(
            OrgDomainLabel.org_id == org_id,
            OrgDomainLabel.project_id.is_(None),
            OrgDomainLabel.domain == domain,
            OrgDomainLabel.canonical_slug == canonical_slug,
        )
    )
    return result.rowcount > 0

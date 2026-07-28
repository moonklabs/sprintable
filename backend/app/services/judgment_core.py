"""story #2268(D단계, E-CONNECT — "판단 칸") — judgments write/read 코어.

AC(오르테가, 2026-07-29): pull 전용 — 「물으면 준다」, push 금지. `retractions`는 상한과
무관하게 항상 전체(캡 예외 — "철회된 걸 다시 주장 안 하는가"가 이 판의 판정기준이므로 여기서
잘리면 그 기준 자체가 무너진다). `active`(judgment/unmeasurable/refinement/method_error)는
"다음 발 수" 기준으로 캡 — 지금 실측 가능한 랭킹 신호가 recency뿐이라 그걸로 자르고
`meta.cap_basis`로 정직하게 선언한다(다른 신호 없으면 있는 척 안 함, #2266 backlinks의
collection_scope 정직성 패턴과 동형).

app-level 검증을 먼저 하는 이유(#2259 reference_core.insert_reference와 동일 패턴 — 이중
방어): DB CHECK만 믿으면 실패 시 raw IntegrityError 텍스트가 그대로 API 밖으로 샌다. 여기서
먼저 걸러 사람이 읽을 수 있는 메시지로 거절한다 — CHECK는 그래도 안 뺀다("코드가 아니라
제약이 지킨다"가 이 판의 crux, 오르테가 표현).
"""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.judgment import JUDGMENT_KINDS, JUDGMENT_SCOPES, TARGET_REQUIRED_KINDS, Judgment

DEFAULT_ACTIVE_LIMIT = 20


class InvalidJudgmentError(ValueError):
    """app-level 검증 실패 — 라우터가 422로 번역한다."""


async def create_judgment(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    scope: str,
    work_item_ids: list[uuid.UUID],
    kind: str,
    target_id: uuid.UUID | None,
    method: str | None,
    statement: str,
    created_by: uuid.UUID,
) -> Judgment:
    if kind not in JUDGMENT_KINDS:
        raise InvalidJudgmentError(f"kind must be one of {sorted(JUDGMENT_KINDS)}")
    if scope not in JUDGMENT_SCOPES:
        raise InvalidJudgmentError(f"scope must be one of {sorted(JUDGMENT_SCOPES)}")
    # ⛔scope↔work_item_ids 쌍 — 빈 배열의 "어디에도 안 붙는 것"과 "아직 안 붙인 것" 모호성을
    # 여기서도 명확한 메시지로 막는다(DB CHECK가 최종 방어선, 이건 그 앞단).
    if scope == "general" and work_item_ids:
        raise InvalidJudgmentError("scope='general'이면 work_item_ids는 비어 있어야 합니다(일반 교훈)")
    if scope == "items" and not work_item_ids:
        raise InvalidJudgmentError("scope='items'면 work_item_ids가 최소 1개 필요합니다(아직 안 붙인 상태 금지)")
    if kind in TARGET_REQUIRED_KINDS and target_id is None:
        raise InvalidJudgmentError(
            f"kind={kind!r}는 target_id가 필수입니다(무엇에 대한 말인지 모르는 {kind}는 저장 금지)"
        )

    if target_id is not None:
        target_exists = (
            await session.execute(
                select(Judgment.id).where(Judgment.id == target_id, Judgment.org_id == org_id)
            )
        ).scalar_one_or_none()
        if target_exists is None:
            raise InvalidJudgmentError(f"target_id {target_id}가 이 org에 존재하지 않습니다")

    judgment = Judgment(
        id=uuid.uuid4(), org_id=org_id, scope=scope, work_item_ids=list(work_item_ids),
        kind=kind, target_id=target_id, method=method, statement=statement,
        created_by=created_by,
    )
    session.add(judgment)
    await session.flush()
    await session.refresh(judgment)
    return judgment


async def list_judgments(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID | None,
    method: str | None,
    scope: str | None,
    limit: int = DEFAULT_ACTIVE_LIMIT,
) -> dict:
    """pull 진입점 코어. 세 축(work_item_id/method/scope)은 AND로 결합 — 필요한 것만
    좁혀 묻는다는 전제(#2268 AC ②의 "다음 발에 필요한 것만"과 짝)."""
    filters = [Judgment.org_id == org_id]
    if work_item_id is not None:
        filters.append(Judgment.work_item_ids.any(work_item_id))
    if method is not None:
        filters.append(Judgment.method == method)
    if scope is not None:
        filters.append(Judgment.scope == scope)

    retraction_rows = (
        await session.execute(
            select(Judgment)
            .where(*filters, Judgment.kind == "retraction")
            .order_by(Judgment.created_at.desc())
        )
    ).scalars().all()

    active_filters = [*filters, Judgment.kind != "retraction"]
    total_active = (
        await session.execute(select(func.count(Judgment.id)).where(*active_filters))
    ).scalar_one()
    active_rows = (
        await session.execute(
            select(Judgment).where(*active_filters).order_by(Judgment.created_at.desc()).limit(limit)
        )
    ).scalars().all()

    omitted_count = max(0, total_active - len(active_rows))
    return {
        "retractions": list(retraction_rows),
        "active": list(active_rows),
        "meta": {
            "scope": scope,
            "capped": omitted_count > 0,
            "cap_basis": "recency",
            "omitted_count": omitted_count,
        },
    }

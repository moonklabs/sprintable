"""story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05) — 인사이트 스냅샷 조회 API.
publishing_metrics.py와 동형 권한 축(GET은 org 멤버 누구나 — 휴먼·에이전트 모두, write
없음·이 값은 워커 tick의 파생물일 뿐 별도로 편집할 상태가 없다). publication_id 하나로
site_post·channel_publication 어느 쪽이든 조회한다(publication_kind는 결과 행 자신이
싣고 있다 — 호출자가 미리 구분해서 넘길 필요 없음)."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user
from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.i18n_catalog import t
from app.services.insight_snapshots import (
    label_snapshot_offset,
    list_insight_snapshots_for_publication,
    resolve_publication_org_id,
    resolve_publication_published_at,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["insight-snapshots"])


class InsightSnapshotView(BaseModel):
    id: uuid.UUID
    channel: str
    due_at: datetime
    captured_at: datetime | None
    status: str
    normalized: dict[str, int | None] | None
    source: str | None
    error_code: str | None
    # story #3651 CHANGES(카디르 발견, PR#4003, 2026-09-07) — insights_board.py가 이미
    # 쓰던 「due_at−«지금» published_at」 라벨링을 소비부(MCP 도구)가 각자 인덱스로
    # 흉내 내다 재발행(같은 publication_id, published_at 갱신 + 새 due_at 2행 추가)
    # 사례에서 오라벨했다. 서버가 정본 라벨을 낸다 — null=옛 발행 사이클의 잔존
    # 스냅샷(그 due_at이 «지금» published_at의 +1일/+7일 어느 쪽도 아님).
    offset_label: str | None = None


@router.get(
    "/{org_id}/publications/{publication_id}/insights", response_model=list[InsightSnapshotView],
)
async def list_publication_insights_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> list[InsightSnapshotView]:
    """story #3796 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙, i18n_catalog.py 모듈 docstring 참조). 직접-호출(realdb·유닛) 테스트는
    `_list_publication_insights_endpoint`를 불러야 한다."""
    return await _list_publication_insights_endpoint(
        org_id, publication_id, db=db, verified_org_id=verified_org_id, _auth=_auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _list_publication_insights_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    *,
    db: AsyncSession,
    verified_org_id: uuid.UUID,
    _auth,
    resolved_locale: str,
) -> list[InsightSnapshotView]:
    """AC6 — 스냅샷 목록(raw_payload 제외 — 원본은 디버그 전용, 이 조회 축에 실을
    필요가 없다).

    story #3796(페드루 PO 確定 2026-09-10, 유나 실측 — 2차 CHANGES 2026-09-11) —
    **계약 변경**: "애초에 존재하지 않는 publication_id"와 "타 org 소유로 실존"을
    가르는 축을 404/200으로 노출하면(1차 처방이 그랬다) 호출자가 그 둘을 구분해
    "이 id가 실존하는지"를 org 경계 밖에서 열거(enumerate)할 수 있다 — docstring의
    "존재 자체를 비노출"과 응답이 실제로는 어긋나는 자기모순(같은 화면 두 문장이
    다른 세계를 말하는 것). 가름선을 **소유**로 다시 긋는다 — `owner_org_id`가
    `None`(애초에 미존재)이든 caller org와 다른 실제 org든, 어느 쪽이든 "내 org
    것이 아니다"는 사실은 같으므로 **둘 다 404**로 동일하게 응답한다(응답 바디·
    status 완전히 구분 불가). "내 org 소유인데 스냅샷만 0건"일 때만 빈 목록(그
    자체가 "이 발행엔 아직 스냅샷이 없다"는 정직한 사실 — 지어내지 않는다). 3497의
    옛 계약("애초에 미존재=빈 목록")은 이 스토리로 폐기·404로 갱신됐다(해당 테스트도
    같이 고쳤다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await list_insight_snapshots_for_publication(db, org_id=org_id, publication_id=publication_id)
    if not rows:
        owner_org_id = await resolve_publication_org_id(db, publication_id=publication_id)
        if owner_org_id != org_id:
            raise HTTPException(
                status_code=404, detail=t("insight_snapshots.publication_not_found_in_org", resolved_locale),
            )
    # story #3651 CHANGES — 이 publication의 «지금» published_at 1회 조회(행마다 반복
    # 조회 0, 어차피 폴리모픽 publication_id 하나당 kind는 하나다 — rows[0]에서 그대로
    # 읽는다). 스냅샷이 없으면 조회 자체를 스킵(빈 목록 반환은 그대로 유지).
    published_at = None
    if rows:
        published_at = await resolve_publication_published_at(
            db, publication_kind=rows[0].publication_kind, publication_id=publication_id,
        )
    return [
        InsightSnapshotView(
            id=r.id, channel=r.channel, due_at=r.due_at, captured_at=r.captured_at,
            status=r.status, normalized=r.normalized, source=r.source, error_code=r.error_code,
            offset_label=(
                label_snapshot_offset(due_at=r.due_at, published_at=published_at)
                if published_at is not None else None
            ),
        )
        for r in rows
    ]

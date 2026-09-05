"""story #3540(Phase1·마케팅운영, 페드루 PO 確定 2026-09-06) — 연결 화면 「성과 수집」
섹션이 읽는 상태 API. 발행 채널 연결(channel_connections.py)과는 별개 축 — beacon·UTM
둘 다 ChannelConnection 행이 아니다(beacon=자체 카운터, UTM=content_rules 플래그).
GA4는 Phase 2 선행(OAuth 미착지) — 이 API·화면 둘 다 그 줄을 아예 안 낸다(유나 §13-7
確定, 「없는 자리를 그리지 않는다」·로드맵을 화면에 적으면 약속이 된다).

⛔beacon 관측이 상태를 바꾸는 함정 — `GET .../metering-key`(pageview_metering.py)는
키가 없으면 최초 발급하는 라우트라, 「성과 수집」 화면이 상태를 보려고 그걸 그대로
부르면 화면을 연 것만으로 키가 생겨 「아직 안 씀」 상태가 사라진다. 이 라우터는
그래서 발급 자체를 안 하는 별도 읽기 전용 경로(`get_beacon_status`)를 쓴다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.content_rules import get_org_content_rules
from app.services.pageview_counter import get_beacon_status

router = APIRouter(prefix="/api/v2/organizations", tags=["measurement-connections"])


class MeasurementConnectionItem(BaseModel):
    key: Literal["beacon", "utm"]
    # beacon: "not_started"(키 미발급, 「아직 쓰지 않음」+시작하기)·"no_data_yet"
    # (키 있음·수신 0, 「아직 들어온 기록이 없습니다」)·"has_data"(수신>0, 「마지막
    # 기록 {last_seen_at}」). utm: "auto"(utm_rules.enabled=true, 자동 부착)·
    # "manual"(require_utm만 켜짐, 수동 규칙)·"off"(둘 다 꺼짐). 「연결됨」 낱말은
    # 이 값이 화면 문구로 바뀌는 어느 자리에서도 쓰지 않는다(유나 §13-7 明示 — 우리는
    # beacon이 실제로 심겼는지 모른다, 키 발급≠사용 확認).
    status: str
    # beacon 전용(utm은 항상 null) — org_pageview_daily MAX(updated_at)·7일 SUM(count).
    last_seen_at: datetime | None = None
    count_7d: int | None = None
    # 「어디서 바꾸나」 링크 대상(화면 라우트 경로) — beacon은 이 스토리 스코프에
    # 발급 화면 자체가 없어 null(3540 참고 섹션 — 4180f67f 후속), utm은 이미 있는
    # 콘텐츠 규칙 화면(3540 PR1) 그대로.
    settings_path: str | None = None


@router.get("/{org_id}/measurement-connections", response_model=list[MeasurementConnectionItem])
async def list_measurement_connections_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[MeasurementConnectionItem]:
    """org 멤버(휴먼·에이전트 모두) 읽기 가능 — available-channels·agent-visible과
    동형 권한 폭(이 응답엔 토큰·시크릿류 필드가 아예 없다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    now = datetime.now(timezone.utc)
    beacon = await get_beacon_status(db, org_id=org_id, now=now)
    if not beacon["key_issued"]:
        beacon_status = "not_started"
    elif beacon["last_seen_at"] is None:
        beacon_status = "no_data_yet"
    else:
        beacon_status = "has_data"

    rule_row = await get_org_content_rules(db, org_id=org_id)
    rules = rule_row.rules if rule_row is not None else {}
    utm_rules = rules.get("utm_rules") or {}
    if utm_rules.get("enabled"):
        utm_status = "auto"
    elif rules.get("require_utm"):
        utm_status = "manual"
    else:
        utm_status = "off"

    return [
        MeasurementConnectionItem(
            key="beacon", status=beacon_status,
            last_seen_at=beacon["last_seen_at"], count_7d=beacon["count_7d"],
        ),
        MeasurementConnectionItem(key="utm", status=utm_status, settings_path="/organization/content-rules"),
    ]

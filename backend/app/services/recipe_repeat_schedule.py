"""story #3337(선생님 4바퀴 실사고, 페드루 PO 설계 확定 2026-09-02) — 사이클형 레시피 정의의
반복(payload.repeat=ISO8601 duration)을 "담당 에이전트가 스스로 재는" 자율 행동이 아니라
제품이 다음 회차 stage 이벤트를 발행하는 서버 능력으로 만든다.

이 모듈 = **stage 이벤트 발행 시점 훅**(recipe_gate_hooks.py::maybe_create_stage_gate와 나란히
`_publish_registry_event_core`가 호출 — 단일목적 서비스 컴포지션 관례, 페드루 판정과 동형).
실제 tick 실행(cron)은 recipe_repeat_scheduler.py가 맡는다(관심사 분리 — 이 모듈은 "이번
발행에서 스케줄을 어떻게 갱신할지"만, 그쪽은 "언제 다음 회차를 실제로 쏠지"만).

행 존재/갱신 규칙(페드루 확定):
- 정의의 **첫 stage**(payload_schema.properties.stage.enum[0], 예: collect) 발행이 payload.repeat
  를 실었으면 → (org_id, project_id, definition_key) 유니크 키로 upsert. next_run_at = 이번
  발행 시각 + repeat. status='active'로 강제 복귀(일시정지 뒤 사람이 다시 collect를 손으로
  발행하면 재개되는 것으로 취급 — 수동 재개 UI가 아직 없으므로 이게 유일한 재개 경로다).
- **매 stage 발행**(첫 stage 여부 무관, 이미 행이 있는 조합에 한해)마다 last_payload_snapshot을
  이번 payload의 channel/source_doc_id/previous_output_doc_id로 갱신 — 사이클의 마지막 stage
  (measure)가 언제 발행되든 그 시점의 값이 자연히 최신으로 남는다. tick 시점(recipe_repeat_
  scheduler.py)은 이 스냅샷을 그대로 읽어 다음 회차 payload를 짓는다(직접 재조회 없음, 페드루
  확定 — "스냅샷에서 꺼내는" 원칙).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# ISO 8601 duration 부분집합(PnYnMnDTnHnMnS) — 이 코드베이스에 기존 파서/라이브러리가 없어
# 여기서 신설(그라운딩 확認). Y/M은 달력 개념(28~31일/365~366일)이라 초 단위 근사가 원리적으로
# 부정확하지만, 이 스토리의 실사용(P7D·PT10M류 짧은 마케팅 콘텐츠 주기)은 D 이하만 쓴다 —
# Y/M도 명세엔 있으니 막지 않되(주석대로 근사), 실사용 클래스는 그 근사 오차가 무의미하다.
_DURATION_RE = re.compile(
    r"^P(?:(?P<years>\d+)Y)?(?:(?P<months>\d+)M)?(?:(?P<weeks>\d+)W)?(?:(?P<days>\d+)D)?"
    r"(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)


class InvalidRepeatDurationError(ValueError):
    """payload.repeat가 ISO8601 duration 문법이 아니거나(P로 시작해야 함) 전부 0(무한루프
    방지 — next_run_at이 안 전진하면 tick마다 같은 행을 계속 재발행하게 된다)."""


def parse_iso8601_duration(value: str) -> timedelta:
    if not isinstance(value, str) or not value.startswith("P"):
        raise InvalidRepeatDurationError(f"repeat은 ISO8601 duration(P로 시작)이어야 합니다: {value!r}")
    m = _DURATION_RE.match(value)
    if m is None:
        raise InvalidRepeatDurationError(f"repeat 형식을 해석할 수 없습니다: {value!r}")
    parts = {k: int(v) if v else 0 for k, v in m.groupdict().items()}
    days = parts["years"] * 365 + parts["months"] * 30 + parts["weeks"] * 7 + parts["days"]
    delta = timedelta(
        days=days, hours=parts["hours"], minutes=parts["minutes"], seconds=parts["seconds"],
    )
    if delta.total_seconds() <= 0:
        raise InvalidRepeatDurationError(f"repeat이 0 이하로 해석됩니다(무한루프 방지로 거부): {value!r}")
    return delta


def _cyclic_stages(definition) -> list[str]:
    """event_definition_registry.validate_stage_metadata와 동일 SSOT(payload_schema.properties.
    stage.enum) — 이 코드베이스에 pure-function 헬퍼가 없어(FE엔 loop-create-dialog.tsx::
    cyclicStages가 있지만 BE 쪽엔 그라운딩 확認 결과 없음) 여기서 신설."""
    stage_prop = (definition.payload_schema.get("properties") or {}).get("stage") or {}
    enum = stage_prop.get("enum")
    return enum if isinstance(enum, list) else []


def _snapshot_from_payload(payload: dict) -> dict:
    """다음 회차 collect payload를 재구성하는 데 필요한 최소 필드만 스냅샷에 담는다 — payload
    전체를 그대로 저장하면 stage/gate_type 등 "이번 발행 한정" 필드까지 다음 회차에 새는
    사고가 난다(#3312/#3323류 payload 오염과 동형 클래스, 명시적으로 화이트리스트)."""
    snapshot: dict = {}
    for key in ("channel", "source_doc_id", "previous_output_doc_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            snapshot[key] = value
    return snapshot


async def maybe_upsert_repeat_schedule(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    definition,
    payload: dict,
) -> None:
    stage = payload.get("stage")
    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    if not stage or not work_item_type or not work_item_id_raw:
        return
    stages = _cyclic_stages(definition)
    if not stages:
        return  # 사이클형 정의가 아님(신호형/측정형) — 반복 개념 자체가 없다.

    try:
        work_item_id = uuid.UUID(str(work_item_id_raw))
    except (ValueError, AttributeError, TypeError):
        return

    # story #3288이 이미 만든 동형 헬퍼 재사용(project_id 해소 — event_routing_resolver.py,
    # recipe_role_binding 조회가 쓰는 것과 동일한 work_item_type별 project_id 조회). 이
    # 함수 자신의 project_id 해소를 새로 짓지 않는다 — SSOT.
    from app.services.event_routing_resolver import _resolve_work_item_project_id

    project_id = await _resolve_work_item_project_id(db, org_id=org_id, payload=payload)
    if project_id is None:
        logger.warning(
            "recipe_repeat_schedule: project_id를 해소 못 함(definition=%s work_item_type=%s "
            "work_item_id=%s) — 스케줄 upsert skip", definition.key, work_item_type, work_item_id_raw,
        )
        return

    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule

    now = datetime.now(timezone.utc)
    is_first_stage = stage == stages[0]
    repeat_raw = payload.get("repeat")

    if is_first_stage and isinstance(repeat_raw, str) and repeat_raw:
        try:
            delta = parse_iso8601_duration(repeat_raw)
        except InvalidRepeatDurationError:
            logger.warning(
                "recipe_repeat_schedule: invalid repeat=%r (definition=%s org=%s) — 스케줄 생성 skip",
                repeat_raw, definition.key, org_id,
            )
            return

        snapshot = _snapshot_from_payload(payload)
        # story #3337 AC4 — SKIP LOCKED 배치와 별개로, 같은 정의+project 조합의 동시 upsert도
        # (org_id, project_id, definition_key) 유니크 제약 위에서 원자적으로(ON CONFLICT DO
        # UPDATE) 처리한다 — 두 stage 이벤트가 동시에 들어와도 행이 두 개로 안 갈라진다.
        stmt = pg_insert(RecipeRepeatSchedule).values(
            id=uuid.uuid4(), org_id=org_id, project_id=project_id, definition_key=definition.key,
            work_item_type=work_item_type, anchor_time=now, next_run_at=now + delta, repeat=repeat_raw,
            last_payload_snapshot=snapshot, consecutive_failure_count=0, status="active",
            last_run_at=now, last_story_id=work_item_id if work_item_type == "story" else None,
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_recipe_repeat_schedule_definition",
            set_={
                "next_run_at": now + delta, "repeat": repeat_raw, "last_payload_snapshot": snapshot,
                "consecutive_failure_count": 0, "status": "active", "last_run_at": now,
                "last_story_id": work_item_id if work_item_type == "story" else RecipeRepeatSchedule.last_story_id,
                "updated_at": now,
            },
        )
        await db.execute(stmt)
        return

    # 첫 stage가 아니거나 repeat이 이번 payload엔 없는 경우 — 이미 활성 스케줄이 있으면
    # 스냅샷만 최신화(마지막으로 발행된 stage의 산출물이 다음 회차 입력이 되도록).
    existing = (await db.execute(
        select(RecipeRepeatSchedule).where(
            RecipeRepeatSchedule.org_id == org_id,
            RecipeRepeatSchedule.project_id == project_id,
            RecipeRepeatSchedule.definition_key == definition.key,
        )
    )).scalar_one_or_none()
    if existing is None:
        return
    # story #3349(실사고 2026-09-02 14:56Z) — 같은 정의를 다른 work item이 병렬로 발행하면
    # (예: QA 테스트 스토리의 approve 발행) 이 유니크 키만으로는 "같은 회차"인지 구분이 안 돼
    # last_story_id/snapshot이 그 work item으로 덮인다. 진행 中인 회차의 정체성은
    # last_story_id로 이미 고정돼 있으므로, 이번 발행의 work_item이 그것과 다르면 무시한다
    # (last_story_id가 아직 없는 스케줄엔 비교 축이 없으니 통과 — work_item_type != "story"로
    # 생성된 케이스의 기존 동작 보존).
    if existing.last_story_id is not None and existing.last_story_id != work_item_id:
        logger.info(
            "recipe_repeat_schedule: work_item=%s는 이 정의의 진행 中인 회차(last_story_id=%s)와 "
            "다름 — 스냅샷/last_story_id 갱신 skip(정의=%s org=%s)",
            work_item_id, existing.last_story_id, definition.key, org_id,
        )
        return
    snapshot = _snapshot_from_payload(payload)
    if snapshot:
        existing.last_payload_snapshot = {**existing.last_payload_snapshot, **snapshot}
    if work_item_type == "story":
        existing.last_story_id = work_item_id

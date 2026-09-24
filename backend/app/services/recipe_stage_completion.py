"""story #4249 — 레시피 stage를 «누가 어떻게 끝내는가»의 한 원천.

사람이 워크플로 stage를 끝낼 행동(«이 단계 완료»)과, 그 행동이 에이전트 발행과 같은 규칙을 타도록 하는 검증을 여기 모은다.
판정(`completion_mode` · `human_completion_path`)은 순수 함수라 적용 창 · 정의 가드(story 4243 클래스 가드) · 완료 엔드포인트가
같은 답을 읽는다(까디르 4606 QA P3 — 가드가 규칙 사본을 따로 들지 않게). 검증기(`validate_stage_completion`)는 story 4251에서
원시 발행 경로에도 붙일 수 있게 엔드포인트와 분리한다.

완료 방식(한 stage 기준):
- `complete`: 이 stage를 맡은 멤버가 끝내면 **다음 stage 이벤트를 그 멤버 명의로** 낸다(에이전트의 publish_event와 같은 코어).
- `last_stage`: 다음 stage가 없다 — 레시피는 여기서 끝난다(마무리는 스토리 상태 · 에이전트도 같다).
- `server_continues`: 이 stage의 사람 승인(레시피 게이트 · 초안 게이트)이 끝나면 **서버가** 다음 stage를 낸다(블로그 초안 승인 →
  자동 발행 · 외부 발행 승인 → 채널 발행). 사람이 따로 누를 것이 없다.
- `gate_approval`: 이 stage에 레시피 게이트가 있다 — 사람 몫은 결재함의 승인이고, 승인 판정 알림을 받는 다음 stage 담당이 이어 간다
  (마케팅 디렉터 stage · 까디르 4606 QA P3 «일반 게이트 승인은 자동 진행이 아님»). 이 행동 대상이 아니다.
- `needs_fields`: 다음 stage를 내려면 사람이 채울 값(봉인 필드 · 초안 연결)이 있다 — 지금은 입력 폼이 없어 완료 행동 대상이 아니다.
- `not_member_stage`: 이 stage 자체가 멤버가 맡는 자리가 아니다(채널 연결 · 연산 커넥터 — 서버가 수행).
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

CompletionMode = Literal[
    "complete", "last_stage", "server_continues", "gate_approval", "needs_fields", "not_member_stage", "unknown_stage",
]

# 멤버가 아니라 연결이 채우는 stage — 서버가 수행한다.
_CONNECTION_TARGETS = frozenset({"channel_connection", "generation_connector"})
# 초안 게이트 승인 뒤 서버가 다음 stage를 잇는 승인 자리.
_SERVER_CONTINUING_SURFACES = frozenset({"draft_gate"})
# 이 게이트가 승인되면 서버가 일을 하고 다음 stage를 낸다(뉴스레터 발송 승인 → 크론 발송 → «발송 결과 확인», story 4214).
_SERVER_CONTINUING_GATE_TYPES = frozenset({"newsletter_send"})
# 다음 stage가 이 승인 자리를 선언하면 그 stage를 내는 쪽이 초안 연결을 실어야 한다(events.py `RECIPE_SITE_DRAFT_LINK_FIELD`).
_LINK_FIELDS_BY_SURFACE = {"draft_gate": ("site_post_draft_id",)}


def _stage_enum(definition) -> list[str]:
    enum = (((definition.payload_schema or {}).get("properties") or {}).get("stage") or {}).get("enum") or []
    return [s for s in enum if isinstance(s, str)]


def _meta(definition, stage: str) -> dict:
    meta = (definition.stage_metadata or {}).get(stage)
    return meta if isinstance(meta, dict) else {}


def next_stage_of(definition, stage: str) -> str | None:
    enum = _stage_enum(definition)
    if stage not in enum:
        return None
    idx = enum.index(stage)
    return enum[idx + 1] if idx + 1 < len(enum) else None


def required_fields_for_next_stage(definition, next_stage: str) -> tuple[str, ...]:
    """다음 stage를 낼 때 사람이 채워야 하는 값 — 그 stage 게이트의 봉인 필드 + 승인 자리의 연결 필드."""
    from app.services.recipe_gate_hooks import _GATE_TYPE_SEALED_FIELDS

    meta = _meta(definition, next_stage)
    fields: list[str] = []
    gate = meta.get("gate")
    if isinstance(gate, dict):
        fields += [spec.name for spec in _GATE_TYPE_SEALED_FIELDS.get(gate.get("type"), ())]
    surface = (meta.get("approval") or {}).get("surface") if isinstance(meta.get("approval"), dict) else None
    fields += list(_LINK_FIELDS_BY_SURFACE.get(surface, ()))
    return tuple(fields)


def _server_publishes(definition, stage: str) -> bool:
    from app.routers.events import _SERVER_DRIVEN_CAPABILITY_KINDS

    capability = _meta(definition, stage).get("capability") or {}
    return capability.get("target") in _CONNECTION_TARGETS or capability.get("kind") in _SERVER_DRIVEN_CAPABILITY_KINDS


def completion_mode(definition, stage: str) -> CompletionMode:
    """이 stage를 어떻게 끝내는가(모듈 docstring 참조)."""
    if stage not in _stage_enum(definition):
        return "unknown_stage"
    meta = _meta(definition, stage)
    if _server_publishes(definition, stage):
        return "not_member_stage"
    surface = (meta.get("approval") or {}).get("surface") if isinstance(meta.get("approval"), dict) else None
    if surface in _SERVER_CONTINUING_SURFACES:
        return "server_continues"
    nxt = next_stage_of(definition, stage)
    gate = meta.get("gate")
    if isinstance(gate, dict) and gate.get("type"):
        if gate.get("type") in _SERVER_CONTINUING_GATE_TYPES or (nxt is not None and _server_publishes(definition, nxt)):
            return "server_continues"
        return "gate_approval"
    if nxt is None:
        return "last_stage"
    if _server_publishes(definition, nxt):
        # 다음 stage를 서버가 낸다 — 이 stage의 사람 몫은 승인(게이트)까지다.
        return "server_continues"
    if required_fields_for_next_stage(definition, nxt):
        return "needs_fields"
    return "complete"


def human_completion_path(definition, stage: str) -> bool:
    """사람이 화면만으로 이 stage를 끝낼 수 있는가 — human/either 역할 선언의 전제(story 4243 클래스 가드가 이것을 읽는다)."""
    return completion_mode(definition, stage) in ("complete", "last_stage", "server_continues", "gate_approval")


async def validate_stage_completion(
    db: AsyncSession, *, org_id: uuid.UUID, definition, project_id: uuid.UUID | None,
    work_item_type: str, work_item_id: uuid.UUID, stage: str, member_id: uuid.UUID,
) -> str:
    """완료 요청 검증 — 통과하면 낼 다음 stage를 돌려준다. 거부는 HTTPException(code 포함).

    ① 이 stage가 지금 stage(가장 최근 발행)다 — 겹친 클릭 · 낡은 화면.
    ② 요청자가 이 stage에 바인딩된 멤버다(project 우선 · org 전역) — 남의 stage는 못 끝낸다.
    ③ 완료 방식이 `complete`다. 게이트 있는 stage(`gate_approval` · `server_continues`)는 결재함 승인이 사람 몫이라 이 행동
       대상이 아니다 — 설계 초안의 «게이트 승인 확인»은 이 판정에 흡수된다(게이트 stage에 «완료»가 뜰 일이 없다).
       마지막 stage · 입력이 필요한 다음 stage도 대상이 아니다.
    """
    from app.routers.events import _find_latest_stage_publish
    from app.services.event_routing_resolver import _bound_member_for_stage

    latest = await _find_latest_stage_publish(
        db, org_id=org_id, definition_key=definition.key, work_item_type=work_item_type, work_item_id=str(work_item_id),
    )
    current = (((latest.msg_metadata or {}).get("event") or {}).get("payload") or {}).get("stage") if latest else None
    if current != stage:
        raise HTTPException(status_code=409, detail={
            "code": "STAGE_NOT_CURRENT", "message": "This stage is not the current stage of the workflow.",
            "current_stage": current,
        })

    bound = await _bound_member_for_stage(
        db, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=stage,
    )
    if bound is None or bound != member_id:
        raise HTTPException(status_code=403, detail={
            "code": "NOT_STAGE_ASSIGNEE", "message": "Only the member assigned to this stage can complete it.",
        })

    mode = completion_mode(definition, stage)
    if mode != "complete":
        raise HTTPException(status_code=409 if mode != "needs_fields" else 422, detail={
            "code": "STAGE_NOT_COMPLETABLE", "message": "This stage cannot be completed with this action.", "mode": mode,
        })
    nxt = next_stage_of(definition, stage)
    assert nxt is not None  # mode == complete
    return nxt


def previous_stage_of(definition, stage: str) -> str | None:
    enum = _stage_enum(definition)
    if stage not in enum:
        return None
    idx = enum.index(stage)
    return enum[idx - 1] if idx > 0 else None


async def stage_gate_status(db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, definition, stage: str) -> str | None:
    """이 stage 레시피 게이트의 가장 최근 상태(pending · approved · rejected …). 게이트가 없으면 None."""
    from app.models.gate import Gate

    gate = _meta(definition, stage).get("gate")
    if not isinstance(gate, dict) or not gate.get("type"):
        return None
    return (await db.execute(
        select(Gate.status)
        .where(Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.gate_type == gate["type"])
        .order_by(Gate.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def validate_next_stage_start(
    db: AsyncSession, *, org_id: uuid.UUID, definition, project_id: uuid.UUID | None,
    work_item_type: str, work_item_id: uuid.UUID, stage: str, member_id: uuid.UUID,
) -> str:
    """«승인됨 → 내 단계 시작» 검증(PO 4249 빈틈) — 게이트 stage가 승인되면 판정 알림을 받은 **다음 stage 담당**이 이어 간다.
    담당이 사람이면 자기 stage 이벤트를 화면에서 내야 한다. 통과하면 낼 stage(`stage` 그대로)를 돌려준다.

    ① 지금 stage가 `stage` 바로 앞 stage다.
    ② 그 앞 stage의 완료 방식이 `gate_approval`이고 게이트가 승인됐다.
    ③ 요청자가 `stage`에 바인딩된 멤버다.
    ④ `stage`를 내는 데 사람이 채울 값이 없다(봉인 필드 · 연결 필드)."""
    from app.routers.events import _find_latest_stage_publish
    from app.services.event_routing_resolver import _bound_member_for_stage

    prev = previous_stage_of(definition, stage)
    latest = await _find_latest_stage_publish(
        db, org_id=org_id, definition_key=definition.key, work_item_type=work_item_type, work_item_id=str(work_item_id),
    )
    current = (((latest.msg_metadata or {}).get("event") or {}).get("payload") or {}).get("stage") if latest else None
    if prev is None or current != prev:
        raise HTTPException(status_code=409, detail={
            "code": "STAGE_NOT_NEXT", "message": "This stage does not come right after the current stage.",
            "current_stage": current,
        })
    if completion_mode(definition, prev) != "gate_approval" or await stage_gate_status(
        db, org_id=org_id, work_item_id=work_item_id, definition=definition, stage=prev,
    ) != "approved":
        raise HTTPException(status_code=409, detail={
            "code": "PREVIOUS_STAGE_NOT_APPROVED", "message": "The previous stage's approval is not granted yet.",
        })
    bound = await _bound_member_for_stage(db, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=stage)
    if bound is None or bound != member_id:
        raise HTTPException(status_code=403, detail={
            "code": "NOT_STAGE_ASSIGNEE", "message": "Only the member assigned to this stage can start it.",
        })
    if required_fields_for_next_stage(definition, stage) or _server_publishes(definition, stage):
        raise HTTPException(status_code=422, detail={
            "code": "STAGE_NOT_STARTABLE", "message": "This stage cannot be started with this action.",
        })
    return stage


async def work_item_project(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID, claimed_project_id: uuid.UUID | None,
) -> uuid.UUID:
    """이 작업 항목의 실제 프로젝트 — 인가 · 지금 stage · 바인딩 판정이 모두 이 값 하나를 쓴다(까디르 4623 codex P1). 요청이 보낸
    프로젝트는 믿지 않고 대조만 한다: 다르면 거절(A 권한으로 B 항목을 A 바인딩에 태워 B에서 발행하는 길을 막는다), 없으면 푼 값을
    쓴다. 발행 코어도 같은 함수(`_resolve_work_item_project_id`)로 라우팅을 푼다."""
    from app.services.event_routing_resolver import _resolve_work_item_project_id

    project_id = await _resolve_work_item_project_id(
        db, org_id=org_id, payload={"work_item_type": work_item_type, "work_item_id": str(work_item_id)},
    )
    if project_id is None:
        raise HTTPException(status_code=404, detail={"code": "WORK_ITEM_NOT_FOUND", "message": "Work item not found."})
    if claimed_project_id is not None and claimed_project_id != project_id:
        raise HTTPException(status_code=422, detail={
            "code": "WORK_ITEM_PROJECT_MISMATCH", "message": "The work item does not belong to this project.",
        })
    return project_id


async def lock_stage_completion(
    db: AsyncSession, *, org_id: uuid.UUID, definition_key: str, work_item_type: str, work_item_id: uuid.UUID,
) -> None:
    """같은 work item의 완료 요청을 직렬화한다(트랜잭션 수준 advisory lock — 커밋 · 롤백 때 PG가 푼다). 뒤 요청은 앞 요청의
    발행이 커밋된 뒤 ①에서 «지금 stage가 아님»으로 걸린다."""
    key = f"recipe-stage-complete:{org_id}:{definition_key}:{work_item_type}:{work_item_id}"
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": key})

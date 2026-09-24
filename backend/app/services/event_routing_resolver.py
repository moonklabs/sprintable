"""story #2633 — routing(상신선·전파선) 선언을 실제 member_id 집합으로 푸는 해석기.

#2632의 event_definition_registry.validate_event_routing()이 등록 시점에 두 부류(payload_
field/server_derived) 계약을 강제했다 — 이 모듈은 그 계약을 **소비**하는 쪽(발행 시점)이다.
kind="server_derived"의 target은 SERVER_DERIVED_TARGETS 닫힌 어휘 안에서만 존재하므로, 여기
resolver 매핑도 정확히 그 어휘와 1:1이어야 한다(어휘에 있는데 resolver가 모르면 등록은
통과했는데 발행이 조용히 빈 집합을 내는 결함 — 아래 _SERVER_DERIVED_RESOLVERS가 SERVER_
DERIVED_TARGETS 전체를 커버하는지 모듈 로드 시점에 assert로 고정한다)."""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.event_definition_registry import SERVER_DERIVED_TARGETS

logger = logging.getLogger(__name__)


class MissingRoutingPayloadFieldError(ValueError):
    """kind=payload_field인데 그 member_id_field가 payload에 없거나 값이 비었음 — 조용히
    빈 집합으로 넘기지 않고 발행 시점에 명시 오류(story #2633 AC4 "조용한 유실 금지")."""


class UnknownRoutingMemberError(ValueError):
    """story #2693(PO 자체 사고, customer-zero) — kind=payload_field로 받은 member_id가
    문법적으로는 유효한 UUID지만 이 org의 실존 회원이 아님. 예전엔 그대로 통과시켜
    `_get_or_create_event_conversation`이 그 UUID를 참가자로 앉힌 «유령 conversation»을
    만들고 메시지까지 저장했다(reach=1 거짓 성공 — ConversationParticipant.member_id에
    FK가 없어 존재하지 않는 member_id도 조용히 insert된다, story #2697 그라운딩에서
    확인된 사실과 동형 갭). 여기서 막으면(caller가 conv/msg 어느 것도 만들기 전) 원자성이
    자연히 보장된다 — publish_event()의 routing 해석 지점이 그 어떤 DB write보다 먼저다."""


class InvalidWorkItemReferenceError(ValueError):
    """work_item_id/goal_id/payload_field UUID 값이 문법적으로 유효한 UUID가 아님 — story
    #2675: event_definition_registry.validate_event_payload가 format:uuid를 이제 집행하지만,
    이 함수는 org 커스텀 정의(#2636)가 그 필드에 format:uuid 선언을 빠뜨린 경우까지 대비한
    2차 방어선이다. uuid.UUID() 파싱 실패를 처리 안 된 ValueError로 흘려 500을 내지 않고
    발행 시점에 명시 거부한다."""


def _parse_uuid(value: str, *, field_name: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError) as e:
        raise InvalidWorkItemReferenceError(
            f"payload.{field_name}이 올바른 UUID 형식이 아닙니다: {value!r}"
        ) from e


async def _resolve_work_item_stakeholders(
    db: AsyncSession, *, org_id: uuid.UUID, payload: dict,
) -> set[uuid.UUID]:
    """work_item_type/work_item_id → 그 작업의 이해관계자(담당자·human owner·복수 assignee).
    타입별 필드가 제각각이라(story/task/goal 전부 다른 모델) 여기서 타입별 분기 — 코드베이스에
    범용 헬퍼가 없어 이 스토리에서 신설(그라운딩 확認, #2620/#2617류 재사용 대상 없음).

    story #3340(선생님 4바퀴 실사고) — payload에 ``gate_requester_member_id``가 실려 있으면
    (지금은 preset.gate.verdict 하나뿐, gate_service.py::_publish_gate_verdict_notification이
    싣는다 — neutral_facts.requested_by_member_id 출처) work_item_type 분기와 무관하게 항상
    이해관계자 집합에 합류시킨다. work item이 미배정이라 stakeholders가 빈 집합이어도 "이
    게이트를 요청한 사람"에겐 도달해야 한다는 원칙 — 제네릭 키라 다른 이벤트도 같은 키를
    실으면 별도 코드 없이 같이 커버된다.

    story #3370(Phase0·마케팅운영 S5) AC1 — ``gate_draft_author_member_id``(neutral_facts.
    draft_author_member_id 출처, recipe_gate_hooks.py::_build_approval_neutral_facts가
    doc.created_by에서 채움)도 동일 관례로 합류시킨다 — "이 초안을 쓴 사람"도 판정 결과를
    받아야 한다(§PO-2). ``ids``가 set이라 assignee·requester·author가 같은 사람이어도
    구조적으로 한 번만 남는다(AC1 "동일 멤버는 한 번만 포함")."""
    ids: set[uuid.UUID] = set()
    _requester_raw = payload.get("gate_requester_member_id")
    if isinstance(_requester_raw, str) and _requester_raw:
        ids.add(_parse_uuid(_requester_raw, field_name="gate_requester_member_id"))
    _author_raw = payload.get("gate_draft_author_member_id")
    if isinstance(_author_raw, str) and _author_raw:
        ids.add(_parse_uuid(_author_raw, field_name="gate_draft_author_member_id"))

    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    if not work_item_type or not work_item_id_raw:
        return ids
    work_item_id = _parse_uuid(work_item_id_raw, field_name="work_item_id")

    if work_item_type == "story":
        from app.models.pm import Story
        from app.models.story_assignee import StoryAssignee

        row = (await db.execute(
            select(Story.assignee_id, Story.human_owner_member_id).where(
                Story.id == work_item_id, Story.org_id == org_id,
            )
        )).one_or_none()
        if row is not None:
            ids |= {m for m in row if m is not None}
        extra = (await db.execute(
            select(StoryAssignee.member_id).where(StoryAssignee.story_id == work_item_id)
        )).scalars().all()
        ids |= set(extra)
        return ids

    if work_item_type == "task":
        from app.models.pm import Task

        assignee = (await db.execute(
            select(Task.assignee_id).where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
        if assignee:
            ids.add(assignee)
        return ids

    if work_item_type in ("goal", "epic"):
        from app.models.pm import Goal

        assignee = (await db.execute(
            select(Goal.assignee_id).where(Goal.id == work_item_id, Goal.org_id == org_id)
        )).scalar_one_or_none()
        if assignee:
            ids.add(assignee)
        return ids

    # 미지원 work_item_type — fail-open(빈 집합·요청자만)·경고 로그만. 발행 자체를 막지
    # 않는다(전파선 해석 실패가 escalation까지 막으면 안 된다는 게 이 함수의 실패 정책 —
    # best-effort).
    logger.warning(
        "event_routing_resolver: unsupported work_item_type=%s for work_item_stakeholders",
        work_item_type,
    )
    return ids


async def _resolve_goal_owner(db: AsyncSession, *, org_id: uuid.UUID, payload: dict) -> set[uuid.UUID]:
    from app.models.pm import Goal

    goal_id_raw = payload.get("goal_id")
    if not goal_id_raw:
        return set()
    goal_id = _parse_uuid(goal_id_raw, field_name="goal_id")
    assignee = (await db.execute(
        select(Goal.assignee_id).where(Goal.id == goal_id, Goal.org_id == org_id)
    )).scalar_one_or_none()
    return {assignee} if assignee else set()


async def _resolve_none(db: AsyncSession, *, org_id: uuid.UUID, payload: dict) -> set[uuid.UUID]:  # noqa: ARG001
    return set()


async def _resolve_work_item_project_id(
    db: AsyncSession, *, org_id: uuid.UUID, payload: dict,
) -> uuid.UUID | None:
    """story #3288 — recipe_role_binding이 project 스코프 바인딩을 찾으려면 work_item의
    project_id가 필요하다. _resolve_work_item_stakeholders와 동일 타입 분기(중복이지만 그
    함수는 담당자 id를, 이건 project_id를 뽑아 반환 shape이 달라 별도 함수로 유지 — 이후
    공통화는 후속 리팩터, 이 스토리 스코프 밖)."""
    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    if not work_item_type or not work_item_id_raw:
        return None
    work_item_id = _parse_uuid(work_item_id_raw, field_name="work_item_id")

    if work_item_type == "story":
        from app.models.pm import Story

        return (await db.execute(
            select(Story.project_id).where(Story.id == work_item_id, Story.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "task":
        from app.models.pm import Task

        return (await db.execute(
            select(Task.project_id).where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type in ("goal", "epic"):
        from app.models.pm import Goal

        return (await db.execute(
            select(Goal.project_id).where(Goal.id == work_item_id, Goal.org_id == org_id)
        )).scalar_one_or_none()

    logger.warning(
        "event_routing_resolver: unsupported work_item_type=%s for recipe_role_binding project lookup",
        work_item_type,
    )
    return None


async def resolve_broad_crew_member_ids(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID | None,
) -> set[uuid.UUID]:
    """story #4147(페드루 PO 確定 2026-09-22) — `events.py::_resolve_crew_scoped_recipe_
    binding`(#4132 CHANGES-1)의 3번 판정("이 project(+org 전역)에 적용된 모든 event_
    definition_key에 걸쳐 agent_member_id로 묶인 «넓은 crew» 집합")을 그 함수에서 뽑아
    여기로 옮긴 것 — 새 판정 로직 0, SQL 그대로 이동(추출 직후 events.py 쪽 실측: 기존
    test_4110_generation_connector_read_realdb.py·test_4132_channel_connection_status_
    realdb.py 전부 그린 유지). channel_posts.py(#4147, draft 미디어 업로드 참여 판정)가
    두 번째 소비자가 되면서 events.py 라우터 안에 갇혀 있던 걸 서비스 계층(다른 라우터도
    import 가능한 자리)으로 끌어냈다."""
    from app.models.recipe_role_binding import RecipeRoleBinding

    binding_rows = (await db.execute(
        select(RecipeRoleBinding.event_definition_key).where(
            RecipeRoleBinding.org_id == org_id,
            or_(RecipeRoleBinding.project_id == project_id, RecipeRoleBinding.project_id.is_(None)),
        )
    )).all()
    applied_keys = sorted({k for (k,) in binding_rows})
    if not applied_keys:
        return set()

    return set((await db.execute(
        select(RecipeRoleBinding.agent_member_id).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.event_definition_key.in_(applied_keys),
            RecipeRoleBinding.agent_member_id.is_not(None),
            or_(RecipeRoleBinding.project_id == project_id, RecipeRoleBinding.project_id.is_(None)),
        )
    )).scalars().all())


async def _bound_member_for_stage(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID | None, definition_key: str, stage: str,
) -> uuid.UUID | None:
    """그 stage에 바인딩된 멤버(`agent_member_id` 열 — 에이전트·사람 종류 무관) — project 스코프 바인딩 우선, 없으면 org
    전역(story #3288 규칙 그대로)."""
    from app.models.recipe_role_binding import RecipeRoleBinding

    if project_id is not None:
        agent_id = (await db.execute(
            select(RecipeRoleBinding.agent_member_id).where(
                RecipeRoleBinding.org_id == org_id,
                RecipeRoleBinding.project_id == project_id,
                RecipeRoleBinding.event_definition_key == definition_key,
                RecipeRoleBinding.stage == stage,
            )
        )).scalar_one_or_none()
        if agent_id is not None:
            return agent_id
    return (await db.execute(
        select(RecipeRoleBinding.agent_member_id).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.project_id.is_(None),
            RecipeRoleBinding.event_definition_key == definition_key,
            RecipeRoleBinding.stage == stage,
        )
    )).scalar_one_or_none()


async def _stage_approval_is_elsewhere(
    db: AsyncSession, *, org_id: uuid.UUID, definition_key: str, stage: str,
) -> bool:
    """story #4243 — stage가 `approval.surface`를 선언했고 그 stage의 멤버 종류가 에이전트가 아닌가. FE `stageApprovalSurface`
    (recipe-role-slots.ts · `stageMemberKind() !== 'agent'`)와 같은 규칙이다(까디르 4606 델타 P2): 채널 연결 · 연산 커넥터
    stage는 멤버 종류가 없어(null) 에이전트가 아니고, 선언 없는 역할은 에이전트다."""
    from app.models.event_definition import EventDefinition

    definition = (await db.execute(
        select(EventDefinition)
        .where(
            EventDefinition.key == definition_key,
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
        .order_by(EventDefinition.org_id.is_(None))
        .limit(1)
    )).scalar_one_or_none()
    if definition is None:
        return False
    meta = (definition.stage_metadata or {}).get(stage) or {}
    if not isinstance(meta, dict) or not (meta.get("approval") or {}).get("surface"):
        return False
    if (meta.get("capability") or {}).get("target") in ("channel_connection", "generation_connector"):
        return True
    kinds = definition.role_actor_kinds if isinstance(definition.role_actor_kinds, dict) else {}
    return (kinds.get(meta.get("role")) or "agent") != "agent"


async def _resolve_recipe_role_binding(
    db: AsyncSession, *, org_id: uuid.UUID, payload: dict, definition_key: str,
) -> set[uuid.UUID]:
    """story #3288(축2-ⓐ) — stage_metadata.role은 표시 텍스트뿐이라, 발행 시점에 "이 stage는
    실제로 누구인가"를 recipe_role_bindings에서 조회한다. project 스코프 바인딩이 org 전역
    바인딩보다 우선(project_id IS NOT NULL 행을 먼저 찾고 없으면 project_id IS NULL로 폴백).

    ⛔PO 확定(2026-09-01) 「모르면 안 준다」 — 바인딩이 없으면 빈 집합을 반환한다(다른
    server_derived류 폴백으로 조용히 대체하지 않음 — 미배정 stage가 엉뚱한 이해관계자에게
    새는 것 자체가 방지 대상)."""
    stage = payload.get("stage")
    if not stage:
        return set()

    project_id = await _resolve_work_item_project_id(db, org_id=org_id, payload=payload)
    if await _stage_approval_is_elsewhere(db, org_id=org_id, definition_key=definition_key, stage=stage):
        # story #4243(까디르 4606 렌즈 · PO ⓑ) — 승인이 stage 밖(approval.surface)인 사람 · either 역할 stage는 고를 담당이
        # 없는 읽기 전용 자리다. 적용 창이 이제 그 stage를 싣지 않지만, 예전에 적용한 조직엔 옛 바인딩 행이 남아 있다(적용 API는
        # 빠진 stage를 지우지 않는다). 그 행을 수신자로 잡으면 옛 사람(바뀌었으면 엉뚱한 사람)에게 간다 — 해소에서 뺀다.
        # 승인 쪽 이음매는 그 게이트의 결재 카드다.
        return set()
    member_id = await _bound_member_for_stage(
        db, org_id=org_id, project_id=project_id, definition_key=definition_key, stage=stage,
    )
    if member_id is not None:
        return {member_id}

    # story #4110(#4109 PO 결정, 2026-09-21) — generation_connector-target stage(예:
    # live_generation)는 agent_member_id가 원천적으로 없다(그 stage의 바인딩 행은
    # generation_connector_id로 채워짐, #4101 XOR). 그 stage에 **한해서만**(다른 미배정
    # agent-target stage까지 번지면 위 PO 확定 「모르면 안 준다」 원칙과 충돌) "같은
    # 적용(org·[project 특이 ∪ org 전역]·event_definition_key)의 crew"(agent_member_id가
    # 채워진 모든 행의 집합)로 폴백한다 — 리허설 1호에서 댄이 live_generation을 스스로
    # 발행하고 이어간 형상을 제품이 명시적으로 지지하는 것.
    from app.models.event_definition import EventDefinition
    from app.models.recipe_role_binding import RecipeRoleBinding

    definition = (await db.execute(
        select(EventDefinition)
        .where(
            EventDefinition.key == definition_key,
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
        # org 커스텀이 프리셋보다 우선 — events.py::get_recipe_start_candidates/
        # apply_recipe_role_bindings와 동일 우선순위(중복 정의 시나리오 대비).
        .order_by(EventDefinition.org_id.is_(None))
        .limit(1)
    )).scalar_one_or_none()
    if definition is None:
        return set()
    capability = (definition.stage_metadata.get(stage) or {}).get("capability") or {}
    if capability.get("target") == "channel_connection":
        # story #4242 — 채널 연결 stage(뉴스레터 «캠페인 생성» 등)는 서버가 대신 수행하는 자리라 바인딩된 멤버가 원래
        # 없다(그 stage의 바인딩 행은 channel_connection_id). 그 이벤트는 **다음 stage에 바인딩된 멤버**(에이전트·사람 종류
        # 무관 — 명시적 바인딩은 «아는» 경우)가 받는다. 그래야 다음 할 일(발행 예시 · 봉인 필드)이 도달한다. 예전엔 수신자
        # 0이라 흐름이 거기서 멈췄다. 다음 stage가 없으면(마지막 stage) 0 그대로. 다음 stage에 바인딩된 멤버가 없거나 그
        # stage가 또 다른 서버 stage(채널 연결 · 연산 커넥터)면 **건너뛰지 않고** 0 + 경고(PO 2026-09-24 — 흐름을 조용히
        # 건너뛰게 두지 않는다 · 「모르면 안 준다」).
        from app.routers.events import _next_recipe_stage

        next_stage = _next_recipe_stage(definition, stage)
        if next_stage is None:
            return set()
        next_capability = (definition.stage_metadata.get(next_stage) or {}).get("capability") or {}
        next_member = None
        if next_capability.get("target") in (None, "agent"):
            next_member = await _bound_member_for_stage(
                db, org_id=org_id, project_id=project_id, definition_key=definition_key, stage=next_stage,
            )
        if next_member is None:
            logger.warning(
                "recipe_role_binding: channel stage %r -> next stage %r has no bound member — 0 recipients (definition=%s)",
                stage, next_stage, definition_key,
            )
            return set()
        return {next_member}
    if capability.get("target") != "generation_connector":
        return set()

    # ⛔`.in_([project_id, None])`은 SQL `IN (val, NULL)`로 컴파일되는데 `col = NULL`은
    # 항상 UNKNOWN이라 project_id가 NULL인(org 전역) 행을 못 잡는다(`?`/`!=` NULL 함정과
    # 같은 클래스) — `or_(... == project_id, ... .is_(None))`로 명시.
    project_filter = (
        or_(RecipeRoleBinding.project_id == project_id, RecipeRoleBinding.project_id.is_(None))
        if project_id is not None else RecipeRoleBinding.project_id.is_(None)
    )
    crew_ids = (await db.execute(
        select(RecipeRoleBinding.agent_member_id).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.event_definition_key == definition_key,
            RecipeRoleBinding.agent_member_id.is_not(None),
            project_filter,
        )
    )).scalars().all()
    return set(crew_ids)


# SERVER_DERIVED_TARGETS(event_definition_registry.py) 전체를 커버해야 한다 — 모듈 로드
# 시점에 어긋나면 즉시 ImportError로 드러나게(운영 중 조용한 미해석 대신).
_SERVER_DERIVED_RESOLVERS = {
    "none": _resolve_none,
    "work_item_stakeholders": _resolve_work_item_stakeholders,
    "goal_owner": _resolve_goal_owner,
}
assert set(_SERVER_DERIVED_RESOLVERS) == set(SERVER_DERIVED_TARGETS), (
    "event_routing_resolver의 server_derived resolver 어휘가 "
    "event_definition_registry.SERVER_DERIVED_TARGETS와 어긋남"
)


async def resolve_routing_leg(
    leg: dict, *, payload: dict, org_id: uuid.UUID, db: AsyncSession,
    definition_key: str | None = None,
) -> set[uuid.UUID]:
    """routing.escalation 또는 routing.broadcast 한 leg를 실제 member_id 집합으로. leg는
    이미 validate_event_routing()을 통과한 정의에서 온 것을 전제(등록 시점 계약 검증 완료 —
    여기서 kind/target 모양을 다시 의심하지 않는다, 값 해석만).

    definition_key: kind="recipe_role_binding"일 때만 필수(story #3288) — 그 외 kind는 안 씀,
    기존 호출부(#2633) 무회귀 위해 기본값 None."""
    if leg["kind"] == "recipe_role_binding":
        if not definition_key:
            raise ValueError("recipe_role_binding 해석에는 definition_key가 필요합니다.")
        return await _resolve_recipe_role_binding(
            db, org_id=org_id, payload=payload, definition_key=definition_key,
        )

    if leg["kind"] == "payload_field":
        field = leg["member_id_field"]
        value = payload.get(field)
        if not value:
            raise MissingRoutingPayloadFieldError(
                f"routing이 요구하는 payload.{field}가 없거나 비었습니다."
            )
        member_id = _parse_uuid(value, field_name=field)
        from app.services.member_resolver import filter_org_member_ids

        valid = await filter_org_member_ids({member_id}, org_id, db)
        if not valid:
            raise UnknownRoutingMemberError(
                f"routing이 요구하는 payload.{field}({member_id})가 이 org의 실존 회원이 아닙니다."
            )
        return valid

    resolver = _SERVER_DERIVED_RESOLVERS[leg["target"]]
    return await resolver(db, org_id=org_id, payload=payload)

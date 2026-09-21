"""story #3312(M1→M3·마케팅자동화) — recipe(사이클형 EventDefinition)의 stage 이벤트 발행이
`stage_metadata[stage].gate` 선언을 가지고 있으면, 그 work item에 게이트를 자동 생성한다.

event_routing_resolver.py와 동형 설계 — `_publish_registry_event_core`(routers/events.py,
#2633 AC2 단일파이프)가 routing 해석 직후 이 모듈을 호출하는 별도 단일목적 서비스(인라인
stage=="approve" 분기 대신). PO 판단(페드루, 2026-09-02) — 이 코드베이스 기존 관례(단일
core + 단일목적 서비스 호출 컴포지션)와 정합, 테스트도 격리됨.

`gate` 선언 shape은 event_definition_registry.validate_stage_metadata가 등록/수정 시점에
이미 강제한다({type: str, approver: APPROVER_ROLE_REFERENCES 소속}) — 이 모듈은 그 계약을
신뢰하고 값 해석만 한다(routing_resolver가 validate_event_routing의 계약을 신뢰하는 것과
동일 원칙, resolve_routing_leg 참조)."""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.services.event_definition_registry import APPROVER_ROLE_REFERENCES
from app.services.reference_token import build_reference_token

logger = logging.getLogger(__name__)

# PO 확定(페드루, 2026-09-02, 변경요청①) — 값을 지어내지 않는다: 못 찾은 필드는 이 sentinel로
# 명시한다("가서 보라" 금지 — story #3312 처방 3과 동형, 결재 카드에 실물이 안 보이면 그
# 사실 자체를 정직하게 드러낸다).
_UNCONFIRMED = "미확認"

# story #4044(E-RECIPE-1 ①, 페드루 PO 確定 2026-09-18 — "기존 generation_budget.py+0333
# sealed_estimated_cost_minor 재사용, 새 축 만들지 말 것") — 레시피 stage 게이트 중 "실탄
# 발사" 부류. concept_approval(story #3561)이 doc 봉인 특수분기를 갖는 것과 동형으로, 이
# gate_type만 예산 특수분기(사전 하드체크+사후 sealed_estimated_cost_minor 봉인)를 갖는다.
# ⚠️channel_posts.py/site_posts.py의 budget-check는 "external_publish 게이트 그 자신"에
# 얹혀 있다(발행 신청 시점=생성 시점이 같은 도메인이라 한 게이트로 충분) — 이 레시피는 실탄
# 발사(생성 착수)와 최종 발행이 여러 stage 떨어진 별개 시점이라 그 패턴을 literal로 재사용할
# 수 없다(같은 work_item에 gate_type="external_publish"를 또 만들면 create_gate 멱등 키가
# 충돌한다). 그래서 새 gate_type 문자열 하나만 열고, 기존 판정 프리미티브(check_generation_
# budget_or_raise)와 기존 컬럼(gate.sealed_estimated_cost_minor, 0333)만 재사용한다.
_GENERATION_BUDGET_GATE_TYPE = "generation_budget"


class UnknownApproverRoleError(ValueError):
    """approver 역할참조를 실 member_id로 못 풀었음 — 어휘는 등록 시점에 이미 검증됐으므로,
    여기서 나오면 "그 org에 role=owner인 org_member가 없다"류의 실제 데이터 결함이다(오타
    클래스 아님 — 조용히 넘기면 게이트가 승인자 없이 붕 떠버리므로 발행 시점에 명시 거부)."""


# story #4085(리허설 1호 실측, PO 확定 2026-09-21) — gate_type별 "이 게이트가 봉인에 쓰는
# payload 필드"의 단일 SSOT. 실사고: generation_budget 게이트가 estimated_cost_minor
# 없이 열려(사전 하드체크는 "미설정이면 통과"가 맞는 규약 — #4044) 결재 카드에 예상 비용이
# 0/null로 비어 있었다. 레시피 키·stage 하드코딩 없이 gate_type 하나로만 갈라 다음 레시피
# 에도 그대로 적용된다(새 gate_type이 봉인 필드를 쓰려면 여기 한 줄만 추가). events.py의
# 자기설명 렌더러(story #4085 AC1, #4458 rebase 뒤 착수)도 이 SSOT를 그대로 읽어 예시
# payload에 실을 필드 목록을 구성한다 — 새 목록 발명 0.
_GATE_TYPE_SEALED_FIELDS: dict[str, tuple[str, ...]] = {
    _GENERATION_BUDGET_GATE_TYPE: ("estimated_cost_minor",),
}


class MissingGateSealedFieldError(ValueError):
    """story #4085 AC2 — gate_decl["type"]이 _GATE_TYPE_SEALED_FIELDS에 선언한 필드 중
    하나라도 payload에 없거나(또는 잘못된 타입이면) 게이트를 만들지 않고 여기서 막는다.
    #4044의 "estimated_cost_minor 미설정이면 예산 검사를 스킵한다"는 예산 *한도 비교*의
    규약이지 예산 *게이트*가 숫자 없이 열려도 된다는 뜻이 아니다(PO 확定 — "숫자 없는
    예산 게이트는 게이트가 아니다") — 그래서 이 검사는 check_generation_budget_or_raise
    호출 前, create_gate 호출 前에 온다(부분 봉인 상태로 게이트가 만들어지는 경로 0)."""

    def __init__(self, *, gate_type: str, missing_fields: list[str]):
        self.gate_type = gate_type
        self.missing_fields = missing_fields
        # 이 메시지는 사용자에게 안 닿는다(내부 진단용 — 실 사용자 문장은 events.py의
        # 라우터가 i18n_catalog `events.gate_sealed_field_missing`으로 별도 조립한다,
        # #3779 가드 대상 밖) — 영문 고정.
        super().__init__(
            f"gate_type={gate_type!r} publish is missing required sealed field(s): {missing_fields}"
        )


async def _resolve_org_owner(db: AsyncSession, *, org_id: uuid.UUID) -> uuid.UUID:
    member_id = (await db.execute(
        select(OrgMember.id)
        .where(OrgMember.org_id == org_id, OrgMember.role == "owner", OrgMember.deleted_at.is_(None))
        .order_by(OrgMember.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()
    if member_id is None:
        raise UnknownApproverRoleError(f"org {org_id}에 role=owner인 org_member가 없습니다.")
    return member_id


# APPROVER_ROLE_REFERENCES(event_definition_registry.py, 등록 시점 강제 어휘) 전체를 이
# 모듈이 실제로 풀 수 있는지 로드 시점에 고정 — event_routing_resolver.py의
# _SERVER_DERIVED_RESOLVERS 완결성 assert와 동일 패턴(등록은 통과했는데 발행이 조용히
# 못 푸는 정의가 만들어지는 것을 막는다).
_APPROVER_ROLE_RESOLVERS = {"org_owner": _resolve_org_owner}
assert set(_APPROVER_ROLE_RESOLVERS) == set(APPROVER_ROLE_REFERENCES), (
    "recipe_gate_hooks의 approver role resolver 어휘가 "
    "event_definition_registry.APPROVER_ROLE_REFERENCES와 어긋남"
)


def _parse_work_item_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


async def _work_item_title(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> str | None:
    """event_routing_resolver._resolve_work_item_stakeholders와 동형 타입별 분기(그 함수와
    나란히 둘 범용 헬퍼가 이 코드베이스에 없다는 것도 같은 그라운딩에서 확認됨) — 지원하는
    타입만 조회, 그 외는 None(지어내지 않음)."""
    if work_item_type == "story":
        from app.models.pm import Story

        return (await db.execute(
            select(Story.title).where(Story.id == work_item_id, Story.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "task":
        from app.models.pm import Task

        return (await db.execute(
            select(Task.title).where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
    return None


async def _latest_linked_draft_doc(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> tuple[uuid.UUID, str, str, uuid.UUID | None] | None:
    """이 work item과 doc 사이의 가장 최근 entity_references 행(어느 방향이든 — 산출물 doc이
    work item을 참조했을 수도, work item쪽 텍스트가 doc을 참조했을 수도 있다)을 찾아 그 doc의
    (id, title, content, created_by)를 반환. 없으면 None(지어내지 않음).

    story #3370(Phase0·마케팅운영 S5) — created_by를 4번째 원소로 추가(#3323이 만든 (id,
    title, content) 3-tuple 확장) — 「초안 원작성자」 통지 수신자 집합에 합류시키는 데
    쓴다(_build_approval_neutral_facts 참조)."""
    from app.models.reference import Reference

    row = (await db.execute(
        select(Reference.source_type, Reference.source_id, Reference.target_type, Reference.target_id)
        .where(
            Reference.org_id == org_id,
            or_(
                and_(
                    Reference.target_type == work_item_type, Reference.target_id == work_item_id,
                    Reference.source_type == "doc",
                ),
                and_(
                    Reference.source_type == work_item_type, Reference.source_id == work_item_id,
                    Reference.target_type == "doc",
                ),
            ),
        )
        .order_by(Reference.created_at.desc())
        .limit(1)
    )).first()
    if row is None:
        return None
    source_type, source_id, _target_type, target_id = row
    doc_id = source_id if source_type == "doc" else target_id

    from app.models.doc import Doc

    doc_row = (await db.execute(
        select(Doc.title, Doc.content, Doc.created_by).where(Doc.id == doc_id, Doc.org_id == org_id)
    )).first()
    if doc_row is None:
        return None
    doc_title, doc_content, created_by = doc_row
    return doc_id, doc_title, doc_content or "", created_by


async def _resolve_doc_by_id(
    db: AsyncSession, *, org_id: uuid.UUID, doc_id_raw: object,
) -> tuple[uuid.UUID, str, str, uuid.UUID | None] | None:
    """story #3323 AC2 — payload.previous_output_doc_id(문자열 uuid)를 그 org의 실 doc으로
    직접 해소한다. 파싱 실패·존재하지 않는 doc(다른 org 포함)은 None(지어내지 않음 — 호출부가
    `_latest_linked_draft_doc` 폴백으로 이어받는다).

    story #3370 — created_by를 4번째 원소로 추가(_latest_linked_draft_doc과 동형 확장)."""
    if not isinstance(doc_id_raw, str) or not doc_id_raw:
        return None
    try:
        doc_id = uuid.UUID(doc_id_raw)
    except (ValueError, AttributeError, TypeError):
        return None

    from app.models.doc import Doc

    doc_row = (await db.execute(
        select(Doc.title, Doc.content, Doc.created_by).where(Doc.id == doc_id, Doc.org_id == org_id)
    )).first()
    if doc_row is None:
        return None
    doc_title, doc_content, created_by = doc_row
    return doc_id, doc_title, doc_content or "", created_by


async def _build_approval_neutral_facts(
    db: AsyncSession, *, org_id: uuid.UUID, definition, stage: str, work_item_type: str,
    work_item_id: uuid.UUID, payload: dict,
) -> dict:
    """PO 변경요청①(페드루, 2026-09-02) — 결재함 카드가 승인자에게 «무엇을 승인하는지»를
    실물로 보여줘야 한다(story 처방 3, "가서 보라" 금지). work item 제목+참조 토큰·payload
    채널·그 work item에 링크된 최신 산출물 doc(직전 draft) 참조+텍스트 요약(첫 300자)을
    채운다 — 못 찾은 값은 _UNCONFIRMED로 명시(침묵도 지어냄도 아님).

    story #3323 AC2 — draft doc 해소는 3경로 우선순위다: ①payload.previous_output_doc_id
    (발행자가 이번 stage의 산출물을 직접 지목 — 가장 정확) ②entity_references 최신 링크
    (#3312 원래 경로, work item↔doc이 나중에 링크되는 경우) ③미확認(둘 다 없음, 지어내지
    않음). 게이트 생성 시점엔 아직 entity_references가 없는 게 정상 경로(에이전트가 doc을
    나중에 스토리에 링크)라, ①이 그 갭을 메운다."""
    facts: dict = {"triggered_by_event": definition.key, "stage": stage}

    title = await _work_item_title(db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id)
    facts["work_item_title"] = title or _UNCONFIRMED
    facts["work_item_reference_token"] = (
        (build_reference_token(work_item_type, work_item_id, title) if title else None) or _UNCONFIRMED
    )

    channel = payload.get("channel")
    facts["channel"] = channel if isinstance(channel, str) and channel else _UNCONFIRMED

    draft = await _resolve_doc_by_id(db, org_id=org_id, doc_id_raw=payload.get("previous_output_doc_id"))
    if draft is None:
        draft = await _latest_linked_draft_doc(
            db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
        )
    if draft is None:
        facts["draft_doc_reference_token"] = _UNCONFIRMED
        facts["draft_doc_summary"] = _UNCONFIRMED
    else:
        doc_id, doc_title, doc_content, draft_author_id = draft
        facts["draft_doc_reference_token"] = build_reference_token("doc", doc_id, doc_title) or _UNCONFIRMED
        facts["draft_doc_summary"] = doc_content[:300] or _UNCONFIRMED
        # story #3370(Phase0·마케팅운영 S5) AC1 — 초안 원작성자(대개 담롱류 고객 에이전트)를
        # 판정 통지 수신자 집합에 합류시킨다(gate_service.py::_publish_gate_verdict_
        # notification이 이 키를 읽어 payload.gate_draft_author_member_id로 싣고,
        # event_routing_resolver.py::_resolve_work_item_stakeholders가 합류시킨다 —
        # requested_by_member_id·gate_requester_member_id와 동형 3단 파이프, story #3340
        # 선례 그대로). _UNCONFIRMED 문자열 sentinel을 쓰지 않는다 — 이 필드는 사람이 읽는
        # 표시용이 아니라 프로그램이 소비하는 UUID라, 가짜 문자열이 섞이면 하류가 그걸
        # UUID로 파싱하려다 깨진다(다른 fact들과 다른 성격 — 값이 없으면 키 자체를 안 싣는다).
        if draft_author_id is not None:
            facts["draft_author_member_id"] = str(draft_author_id)

    return facts


async def maybe_create_stage_gate(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    definition,
    payload: dict,
    requester_member_id: uuid.UUID,
) -> None:
    """definition.stage_metadata[payload['stage']].gate 선언이 있으면 그 work item에
    pending 게이트를 멱등 생성한다(create_gate 자체가 (work_item_id, work_item_type,
    gate_type) 키로 멱등 — AC2가 이 재사용만으로 충족된다, 신규 멱등 로직 불요).

    stage/work_item 정보가 payload에 없거나, 그 stage에 gate 선언이 없으면 완전 no-op —
    선언 없는 정의(다른 레시피)의 stage 이벤트는 이 함수를 거쳐도 아무 부수효과가 없다
    (AC3 회귀 0).

    story #3325/#0e3abfaf(PO 확定, 2026-09-02, PR C) — create_gate 뒤 채팅 결재 카드까지
    이어 보낸다(결재함 탭에만 서고 채팅 알림이 0이던 결함). 범용 create_gate()/
    _reopen_rejected_gate()는 무변경 — 이 훅(caller) 쪽에서만 기존 게이트 status를
    호출 전에 먼저 조회해 세 갈래로 가른다:
      - 기존 없음(신규) 또는 rejected(→ create_gate가 _reopen_rejected_gate로 pending
        재오픈) → 카드 발송(best-effort, 실패해도 게이트 생성/재오픈 자체는 되돌리지
        않음 — create_gate의 gate.pending_approval 알림과 동일 관례).
      - voided(admin이 명시 무효화, #04e69c5f/#2150 AC5 — 자동 재오픈 대상 아님) →
        create_gate는 그대로 voided 반환(부수효과 0), 이 훅은 명시 로그만 남긴다
        ("왜 카드가 안 서는지"가 완전 침묵이던 것을 관측 가능하게).
      - 이미 pending(재발행 반복) → create_gate 그대로 멱등 반환, 카드 재발송 없음
        (같은 승인 요청을 반복 스팸하지 않는다)."""
    stage = payload.get("stage")
    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    if not stage or not work_item_type or not work_item_id_raw:
        return

    stage_meta = (definition.stage_metadata or {}).get(stage) or {}
    gate_decl = stage_meta.get("gate")
    if not gate_decl:
        return

    # story #4085 AC2 — 이 stage의 gate_decl["type"]이 봉인 필드를 요구하는데(_GATE_TYPE_
    # SEALED_FIELDS) payload에 없으면(또는 타입이 틀리면) 게이트를 아예 만들지 않고 여기서
    # 막는다 — 승인자 해소·neutral_facts 조립·budget 하드체크보다 먼저(부분 부수효과 0).
    # bool은 int의 서브클래스라 isinstance(v, int)만으로는 True/False가 새므로 명시 제외
    # (기존 estimated_cost_minor 봉인 코드의 동일 방어와 동형, 새 방어 0).
    _required_sealed_fields = _GATE_TYPE_SEALED_FIELDS.get(gate_decl["type"], ())
    _missing_sealed_fields = [
        f for f in _required_sealed_fields
        if not isinstance(payload.get(f), int) or isinstance(payload.get(f), bool)
    ]
    if _missing_sealed_fields:
        raise MissingGateSealedFieldError(gate_type=gate_decl["type"], missing_fields=_missing_sealed_fields)

    work_item_id = _parse_work_item_uuid(work_item_id_raw)
    if work_item_id is None:
        return

    resolver = _APPROVER_ROLE_RESOLVERS[gate_decl["approver"]]
    approver_id = await resolver(db, org_id=org_id)

    neutral_facts = await _build_approval_neutral_facts(
        db, org_id=org_id, definition=definition, stage=stage,
        work_item_type=work_item_type, work_item_id=work_item_id, payload=payload,
    )
    # story #3340(선생님 4바퀴 실사고) — 이 게이트를 만든 stage 이벤트의 발행자를 doc
    # 게이트와 동일 키(requested_by_member_id)로 기록한다. maybe_create_stage_gate는
    # requester_member_id를 이미 받고 있었지만(create_gate 호출에만 쓰였다) neutral_facts엔
    # 안 실려 "게이트 요청자"가 어디에도 안 남았다 — _publish_gate_verdict_notification이
    # 이 값을 읽어 반려/승인 통지 수신자에 합류시킨다(work_item 미배정 시 그 통지가
    # «시스템 발행 혼자 있는 방»에 갇히던 결함의 근본 처방).
    neutral_facts["requested_by_member_id"] = str(requester_member_id)
    # story #4058(②③ 정합, 페드루 PO 経由 유나 2026-09-19) — gates/[id]가 "이 stage
    # 산출물" evidence만 걸러 부르는 접점. 이 함수가 게이트 생성 시점에 이미 쥐고 있는
    # stage 값을 denorm으로 얹는다(새 컬럼 0, 기존 neutral_facts JSONB 관례 재사용) —
    # FE는 GET /api/v2/evidence?work_item_id=...로 받은 전체 목록을 payload.stage==
    # gate.neutral_facts.stage로 client-side 필터한다(evidence.py 쪽 새 쿼리 파라미터
    # 불요, 최소 침습 원칙 그대로).
    neutral_facts["stage"] = stage
    # story #4082([E-RECIPE-1] 진행 위치 표시) — stage 키만으론 사람이 못 읽는다(내부
    # slug). 같은 stage_meta에서 이미 role을 쥐고 있으니 같이 denorm — 결재함 카드/게이트
    # 상세가 별도 조회 없이 "단계(역할)" 1줄을 그린다. role 미선언(stage_meta에 role 키가
    # 없는 정의)이면 키 자체를 안 싣는다(디디 AC2 — 없는 값은 없다고, "" 폴백 금지).
    if stage_meta.get("role"):
        neutral_facts["stage_role"] = stage_meta["role"]

    # story #4044 — gate_type="generation_budget"은 create_gate() 호출 *전*에 하드체크한다
    # (channel_posts.py/site_posts.py의 submit-시점 422와 동일 판정 지점 — 반쪽 봉인 없이
    # 잔량 초과면 게이트 자체를 만들지 않는다). story #4085 — estimated_cost_minor는 위
    # _GATE_TYPE_SEALED_FIELDS 검사가 이미 필수로 강제해 이 시점엔 항상 유효한 int다(그
    # 검사를 통과 못 하면 이 줄까지 안 옴) — 아래 isinstance 가드는 그 사실을 다시 요구하지
    # 않고, 미래에 이 gate_type의 봉인 필드 집합이 늘어나 "일부만 필수"가 될 가능성에 대비한
    # 방어 그대로 남긴다(지금은 죽지 않는 코드). 통과분은 neutral_facts에 실어 결재 카드가
    # "편당 예상 비용"·잔여 예산을 실물로 보여준다(story #3312 처방 3, "가서 보라" 금지와
    # 동형).
    if gate_decl["type"] == _GENERATION_BUDGET_GATE_TYPE:
        estimated_cost_minor = payload.get("estimated_cost_minor")
        if isinstance(estimated_cost_minor, int) and not isinstance(estimated_cost_minor, bool):
            from app.services.generation_budget import (
                check_generation_budget_or_raise,
                compute_generation_budget_status,
            )

            await check_generation_budget_or_raise(db, org_id=org_id, estimated_cost_minor=estimated_cost_minor)
            neutral_facts["estimated_cost_minor"] = estimated_cost_minor
            budget_status = await compute_generation_budget_status(db, org_id=org_id)
            if budget_status is not None:
                neutral_facts["budget_limit_minor"] = budget_status["limit_minor"]
                neutral_facts["budget_spent_minor"] = budget_status["spent_minor"]
                neutral_facts["budget_remaining_minor"] = budget_status["remaining_minor"]
                # story #4072(카디르 QA③, 2026-09-19) — sealed_estimated_cost_minor를
                # FE가 라벨과 함께 보이려면 통화가 있어야 한다(org별 KRW|USD 정책,
                # content_rules.py::GenerationBudgetRule.currency). compute_generation_
                # budget_status가 이미 이 값을 돌려주는데 여기서 안 옮겨 담아 neutral_
                # facts에 currency 축 자체가 없었다 — "currency 지어내지 않는다" 원칙상
                # FE가 formatMinorCurrency를 못 쓰고 있었다(라벨 없는 맨 숫자).
                neutral_facts["currency"] = budget_status["currency"]

    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.services.gate_service import (
        create_gate,
        find_gate_slot_with_pr_fallback,
        resolve_work_item_project_id,
    )
    from app.services.workflow_line_config import _default_role_id

    gate_type = gate_decl["type"]

    # 카드 발송 여부 판단은 create_gate() 호출 *전* status로만 가능하다 — 호출 후에는
    # "신규 pending"과 "이미 pending이던 슬롯"이 똑같이 status=="pending"으로 구분이
    # 안 된다(post-call 값만으론 전이를 모른다).
    existing = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        gate_type=gate_type, pr_number=None, repo_full_name=None,
    )
    previous_status = existing.status if existing is not None else None

    role_id = await _default_role_id(db, org_id) or uuid.uuid4()
    gate = await create_gate(
        db, org_id, work_item_id, work_item_type, gate_type,
        requester_member_id, role_id,
        neutral_facts=neutral_facts,
        designated_approver_id=approver_id,
    )

    # story #3561(Phase2·BE, 페드루 PO 確定 2026-09-06) — gate_type=concept_approval
    # 선언은 `payload.doc_ref`(문자열 uuid, previous_output_doc_id와 동형 출처 관례)로
    # "무엇을 승인하는지"를 명시한다. create_gate()는 gate_type/work_item_type을 안 가려
    # sealed_doc_* 축을 모른다(공용 chokepoint 성격 유지) — 이 훅(호출부)에서만 채운다.
    # 못 찾으면(doc_ref 없음·해소 실패) 조용히 스킵(지어내지 않는다 — sealed_doc_id는
    # null로 남고, doc.py::_reseal_concept_approval_gate_on_doc_update가 애초에 그
    # 게이트를 못 찾아 재승인 훅이 무동작이 될 뿐, 게이트 생성 자체는 막지 않는다).
    # story #4044 — gate_type="generation_budget"의 sealed_estimated_cost_minor 봉인(0333
    # 컬럼 재사용, 신규 컬럼 0). concept_approval의 sealed_doc_* 봉인과 동일 자리·동일
    # 원칙(create_gate()는 gate_type을 안 가리는 공용 chokepoint라 이 훅에서만 채운다).
    if gate_type == _GENERATION_BUDGET_GATE_TYPE:
        estimated_cost_minor = payload.get("estimated_cost_minor")
        if isinstance(estimated_cost_minor, int) and not isinstance(estimated_cost_minor, bool):
            gate.sealed_estimated_cost_minor = estimated_cost_minor

    if gate_type == "concept_approval":
        doc_ref = await _resolve_doc_by_id(db, org_id=org_id, doc_id_raw=payload.get("doc_ref"))
        if doc_ref is not None:
            doc_id, _doc_title, doc_content, _created_by = doc_ref
            from app.services.doc import compute_doc_body_sha256
            gate.sealed_doc_id = doc_id
            gate.sealed_doc_body_sha256 = compute_doc_body_sha256(doc_content)

    if gate.status == "voided":
        logger.info(
            "recipe stage gate stays voided — admin 판단 필요(자동 재오픈 대상 아님) "
            "gate_id=%s org_id=%s work_item_type=%s work_item_id=%s stage=%s",
            gate.id, org_id, work_item_type, work_item_id, stage,
        )
        return

    if gate.status != "pending" or previous_status not in (None, "rejected"):
        return

    project_id = await resolve_work_item_project_id(db, org_id, work_item_type, work_item_id)
    try:
        await dispatch_approval_request_cards(
            db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
            project_id=project_id, title=neutral_facts["work_item_title"], gate_id=gate.id,
            gate_type=gate_type, requester_id=requester_member_id, approver_ids=[approver_id],
            designated_approver_id=approver_id,
        )
    except Exception:
        logger.warning(
            "recipe stage gate approval card dispatch failed gate_id=%s (best-effort, swallowed)",
            gate.id, exc_info=True,
        )

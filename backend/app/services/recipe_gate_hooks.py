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
import re
import uuid
from typing import NamedTuple

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.services.event_definition_registry import APPROVER_ROLE_REFERENCES
from app.services.reference_token import build_reference_token
from app.services.text_preview import strip_html_comments

logger = logging.getLogger(__name__)

# story #4135(게이트 카드 «확정 대상 실물» 그라운딩, PO 실측 2026-09-22) — gate_type →
# 그 게이트 직전 stage가 emit하는 evidence의 payload.kind(닫힌 집합, 크리에이터 에이전트
# stage 산출물 계약 v0.7 §3/§5가 SSOT — doc 3cca821b). `Evidence.ref`는 서버가 검증 안
# 하는 자유문자열이라 매칭 축 자격이 없다(그라운딩·PO 확定 2026-09-22 01:09Z) — `payload.
# kind`만 쓴다(evidence.py::_EVIDENCE_KIND_TYPE_REGISTRY가 실제로 강제하는 그 축).
# generation_budget(봉인 필드, _GATE_TYPE_SEALED_FIELDS)·external_publish(linked_channel_
# draft, gates.py)는 기존 메커니즘 그대로 — 이 레지스트리에 안 올린다(PO 확定).
_GATE_TYPE_EXPECTED_EVIDENCE_KINDS: dict[str, tuple[str, ...]] = {
    "concept_approval": ("concept_brief",),
    "structure_approval": ("animatic", "storyboard"),
}

# "entity:<type>:<uuid>" 형태(예: evidence.payload.doc="entity:doc:8341ad70-...", 라이브
# 실측 2026-09-22 gate 0a3dd999/evidence afcece95). reference_token.py::build_reference_token이
# 만드는 `[title](entity:type:id)`의 괄호 안쪽 원시형과 같은 문법이나, 여긴 title 없이 그
# 토큰 몸통만 온다(에이전트가 직접 채운 payload 자유필드 — 서버가 강제하는 계약이 아니다,
# v0.7 §6 오픈아이템). 형식이 어긋나면 조용히 None(지어내지 않는다 — 크래시도 추측도 금지).
_ENTITY_TOKEN_RE = re.compile(r"^entity:(\w+):([0-9a-fA-F-]{36})$")


async def resolve_stage_evidence_entries(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID, gate_type: str,
) -> list[dict]:
    """story #4135 — gate_type이 기대하는 evidence kind(위 레지스트리)에 해당하는 이
    work_item의 evidence 전부를 최신순으로 반환한다. `_build_approval_neutral_facts`
    (게이트 생성 시점, 최신 1건만 씀)와 `gates.py::_enrich_linked_evidence`(조회 시점마다
    전부 씀) 둘 다 이 함수를 공유 — kind 판정·doc/artifact 해소 로직을 두 곳에 안 둔다.

    gate_type이 레지스트리에 없으면(generation_budget·external_publish 등) 쿼리 자체를
    안 돈다(비용 0, `_enrich_linked_channel_draft`의 좁은 가드 선행과 동일 사상).

    각 항목: {id, kind, ref, entity_type, entity_id, title, summary}. entity_type이 doc/
    artifact 어느 쪽으로도 안 풀리면(payload.doc 형식 불일치·가리키는 doc/artifact가 이미
    없음 등) entity_type/entity_id/title은 전부 None — 그래도 항목 자체는 남긴다("이
    evidence가 존재는 하는데 무엇을 가리키는지 확認 불가"와 "이 evidence 자체가 없음"은
    다른 사실이므로 구분해서 보여준다, 지어내지 않되 침묵하지도 않는다)."""
    expected_kinds = _GATE_TYPE_EXPECTED_EVIDENCE_KINDS.get(gate_type)
    if not expected_kinds:
        return []

    from app.models.evidence import Evidence

    rows = (await db.execute(
        select(Evidence.id, Evidence.ref, Evidence.payload, Evidence.artifact_version_id, Evidence.note)
        .where(
            Evidence.org_id == org_id,
            Evidence.work_item_id == work_item_id,
            Evidence.work_item_type == work_item_type,
            Evidence.type == "report",
        )
        .order_by(Evidence.created_at.desc())
    )).all()

    entries: list[dict] = []
    for evidence_id, ref, payload, artifact_version_id, note in rows:
        kind = (payload or {}).get("kind")
        if kind not in expected_kinds:
            continue

        entity_type = entity_id = title = None
        doc_ref = (payload or {}).get("doc")
        if isinstance(doc_ref, str):
            m = _ENTITY_TOKEN_RE.match(doc_ref.strip())
            if m and m.group(1) == "doc":
                try:
                    candidate_id = uuid.UUID(m.group(2))
                except (ValueError, AttributeError, TypeError):
                    candidate_id = None
                if candidate_id is not None:
                    from app.models.doc import Doc

                    doc_title = (await db.execute(
                        select(Doc.title).where(Doc.id == candidate_id, Doc.org_id == org_id)
                    )).scalar_one_or_none()
                    if doc_title is not None:
                        entity_type, entity_id, title = "doc", candidate_id, doc_title

        if entity_type is None and artifact_version_id is not None:
            from app.models.visual_artifact import ArtifactVersion, VisualArtifact

            artifact_row = (await db.execute(
                select(VisualArtifact.id, VisualArtifact.title)
                .join(ArtifactVersion, ArtifactVersion.artifact_id == VisualArtifact.id)
                .where(ArtifactVersion.id == artifact_version_id, VisualArtifact.org_id == org_id)
            )).first()
            if artifact_row is not None:
                entity_type, entity_id, title = "artifact", artifact_row[0], artifact_row[1]

        entries.append({
            "id": evidence_id, "kind": kind, "ref": ref,
            "entity_type": entity_type, "entity_id": entity_id, "title": title,
            "summary": note,
        })
    return entries


def resolve_entity_token(raw: object, *, expect_type: str) -> uuid.UUID | None:
    """story #4141 — `payload.doc`류 원시 필드("entity:doc:uuid")를 `_ENTITY_TOKEN_RE`로
    파싱해 `expect_type`과 일치할 때만 UUID를 돌려준다. `resolve_stage_evidence_entries`
    (위 88-104행)가 인라인으로 하던 파싱을 재사용 가능한 조각으로 뺀 것 — evidence
    write-path(#4141 entity_references 기록)가 같은 파싱을 여기서 다시 짜지 않는다(파서
    2곳 소유=twin-system 갭, 이 파일 자체가 이미 여러 번 겪은 그 클래스). 형식이 안 맞거나
    (raw가 str이 아님·정규식 미매치·type 불일치·UUID 형식 아님) 전부 None(지어내지 않는다)."""
    if not isinstance(raw, str):
        return None
    m = _ENTITY_TOKEN_RE.match(raw.strip())
    if not m or m.group(1) != expect_type:
        return None
    try:
        return uuid.UUID(m.group(2))
    except (ValueError, AttributeError, TypeError):
        return None


async def resolve_pinned_gate_ids_for_evidence_kind(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID, kind: str,
) -> list[uuid.UUID]:
    """story #4141 — evidence write-path(entity_references «게이트 핀» 기록) 전용 역방향
    조회: 이 `kind`를 기대하는 gate_type(들)(`_GATE_TYPE_EXPECTED_EVIDENCE_KINDS`, 위
    36-39행 — #4135와 완전히 같은 표를 이 모듈에서 그대로 재사용, 표를 둘로 안 늘린다)이
    이 work_item에 실제로 연 게이트 id를 전부 돌려준다(상태 무관 — pending/approved 어느
    쪽이든 "이 게이트가 이 산출물을 기대한다"는 사실 자체는 변하지 않는다). kind가 어느
    gate_type의 기대 목록에도 없으면(generation_cost·verification_sheet 등) 빈 리스트
    (쿼리 자체를 안 돈다 — `resolve_stage_evidence_entries`의 좁은 가드와 동일 사상)."""
    matching_gate_types = [
        gt for gt, kinds in _GATE_TYPE_EXPECTED_EVIDENCE_KINDS.items() if kind in kinds
    ]
    if not matching_gate_types:
        return []

    from app.models.gate import Gate

    rows = (await db.execute(
        select(Gate.id).where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id,
            Gate.work_item_type == work_item_type, Gate.gate_type.in_(matching_gate_types),
        )
    )).scalars().all()
    return list(rows)

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


class SealedFieldSpec(NamedTuple):
    """story #4085 AC1 — 자기설명 렌더러(events.py)가 발행 예시 payload에 이 필드를
    실값 예시로 채우고(`example_value`), 그 바로 아래 "이 값이 왜 필요한지" 한 줄
    (`explanation_catalog_key`, i18n_catalog `events.*` 키)을 붙이는 데 쓰는 메타데이터.

    ⚠️story #4085 PO 리뷰 정정(PR 코멘트 5755879285) — `min_value`(기본 0) 없이는 음수
    (예: -1)가 isinstance(int) 검사만 통과해 음수 예상 비용이 그대로 봉인될 수 있었다.
    검증(AC2)은 `name`·`min_value` 둘 다 본다 — example_value/explanation은 렌더링
    전용, 검증 로직과 분리해 렌더러가 죽어도 검증은 안 죽는다(반대도 마찬가지)."""

    name: str
    example_value: int
    explanation_catalog_key: str
    min_value: int = 0


# story #4085(리허설 1호 실측, PO 확定 2026-09-21) — gate_type별 "이 게이트가 봉인에 쓰는
# payload 필드"의 단일 SSOT. 실사고: generation_budget 게이트가 estimated_cost_minor
# 없이 열려(사전 하드체크는 "미설정이면 통과"가 맞는 규약 — #4044) 결재 카드에 예상 비용이
# 0/null로 비어 있었다. 레시피 키·stage 하드코딩 없이 gate_type 하나로만 갈라 다음 레시피
# 에도 그대로 적용된다(새 gate_type이 봉인 필드를 쓰려면 여기 한 줄만 추가). events.py의
# 자기설명 렌더러(story #4085 AC1)도 이 SSOT를 그대로 읽어 예시 payload에 실을 필드
# 목록·예시값·설명 문구를 구성한다 — 새 목록 발명 0.
_GATE_TYPE_SEALED_FIELDS: dict[str, tuple[SealedFieldSpec, ...]] = {
    _GENERATION_BUDGET_GATE_TYPE: (
        SealedFieldSpec(
            name="estimated_cost_minor", example_value=10_000,
            explanation_catalog_key="events.sealed_field_estimated_cost_minor",
        ),
    ),
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
    """story #4083(E-RECIPE-1, PO 확定 2026-09-21) — org가 `OrgGatePolicy.recipe_gate_
    default_approver_member_id`를 설정해 뒀으면 그 멤버를 우선한다(merge_gate_default_
    approver_member_id·merge_verdict_gate.py:527-533와 동일 패턴 — "org_owner 하드코딩"
    실사고: 뭉클랩 org owner=선생님·마케팅 담당(sellerking)=admin이라 사람 게이트 4개가
    전부 선생님 결재함으로 가고 admin은 #3319 rule B로 403이었다). 미설정(기본값)이면
    기존 org owner 조회 그대로(회귀 0) — 이 함수 이름·역할참조 키("org_owner")는 안
    바꾼다(APPROVER_ROLE_REFERENCES 재등록 불요, dispatch 자리 그대로)."""
    from app.models.hitl_config import OrgGatePolicy

    policy_member_id = (await db.execute(
        select(OrgGatePolicy.recipe_gate_default_approver_member_id)
        .where(OrgGatePolicy.org_id == org_id)
    )).scalar_one_or_none()
    if policy_member_id is not None:
        return policy_member_id

    member_id = (await db.execute(
        select(OrgMember.id)
        .where(OrgMember.org_id == org_id, OrgMember.role == "owner", OrgMember.deleted_at.is_(None))
        .order_by(OrgMember.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()
    if member_id is None:
        raise UnknownApproverRoleError(f"org {org_id}에 role=owner인 org_member가 없습니다.")

    # story #4153(2026-09-22, 페드루 PO 確定) — members.id == org_member.id는 "0075
    # 불변식"(agent_anchor_sync.py::ensure_human_member)이지만, 이 함수가 그 앵커
    # INSERT가 실제로 일어났음을 보장하진 않는다(정상 생성경로는 #3635가 세운 choke
    # point — org_member.py::OrgMemberRepository.create — 가 전수 커버하지만, 그
    # choke point를 안 거치는 손시드(테스트)·미지의 경로가 건너뛸 수 있다). 반환 前
    # 멱등 앵커를 방어적으로 보장한다(기존 정본 함수 재사용, 새 메커니즘 0) — 승인
    # 요청 카드가 `conversation_participants` FK 위반으로 조용히 안 가던 결함 클래스의
    # 근본 처방(approval_delivery.py의 WARNING 삼킴과는 별개 축). 앵커 보장이 그래도
    # 실패하면(orphan org/user, 극히 드묾) 조용히 그 id를 반환하지 않고 loud(기존
    # UnknownApproverRoleError 계열 그대로 — 카드가 못 갈 승인자를 지정하는 것보다
    # 발행 자체를 막는 게 정직하다).
    from app.services.agent_anchor_sync import ensure_human_member

    if not await ensure_human_member(db, member_id):
        # story #3779 — 이 예외는 사람 표면이 아니라 발행 API를 부른 에이전트에게 닿는
        # 내부 진단 문자열이라(events.py의 try/except 밖, loud) 영문으로 둔다(#4147
        # CHANGES-2와 동형 — human_error()/한글 축 대상이 아닌 raw exception 문구).
        raise UnknownApproverRoleError(
            f"failed to guarantee members anchor for org {org_id} owner "
            f"org_member={member_id} (orphan org/user) — blocking publish instead of "
            "silently dropping the approval card"
        )
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
    db: AsyncSession, *, org_id: uuid.UUID, definition, stage: str, gate_type: str, work_item_type: str,
    work_item_id: uuid.UUID, payload: dict,
) -> dict:
    """PO 변경요청①(페드루, 2026-09-02) — 결재함 카드가 승인자에게 «무엇을 승인하는지»를
    실물로 보여줘야 한다(story 처방 3, "가서 보라" 금지). work item 제목+참조 토큰·payload
    채널·그 work item에 링크된 최신 산출물(doc 또는 artifact) 참조+요약을 채운다 — 못 찾은
    값은 _UNCONFIRMED로 명시(침묵도 지어냄도 아님).

    story #4135(PO 실측 2026-09-22) — draft doc 해소는 이제 3경로 우선순위다: ①payload.
    previous_output_doc_id(발행자가 이번 stage의 산출물을 직접 지목 — 가장 정확) ②그
    gate_type이 기대하는 evidence(resolve_stage_evidence_entries, payload.kind SSOT — v0.7
    §3/§5) 중 최신 1건이 doc/artifact를 가리키면 그 참조 ③entity_references 최신 링크
    (#3312 원래 경로, work item↔doc이 나중에 링크되는 경우) ④미확認(셋 다 없음, 지어내지
    않음). ②가 신설되기 前엔 evidence 테이블 자체를 이 함수가 한 번도 안 읽어(그라운딩
    확認, recipe_gate_hooks.py 268-279행 구판) 댄이 concept_brief evidence를 먼저 등재해도
    게이트가 그 실물을 못 실었다(2호 게이트 1 실사고, 2026-09-22 00:33~00:42Z) — 이게 그
    근본 처방. ②의 evidence가 "최신"이어도 doc/artifact 어느 쪽으로도 안 풀리면(형식 불일치
    등) 그 자리에서 포기하고 ③으로 넘어간다 — 더 오래된 evidence를 거슬러 찾지 않는다
    ("최신 1건" 계약, PO 확定)."""
    facts: dict = {"triggered_by_event": definition.key, "stage": stage}

    title = await _work_item_title(db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id)
    facts["work_item_title"] = title or _UNCONFIRMED
    facts["work_item_reference_token"] = (
        (build_reference_token(work_item_type, work_item_id, title) if title else None) or _UNCONFIRMED
    )

    channel = payload.get("channel")
    facts["channel"] = channel if isinstance(channel, str) and channel else _UNCONFIRMED

    draft = await _resolve_doc_by_id(db, org_id=org_id, doc_id_raw=payload.get("previous_output_doc_id"))
    evidence_match: dict | None = None
    if draft is None:
        entries = await resolve_stage_evidence_entries(
            db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id, gate_type=gate_type,
        )
        if entries and entries[0]["entity_type"] is not None:
            evidence_match = entries[0]
        else:
            draft = await _latest_linked_draft_doc(
                db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
            )

    if evidence_match is not None:
        facts["draft_doc_reference_token"] = (
            build_reference_token(evidence_match["entity_type"], evidence_match["entity_id"], evidence_match["title"])
            or _UNCONFIRMED
        )
        facts["draft_doc_summary"] = evidence_match["summary"] or _UNCONFIRMED
    elif draft is None:
        facts["draft_doc_reference_token"] = _UNCONFIRMED
        facts["draft_doc_summary"] = _UNCONFIRMED
    else:
        doc_id, doc_title, doc_content, draft_author_id = draft
        facts["draft_doc_reference_token"] = build_reference_token("doc", doc_id, doc_title) or _UNCONFIRMED
        facts["draft_doc_summary"] = strip_html_comments(doc_content)[:300] or _UNCONFIRMED
        # story #3370(Phase0·마케팅운영 S5) AC1 — 초안 원작성자(대개 담롱류 고객 에이전트)를
        # 판정 통지 수신자 집합에 합류시킨다(gate_service.py::_publish_gate_verdict_
        # notification이 이 키를 읽어 payload.gate_draft_author_member_id로 싣고,
        # event_routing_resolver.py::_resolve_work_item_stakeholders가 합류시킨다 —
        # requested_by_member_id·gate_requester_member_id와 동형 3단 파이프, story #3340
        # 선례 그대로). _UNCONFIRMED 문자열 sentinel을 쓰지 않는다 — 이 필드는 사람이 읽는
        # 표시용이 아니라 프로그램이 소비하는 UUID라, 가짜 문자열이 섞이면 하류가 그걸
        # UUID로 파싱하려다 깨진다(다른 fact들과 다른 성격 — 값이 없으면 키 자체를 안 싣는다).
        # story #4135: evidence_match 경로는 이 필드를 안 채운다 — Evidence.created_by는
        # doc의 created_by와 다른 축(누가 산출물을 만들었나 vs 누가 evidence를 등재했나)이라
        # 새 필드를 여기서 발명하지 않는다(PO 확定 범위 밖, 필요해지면 별도 카드).
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
    # SEALED_FIELDS) payload에 없거나·타입이 틀리거나·min_value 미만이면 게이트를 아예
    # 만들지 않고 여기서 막는다 — 승인자 해소·neutral_facts 조립·budget 하드체크보다
    # 먼저(부분 부수효과 0). bool은 int의 서브클래스라 isinstance(v, int)만으로는 True/
    # False가 새므로 명시 제외(기존 estimated_cost_minor 봉인 코드의 동일 방어와 동형).
    # ⚠️PO 리뷰 정정(PR 코멘트 5755879285) — min_value 검사가 없으면 음수(-1)가 위 두
    # 조건만으로는 걸러지지 않아 음수 예상 비용이 그대로 봉인될 수 있었다.
    _required_sealed_fields = _GATE_TYPE_SEALED_FIELDS.get(gate_decl["type"], ())
    _missing_sealed_fields = [
        spec.name for spec in _required_sealed_fields
        if not isinstance(payload.get(spec.name), int)
        or isinstance(payload.get(spec.name), bool)
        or payload.get(spec.name) < spec.min_value
    ]
    if _missing_sealed_fields:
        raise MissingGateSealedFieldError(gate_type=gate_decl["type"], missing_fields=_missing_sealed_fields)

    work_item_id = _parse_work_item_uuid(work_item_id_raw)
    if work_item_id is None:
        return

    resolver = _APPROVER_ROLE_RESOLVERS[gate_decl["approver"]]
    approver_id = await resolver(db, org_id=org_id)

    neutral_facts = await _build_approval_neutral_facts(
        db, org_id=org_id, definition=definition, stage=stage, gate_type=gate_decl["type"],
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

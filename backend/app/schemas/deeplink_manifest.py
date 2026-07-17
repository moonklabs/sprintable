"""story #1951 (E-MOBILE P1a-S1): 딥링크 계약 매니페스트 v1 — DRAFT.

⚠️ 이 파일은 3자 검토(디디 BE 초안 → 유나 FE 착지화면 요건 오너 + 미르코 FE 소비 오너) 전
초안이다. 승인 전에는 CI에 정식 편입하지 않는다(fixture는 로컬 실행 검증까지만 — story
#1951 스코프). 승인 후 실제 편입은 story #1952(P1a-S2 FE·BE 딥링크 계약 CI)에서 다룬다.

## 배경

서버가 발송하는 모바일 알림(push/in-app)이 앱 내 어느 화면(딥링크)으로 착지해야 하는지에 대한
단일 계약(SSOT)이 지금까지 없었다. `dispatch_notification()`
(app/services/notification_dispatch.py)가 human/agent 멤버에게 나가는 모든 알림
(in-app Notification·Event·개인 webhook·EE Expo push)의 **유일한 choke point**라는 게
전수 조사로 확인됐다(다른 경로에서 `Notification(...)` 을 직접 INSERT하는 곳은 없음 —
`grep -rl "Notification(" backend/app` 결과 `models/notification.py`(정의)와
`services/notification_dispatch.py`(유일한 사용처) 뿐).

Expo push data payload(`ee/services/expo_push.py:deliver_expo_push`)는 다음 필드만 담는다:
    {"event_type": str, "reference_type": str | None, "reference_id": str | None}
→ 클라이언트가 딥링크를 결정할 수 있는 **유일한 실제 재료**가 이 세 필드다. 이 매니페스트의
`type`/`entity_type` 룩업 키는 이 payload 필드와 정확히 대응하도록 설계했다(아래 "룩업 알고리즘"
참고).

## 3-레이어 필드 분리 (AC3)

Layer 1 (앱 SSOT) — 클라이언트가 딥링크 라우팅에만 쓰는 필드. FE 빌드에 박히는 지식.
    type, entity_type, target, parentTab, returnPolicy

Layer 2 (BE payload 계약) — 서버가 실제로 push data에 담는 것에 대한 계약(어떤 필드가 항상
있는지, 어떤 필드가 이 타입에 한해 필수인지). BE가 이 계약을 어기면 fixture가 fail-closed.
    org_id_included, project_id_included, requiredPayload

Layer 3 (채널 등급) — story #1956이 실제 channelId 매핑(A1=intervention-urgent·
A2=intervention·B=info)을 담당한다. 이 스토리는 필드만 예약(스텁)한다 — 매핑 값 자체는
#1956 없이는 "unassigned"로 둔다. 지금 채널 값은 전부 "default"(EE expo_push.py 참고 —
아직 하드코딩된 "default" 하나뿐).
    channel_grade

세 레이어를 하나의 flat dict가 아니라 명시적으로 분리된 sub-model 3개로 표현한 이유는
"필드가 섞이지 않고 명확히 분리돼야 한다"(AC3)를 타입 레벨에서 강제하기 위함이다 — 이후
스토리(S2 FE·BE CI, S6 channelId)가 각자 레이어만 건드리면 되고 실수로 다른 레이어 필드를
같이 바꾸는 걸 코드 리뷰에서 더 쉽게 잡을 수 있다. **열린 질문 1번**(하단) 참고 — PO가
AC 문구 그대로 flat 7필드를 원했다면 조정 필요.

## 룩업 알고리즘 (제안 — 열린 질문 2번)

`event_type` 리터럴 24종 중 4종(`dispatched`·`comment.created`·`handoff_stuck`·
`handoff_fallback`)은 **동일 event_type 값이 서로 다른 target을 가리킨다** — 실제 목적지가
`reference_type`(push data payload에 이미 실려 있음)에 의존하기 때문이다. 예:
`dispatched`는 epic/story/doc/hypothesis/sprint 5종 엔티티 아무거나에 대해 발화되고,
5종 모두 다른 화면으로 가야 한다.

이 문제를 "type 문자열을 클라이언트가 concat"(`f"{event_type}.{reference_type}"`)하는
방식 대신, **매니페스트 엔트리에 `entity_type: str | None` 필드를 별도로 둬서 튜플
`(type, entity_type)`로 룩업**하는 방식을 택했다 — payload를 그대로 조회 키로 쓸 수 있어
클라이언트 쪽 문자열 조립 로직/오타 여지가 없다. entity_type=None인 엔트리는 해당
event_type이 어차피 단일 reference_type만 발화한다는 뜻(예: `gate.pending_approval`은
항상 reference_type="gate")이라 두 번째 키가 필요 없다.

룩업 순서: ①`(payload.event_type, payload.reference_type)` 정확매치 시도 → ②없으면
`(payload.event_type, None)` 매치 시도(entity_type 무관 단일 타겟 엔트리) → ③그래도
없으면 미등재 → AC4 안전 폴백(`지금` 탭).

## 버전 정책

`MANIFEST_SCHEMA_VERSION`(현재 1)은 **엔트리 개별이 아니라 매니페스트 전체**에 붙는다.
- **PATCH 없음**(schema_version 유지): 신규 엔트리 추가, 기존 엔트리의 `title/body` 류
  설명 문구 변경. 구버전 앱은 신규 타입을 어차피 모르므로 AC4 폴백(`지금`)으로 안전하게
  처리된다 — 하위호환 additive.
- **MAJOR bump 필요**(schema_version += 1): Layer 1 필드의 이름/의미 변경(`target` 값
  체계 변경, `parentTab` enum 값 rename/삭제, `returnPolicy` 의미 변경), 또는 기존
  엔트리의 `target`이 가리키는 실제 화면이 바뀌어 구버전 앱이 잘못된 화면으로 착지하게
  되는 경우. 구버전 앱이 신버전 schema_version을 만나면 자신이 아는 schema_version보다
  높은 매니페스트는 무시하고 AC4 폴백으로 떨어지는 것을 앱 쪽(P1b, 이 스토리 스코프 밖)이
  구현해야 한다 — **열린 질문 3번**.
- 이 매니페스트 자체(`DEEPLINK_MANIFEST` 리스트)는 BE 코드 배포 즉시 바뀐다. 앱은 매
  콜드스타트/포그라운드 복귀 시 최신 매니페스트를 받아와야 신규 타입을 안다는 전제
  — 이 조회 API(예: `GET /api/v1/deeplink-manifest`)는 **story #1951 스코프 밖**(S2가
  CI 대조만 다루고, 별도 서빙 엔드포인트가 필요하면 S2~S6 중 어디서 다룰지 불명확 —
  **열린 질문 4번**).
"""
from __future__ import annotations

import uuid
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

MANIFEST_SCHEMA_VERSION = 1


class ParentTab(str, Enum):
    """P2-S2 모바일 4탭 셸의 탭 4종. P1a-S1은 이 enum만 정의 — 실제 셸 구현은 P2-S2."""

    now = "now"  # 지금 (P2-S8 홈) — AC4 안전 폴백 대상이기도 함
    approvals = "approvals"  # 결재함 (P2-S4 통합 큐)
    chat = "chat"  # 채팅
    all = "all"  # 전체


class ReturnPolicy(str, Enum):
    """딥링크 진입 후 BACK 동작 정책(P2-S3 합성 history와 연동)."""

    # 정상 등재 타입: parentTab 루트를 history에 먼저 심고 target으로 push한다
    # (P2-S3 AC "직접 상세 진입 시 parentTab 루트 엔트리 선존재").
    synthesize_parent = "synthesize_parent"
    # 미등재 타입/필수 필드 누락 등 검증 실패 시: target 자체를 포기하고 `지금` 탭으로
    # 안전 폴백한다(AC4). 매니페스트에 이 값을 가진 엔트리는 없다 — validate 실패 시
    # 클라이언트가 자체적으로 이 정책을 적용한다는 뜻의 상수로만 존재.
    fallback_now = "fallback_now"


class ChannelGrade(str, Enum):
    """Layer 3 스텁 — story #1956이 실제 매핑을 확정한다. 지금은 전부 unassigned
    (EE expo_push.py의 channelId는 현재 하드코딩 "default" 하나뿐 — 3등급 분화 없음)."""

    a1 = "A1"  # intervention-urgent (안 열면 손실/블로킹 — 예: SLA 만료 임박 게이트)
    a2 = "A2"  # intervention (액션 필요하지만 긴급 아님)
    b = "B"  # info (읽기 전용 FYI)
    unassigned = "unassigned"  # #1956 완료 전 기본값


class DeepLinkAppFields(BaseModel):
    """Layer 1 — 앱 SSOT. 클라이언트가 이 필드들만으로 딥링크 라우팅을 결정한다."""

    model_config = ConfigDict(frozen=True)

    type: str = Field(description="push data.event_type 원문 리터럴")
    entity_type: str | None = Field(
        default=None,
        description=(
            "push data.reference_type 매치용 2차 키. None이면 이 event_type은 항상 "
            "단일 target(reference_type 무관)이라 무시된다."
        ),
    )
    target: str = Field(
        description=(
            "논리적 화면 식별자(실제 URL 아님 — 라우트는 P1a-S3~S5/P2-S* 별도 스토리가 "
            "짓는다). FE가 이 키로 실제 컴포넌트/라우트에 매핑."
        )
    )
    parent_tab: ParentTab
    return_policy: ReturnPolicy = ReturnPolicy.synthesize_parent


class DeepLinkPayloadFields(BaseModel):
    """Layer 2 — BE payload 계약. fixture가 이 필드로 fail-closed 검증을 한다."""

    model_config = ConfigDict(frozen=True)

    org_id_included: bool = Field(
        default=False,
        description=(
            "push data payload에 org_id가 포함되는가. 현재 deliver_expo_push()는 "
            "data payload에 org_id를 넣지 않는다(코드 실측: event_type/reference_type/"
            "reference_id 셋뿐) — 이 필드가 org_id 전부 False인 이유. AC 스코프 필드명 "
            "그대로 유지하되 '항상 False'라는 사실 자체가 열린 질문 5번(org_id/project_id "
            "가 실제로 필요하면 BE가 아직 안 보내고 있다는 뜻)."
        ),
    )
    project_id_included: bool = Field(default=False)
    required_payload: list[str] = Field(
        default_factory=list,
        description=(
            "data payload에 반드시 있어야 하는 키 이름(event_type 제외 — 그건 항상 "
            "있다고 전제). reference_id를 요구하면 필수, target 해석에 reference_id가 "
            "필요 없는 타입(예: agent_joined처럼 항상 team_member 화면으로 가지만 특정 "
            "id 없이도 목록으로 폴백 가능한 케이스는 없음 — 이 초안에선 reference_type이 "
            "있는 모든 타입이 reference_id도 요구)."
        ),
    )


class DeepLinkChannelFields(BaseModel):
    """Layer 3 — 채널 등급 스텁. story #1956 완료 전까지 전부 unassigned."""

    model_config = ConfigDict(frozen=True)

    channel_grade: ChannelGrade = ChannelGrade.unassigned


class DeepLinkManifestEntry(BaseModel):
    """매니페스트 1행 = 알림 타입 1종(또는 타입+entity_type 조합) → 착지 계약."""

    model_config = ConfigDict(frozen=True)

    app: DeepLinkAppFields
    payload: DeepLinkPayloadFields
    channel: DeepLinkChannelFields = DeepLinkChannelFields()

    @property
    def lookup_key(self) -> tuple[str, str | None]:
        return (self.app.type, self.app.entity_type)


class DeepLinkManifest(BaseModel):
    """매니페스트 전체 = schema_version + 엔트리 목록."""

    schema_version: int = MANIFEST_SCHEMA_VERSION
    entries: list[DeepLinkManifestEntry]

    @model_validator(mode="after")
    def _no_duplicate_keys(self) -> "DeepLinkManifest":
        seen: set[tuple[str, str | None]] = set()
        for e in self.entries:
            k = e.lookup_key
            if k in seen:
                raise ValueError(f"duplicate manifest lookup_key: {k}")
            seen.add(k)
        return self

    def find(self, event_type: str, reference_type: str | None) -> DeepLinkManifestEntry | None:
        """룩업 알고리즘: ①(event_type,reference_type) 정확매치 → ②(event_type,None) →
        ③None(미등재 — 호출자가 AC4 안전 폴백 처리)."""
        by_key = {e.lookup_key: e for e in self.entries}
        return by_key.get((event_type, reference_type)) or by_key.get((event_type, None))


class UnregisteredDeepLinkTypeError(ValueError):
    """AC2/AC4: 매니페스트에 없는 (event_type, reference_type) 조합. 호출자는 이 예외를
    잡아 `지금` 탭(ParentTab.now/ReturnPolicy.fallback_now)으로 폴백해야 한다."""

    def __init__(self, event_type: str, reference_type: str | None) -> None:
        self.event_type = event_type
        self.reference_type = reference_type
        super().__init__(
            f"unregistered deeplink type: event_type={event_type!r} reference_type={reference_type!r}"
        )


class MissingRequiredDeepLinkPayloadError(ValueError):
    """AC2: 등재된 타입이지만 requiredPayload에 명시된 필드가 payload에서 빠짐."""

    def __init__(self, event_type: str, missing: list[str]) -> None:
        self.event_type = event_type
        self.missing = missing
        super().__init__(f"missing required payload field(s) for {event_type!r}: {missing}")


def validate_push_payload(
    manifest: DeepLinkManifest, data: dict
) -> DeepLinkManifestEntry:
    """fixture/CI가 쓸 fail-closed 검증 함수 (draft — story #1952가 CI 편입 시 재사용/이관).

    data: EE expo_push.py deliver_expo_push()가 만드는 data payload 형태
        {"event_type": str, "reference_type": str|None, "reference_id": str|None, ...}

    등재 안 된 (event_type,reference_type) → UnregisteredDeepLinkTypeError.
    required_payload 필드 누락 → MissingRequiredDeepLinkPayloadError.
    둘 다 통과 시 매치된 DeepLinkManifestEntry 반환.
    """
    event_type = data.get("event_type")
    if not event_type:
        raise UnregisteredDeepLinkTypeError(event_type="", reference_type=data.get("reference_type"))
    reference_type = data.get("reference_type")

    entry = manifest.find(event_type, reference_type)
    if entry is None:
        raise UnregisteredDeepLinkTypeError(event_type, reference_type)

    missing = [f for f in entry.payload.required_payload if not data.get(f)]
    if missing:
        raise MissingRequiredDeepLinkPayloadError(event_type, missing)

    return entry


# ============================================================================
# SSOT 레지스트리 — story #1951 GATE 1 전수 조사 결과.
#
# 출처: `grep -rn "dispatch_notification(" backend/app backend/ee --include="*.py"`
# (2026-07-17, feat/1951-deeplink-manifest 워크트리 @ origin/develop 71b528f6 기준) —
# `app/services/notification_dispatch.py:dispatch_notification()`가 in-app
# Notification·agent Event·개인 webhook·EE Expo push **전부의 유일한 choke point**임을
# `grep -rl "Notification(" backend/app` (models/notification.py 정의 + 이 파일 유일
# 사용처)로 재확인. 이 함수에 전달되는 event_type 리터럴만이 실제로 인간 멤버에게
# push/in-app 알림으로 나가는 타입이다(webhook-only 이벤트인 story.assignee_changed·
# epic.reordered·message.created(workflow trigger)·conversation.message_created
# (CC 웹훅 릴레이)·a2a.task_message 등은 다른 채널(외부 시스템/에이전트 SSE)로만 가고
# dispatch_notification을 타지 않으므로 이 매니페스트 스코프 밖 — 상세는 최종 보고
# "알림 타입 전수 조사" 표 참고).
# ============================================================================

DEEPLINK_MANIFEST = DeepLinkManifest(
    entries=[
        # --- 결재함(gate) 계열: reference_type 항상 "gate" → 단일 canonical 상세(P1a-S4) ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="gate.pending_approval", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="gate_approval_requested", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a2),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="gate_reassigned", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a2),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="gate_escalated", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="gate_reminder", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a2),
        ),
        DeepLinkManifestEntry(
            # FYI: 강제결정 통보 — 액션 불필요(이미 확정됨). approvals 탭에 남기되
            # returnPolicy는 동일(synthesize_parent). 열린 질문 6번: 지금 탭이 더 맞지 않나.
            app=DeepLinkAppFields(
                type="gate_overridden", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),
        DeepLinkManifestEntry(
            # doc 결재도 gate 경유(reference_type="gate") — doc_approval_requested는
            # doc.py가 gate_id를 reference_id로 넘긴다(문서 자체 id 아님).
            app=DeepLinkAppFields(
                type="doc_approval_requested", target="gate_detail", parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a2),
        ),

        # --- dispatched(범용) — reference_type 5종 분기. entity_type 필수. ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="dispatched", entity_type="story", target="story_detail", parent_tab=ParentTab.now,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="dispatched", entity_type="epic", target="goal_detail", parent_tab=ParentTab.now,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="dispatched", entity_type="doc", target="doc_detail", parent_tab=ParentTab.now,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),
        DeepLinkManifestEntry(
            # 열린 질문 7번: hypothesis 독립 상세 라우트가 아직 없다(story #1634 backlog).
            # target="hypothesis_detail"은 아직 짓지 않은 화면을 가리킨다 — FE가 P1a-S3
            # 전까지 이 target을 안전 폴백(지금)으로 취급해야 함(매니페스트 등재는 됐지만
            # 실제 라우트 미존재 = 별개 리스크. AC2 CI(S2)가 "target이 미존재 웹 라우트면
            # 실패" 조건과 바로 충돌하는 사례이기도 함).
            app=DeepLinkAppFields(
                type="dispatched", entity_type="hypothesis", target="hypothesis_detail",
                parent_tab=ParentTab.now,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="dispatched", entity_type="sprint", target="sprint_detail", parent_tab=ParentTab.now,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),

        # --- story 계열 ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="story_assigned", target="story_detail", parent_tab=ParentTab.now,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a2),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="story_status_changed", target="story_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="comment.created", entity_type="story", target="story_detail",
                parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),

        # --- task — 열린 질문 8번: task_completed payload에 story_id가 없다(reference_type=
        # "task"·reference_id=task.id뿐). "story_detail" target을 쓰려면 FE가 task_id→
        # story_id를 별도 API로 풀어야 한다 — 전용 task 상세 화면이 없다면 이 자체가 BE
        # payload 확장(story_id 추가) 필요 사항일 수 있다. ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="task_completed", target="task_detail_or_story_fallback", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),

        # --- visual artifact 계열 ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="comment.created", entity_type="visual_artifact", target="artifact_detail",
                parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="artifact.created", target="artifact_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="artifact.exported", target="artifact_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="artifact.updated", target="artifact_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="artifact.canonicalized", target="artifact_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),

        # --- 채팅 ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="conversation.mention", target="chat_thread", parent_tab=ParentTab.chat,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a2),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="conversation.message", target="chat_thread", parent_tab=ParentTab.chat,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),

        # --- goal(epic) ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="epic_created", target="goal_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="epic_status_changed", target="goal_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),

        # --- sprint ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="sprint_closed", target="sprint_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),

        # --- team_member (org 운영) ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="agent_joined", target="team_member_detail", parent_tab=ParentTab.all,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.b),
        ),

        # --- handoff — reference_type 동적(sr.entity_type). handoff_fallback은 코드상
        # reference_type이 "story"로 하드코딩(workflow_fallback_notify.py:69)이라 단일
        # 엔트리. handoff_stuck은 워크플로 엔진의 엔티티 5종(READINESS_MATRIX와 동일 도메인:
        # story/epic/doc/hypothesis/sprint) 아무거나에서 발생할 수 있어 dispatched와 동형
        # 처리 — 열린 질문 9번: 실제로 story 외 엔티티에서 handoff_stuck이 발생한 라이브
        # 사례가 있는지 확인 필요(코드상 가능성은 있으나 이 초안은 5종 전부 등재해 fail-closed
        # 쪽으로 보수적으로 잡음). ---
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="handoff_stuck", entity_type="story", target="story_detail",
                parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="handoff_stuck", entity_type="epic", target="goal_detail",
                parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="handoff_stuck", entity_type="doc", target="doc_detail",
                parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="handoff_stuck", entity_type="hypothesis", target="hypothesis_detail",
                parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="handoff_stuck", entity_type="sprint", target="sprint_detail",
                parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
        DeepLinkManifestEntry(
            app=DeepLinkAppFields(
                type="handoff_fallback", entity_type="story", target="story_detail",
                parent_tab=ParentTab.approvals,
            ),
            payload=DeepLinkPayloadFields(required_payload=["reference_id"]),
            channel=DeepLinkChannelFields(channel_grade=ChannelGrade.a1),
        ),
    ],
)


# 미등재(폴백) fixture용 — 매니페스트에 절대 등재되면 안 되는 예시 타입(테스트 전용 상수).
_UNREGISTERED_EXAMPLE_EVENT_TYPE = "legacy_memo_reply"  # story 91(/memos) 폐기 잔재 — P1a-S5 스코프

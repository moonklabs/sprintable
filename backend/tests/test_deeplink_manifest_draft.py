"""story #1951 (E-MOBILE P1a-S1) DRAFT fixture — 딥링크 계약 매니페스트 v1 초안 검증.

⚠️ 이 테스트는 3자 검토(디디+유나+미르코) 전 로컬 실행 확인용이다. CI에 정식 편입하는 건
story #1952(P1a-S2) 스코프 — 이번 스토리는 draft 브랜치에만 존재하고 PR도 열지 않는다.

정상 케이스 ≥1 + 위반 케이스(미등재 타입 1건·필수 필드 누락 1건) 각 ≥1을 로컬에서
pass/fail(의도된 실패)로 실증한다.
"""
from __future__ import annotations

import uuid

import pytest

from app.schemas.deeplink_manifest import (
    DEEPLINK_MANIFEST,
    MANIFEST_SCHEMA_VERSION,
    MissingRequiredDeepLinkPayloadError,
    ParentTab,
    UnregisteredDeepLinkTypeError,
    validate_push_payload,
)


# ---------------------------------------------------------------------------
# 정상 케이스
# ---------------------------------------------------------------------------

def test_gate_pending_approval_resolves_to_gate_detail_approvals_tab():
    """실제 ee/services/expo_push.py deliver_expo_push()가 만드는 data payload 형태를
    그대로 재현 — gate_service.py:137 gate.pending_approval 호출 실측 기준."""
    gate_id = str(uuid.uuid4())
    data = {"event_type": "gate.pending_approval", "reference_type": "gate", "reference_id": gate_id}

    entry = validate_push_payload(DEEPLINK_MANIFEST, data)

    assert entry.app.target == "gate_detail"
    assert entry.app.parent_tab == ParentTab.approvals


def test_dispatched_disambiguates_by_entity_type_story_vs_epic():
    """agent_dispatch.py: event_type 항상 'dispatched'·reference_type이 실 목적지를 가른다.
    동일 event_type이 서로 다른 target으로 갈라지는 게 핵심 검증 포인트."""
    story_data = {
        "event_type": "dispatched", "reference_type": "story", "reference_id": str(uuid.uuid4()),
    }
    epic_data = {
        "event_type": "dispatched", "reference_type": "epic", "reference_id": str(uuid.uuid4()),
    }

    story_entry = validate_push_payload(DEEPLINK_MANIFEST, story_data)
    epic_entry = validate_push_payload(DEEPLINK_MANIFEST, epic_data)

    assert story_entry.app.target == "story_detail"
    assert epic_entry.app.target == "goal_detail"
    assert story_entry.app.target != epic_entry.app.target


def test_conversation_mention_lands_in_chat_tab():
    data = {
        "event_type": "conversation.mention", "reference_type": "conversation",
        "reference_id": str(uuid.uuid4()),
    }
    entry = validate_push_payload(DEEPLINK_MANIFEST, data)
    assert entry.app.parent_tab == ParentTab.chat


def test_manifest_covers_all_24_dispatch_notification_event_types():
    """AC1 회귀 고정: story #1951 GATE1 전수 조사에서 확인한 dispatch_notification()
    event_type 리터럴 24종이 전부 등재돼 있어야 한다. 새 알림 타입이 코드에 추가되고
    이 집합이 갱신 안 되면 이 테스트가 알려준다(양방향 대조 — 매니페스트 초과분도 잡음)."""
    expected = {
        "sprint_closed", "task_completed", "story_assigned", "comment.created",
        "artifact.created", "artifact.exported", "artifact.updated", "artifact.canonicalized",
        "conversation.mention", "conversation.message", "agent_joined", "handoff_stuck",
        "dispatched", "epic_created", "epic_status_changed", "gate_escalated", "gate_reminder",
        "gate.pending_approval", "gate_overridden", "gate_approval_requested", "gate_reassigned",
        "doc_approval_requested", "handoff_fallback", "story_status_changed",
    }
    actual = {e.app.type for e in DEEPLINK_MANIFEST.entries}
    missing = expected - actual
    extra = actual - expected
    assert not missing, f"매니페스트에 없는 실 발송 타입: {missing}"
    assert not extra, f"실 발송 목록에 없는 매니페스트 초과분(오타/추측 등록 의심): {extra}"


# ---------------------------------------------------------------------------
# 위반 케이스 (의도된 실패 — fail-closed, AC2)
# ---------------------------------------------------------------------------

def test_unregistered_type_fails_closed():
    """미등재 타입 — story 91(/memos) 폐기 잔재 같은 legacy event_type이 여기 해당."""
    data = {"event_type": "legacy_memo_reply", "reference_type": "memo", "reference_id": str(uuid.uuid4())}

    with pytest.raises(UnregisteredDeepLinkTypeError) as exc_info:
        validate_push_payload(DEEPLINK_MANIFEST, data)

    assert exc_info.value.event_type == "legacy_memo_reply"


def test_unregistered_entity_type_variant_fails_closed():
    """등재된 event_type이지만 등재 안 된 entity_type 조합 — 예: dispatched.task는
    READINESS_MATRIX(agent_dispatch.py _ENTITY_TYPES)에 없는 조합이라 실제로 발생하지
    않지만, 매니페스트가 이런 조합도 정확히 거부하는지(엉뚱한 target으로 새지 않는지)
    확인."""
    data = {"event_type": "dispatched", "reference_type": "task", "reference_id": str(uuid.uuid4())}

    with pytest.raises(UnregisteredDeepLinkTypeError):
        validate_push_payload(DEEPLINK_MANIFEST, data)


def test_missing_required_reference_id_fails_closed():
    """reference_id 누락 — required_payload=['reference_id'] 위반. 실제로는
    dispatch_notification 호출부가 전부 reference_id를 채우지만(코드 실측), payload
    변조/신규 호출부 실수를 이 fixture가 잡아야 한다는 게 AC2 요지."""
    data = {"event_type": "gate.pending_approval", "reference_type": "gate", "reference_id": None}

    with pytest.raises(MissingRequiredDeepLinkPayloadError) as exc_info:
        validate_push_payload(DEEPLINK_MANIFEST, data)

    assert "reference_id" in exc_info.value.missing


def test_missing_event_type_key_entirely_fails_closed():
    """event_type 자체가 없는 기형 payload(방어적 케이스 — 실제로 deliver_expo_push는
    항상 채우지만 임의 소비자/미래 변경 대비)."""
    with pytest.raises(UnregisteredDeepLinkTypeError):
        validate_push_payload(DEEPLINK_MANIFEST, {"reference_type": "gate", "reference_id": "x"})


# ---------------------------------------------------------------------------
# 버전/무결성
# ---------------------------------------------------------------------------

def test_no_duplicate_lookup_keys():
    """DeepLinkManifest.__init__의 model_validator가 이미 강제하지만(생성 시점에 raise),
    로드된 SSOT 인스턴스가 실제로 그 불변식을 만족하는지 명시적으로 재확인."""
    keys = [e.lookup_key for e in DEEPLINK_MANIFEST.entries]
    assert len(keys) == len(set(keys))


def test_schema_version_is_current():
    assert DEEPLINK_MANIFEST.schema_version == MANIFEST_SCHEMA_VERSION == 1


def test_same_target_implies_same_parent_tab():
    """유나(FE 착지화면 오너) 3자 검토 필수 불변식: parentTab은 target의 순수 함수여야
    한다 — "same target ⇒ same parentTab". 같은 착지 화면이 알림 타입에 따라 소속 탭이
    갈리면 4탭 공간 모델과 합성 history(P2-S3) 전제가 깨진다.

    이 테스트는 draft 파일에만 존재하지만(story #1951 스코프), story #1952(P1a-S2 계약
    CI)에서 정식 CI 불변식으로 편입될 예정이다 — 유나 지시로 지금 여기 넣어둔다.

    전체 레지스트리를 target으로 grouping해서 그룹 내 parentTab이 유일한지 확인한다
    (양방향: 그룹이 2개 이상의 서로 다른 parentTab을 가지면 실패)."""
    by_target: dict[str, set[ParentTab]] = {}
    for entry in DEEPLINK_MANIFEST.entries:
        by_target.setdefault(entry.app.target, set()).add(entry.app.parent_tab)

    violations = {target: tabs for target, tabs in by_target.items() if len(tabs) > 1}
    assert not violations, (
        f"target이 서로 다른 parentTab을 가리키는 위반 발견(same target ⇒ same parentTab "
        f"불변식 깨짐): {violations}"
    )

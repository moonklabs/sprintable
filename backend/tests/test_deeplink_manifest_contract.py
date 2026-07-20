"""story #1951/#1952 (E-MOBILE P1a-S1/S2) — 딥링크 계약 매니페스트 v1 CI 게이트.

story #1951이 만든 `DEEPLINK_MANIFEST` SSOT(3자 검토 확정)를 story #1952가 실제 CI 게이트로
승격한다. `test_deeplink_manifest_draft.py`(3자 검토 전 로컬 검증용)를 이 파일로 rename —
기존 13개 테스트(정상 4·위반 4·무결성 3·불변식 1 + 엔드포인트 2 — 엔드포인트는
`test_deeplink_manifest_endpoint.py`로 별도 승격) 커버리지는 그대로 유지하고, 아래 신규
섹션에 AC1~AC3 CI 불변식을 추가한다:

- AC1 (미등재 발송 코드 차단): `dispatch_notification()` 실제 호출부를 AST로 정적 스캔해
  발화 가능한 (event_type, entity_type) 조합을 재구성하고, `DEEPLINK_MANIFEST.find()`
  (프로덕션이 실제로 쓰는 그 룩업 함수 — 재구현 금지)로 전부 등재됐는지 대조한다.
  (`deeplink_contract_lib.py` 참고 — 하드코딩된 기대 집합이 아니라 소스를 직접 훑으므로
  신규 dispatch_notification() 호출부가 생기면 매니페스트 갱신 없이 자동으로 실패한다.)
- AC2 (필수 target 식별자 누락 차단): 매치된 매니페스트 엔트리의 `required_payload`가
  요구하는 kwarg가 실제 호출부 소스에 없으면 실패.
- AC3 (target 실존 원칙): `target_promotion_pending=False`인 엔트리의 `target`이
  `apps/web`에 대응 라우트가 없으면 실패.
- AC4 (유나 불변식 재사용): `test_same_target_implies_same_parent_tab` — 이 파일에 원래
  있던 걸 그대로 유지(신규 구현 아님, story #1952 지시에 따라 "재사용/승격" 확인 완료).

정상 케이스 ≥1 + 위반 케이스(미등재 타입 1건·필수 필드 누락 1건) 각 ≥1을 로컬에서
pass/fail(의도된 실패)로 실증한다.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from app.schemas.deeplink_manifest import (  # noqa: E402
    DEEPLINK_MANIFEST,
    MANIFEST_SCHEMA_VERSION,
    MissingRequiredDeepLinkPayloadError,
    ParentTab,
    UnregisteredDeepLinkTypeError,
    validate_push_payload,
)
from deeplink_contract_lib import (  # noqa: E402
    scan_dispatch_notification_call_sites,
    target_route_exists,
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

    story #1951 draft 시절부터 있던 테스트를 story #1952가 그대로 재사용/승격한다(유나 지시
    — 신규 구현 아님, AC4 요구사항 그대로 이관).

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


# ---------------------------------------------------------------------------
# story #1952(P1a-S2) CI 편입 — AC1/AC2: dispatch_notification() 실제 발송 코드 대조.
# ---------------------------------------------------------------------------

def test_ac1_every_dispatched_event_type_is_registered():
    """AC1: 미등재 알림 발송 코드 = CI 실패.

    `deeplink_contract_lib.scan_dispatch_notification_call_sites()`가 소스(backend/app +
    backend/ee)를 AST로 직접 훑어 실제 `dispatch_notification()` 호출부가 발화 가능한
    (event_type, reference_type) 조합을 재구성한다(하드코딩된 기대 집합 아님 — 신규 호출부가
    추가되면 이 테스트가 자동으로 그 조합을 알아채고 매니페스트 대조를 강제한다).

    각 조합을 프로덕션이 실제로 쓰는 `DEEPLINK_MANIFEST.find()`(재구현 아님, S1 산출물
    재사용)로 조회 — 등재 안 됐으면 실패."""
    sites = scan_dispatch_notification_call_sites()
    unregistered = []
    for site in sites:
        for event_type in site.resolved_event_types:
            for reference_type in site.resolved_reference_types:
                if DEEPLINK_MANIFEST.find(event_type, reference_type) is None:
                    unregistered.append((site.file, site.lineno, event_type, reference_type))
    assert not unregistered, (
        "매니페스트에 없는 실 발송 (event_type, reference_type) 조합 발견 — "
        "DEEPLINK_MANIFEST에 등재할 것:\n" + "\n".join(
            f"  {f}:{ln} event_type={et!r} reference_type={rt!r}"
            for f, ln, et, rt in unregistered
        )
    )


def test_ac2_every_dispatch_call_site_supplies_required_payload_fields():
    """AC2: 필수 target 식별자 누락 차단.

    매치된 매니페스트 엔트리의 `required_payload`(예: `reference_id`)가 실제
    `dispatch_notification()` 호출부 소스에 kwarg로 없으면 실패 — payload 값 자체가 아니라
    "호출부가 그 kwarg를 아예 안 넘긴다"는 소스-레벨 누락을 잡는다(런타임 값 검증은
    `validate_push_payload`/`test_missing_required_reference_id_fails_closed`가 이미
    커버)."""
    sites = scan_dispatch_notification_call_sites()
    missing_by_site = []
    for site in sites:
        # DeepLinkManifestEntry.payload.required_payload가 list라 엔트리 자체는 unhashable —
        # lookup_key(hashable 튜플)로 중복 제거.
        entries_by_key: dict[tuple[str, str | None], object] = {}
        for event_type in site.resolved_event_types:
            for reference_type in site.resolved_reference_types:
                entry = DEEPLINK_MANIFEST.find(event_type, reference_type)
                if entry is not None:
                    entries_by_key[entry.lookup_key] = entry
        for entry in entries_by_key.values():
            missing = [f for f in entry.payload.required_payload if f not in site.kwarg_names]
            if missing:
                missing_by_site.append((site.file, site.lineno, entry.app.type, missing))
    assert not missing_by_site, (
        "dispatch_notification() 호출부가 매니페스트 required_payload를 안 채움:\n"
        + "\n".join(
            f"  {f}:{ln} type={t!r} missing={m}" for f, ln, t, m in missing_by_site
        )
    )


# ---------------------------------------------------------------------------
# story #1952(P1a-S2) CI 편입 — AC3: 매니페스트 target ↔ apps/web 실제 웹 라우트 대조.
# ---------------------------------------------------------------------------

def test_ac3_active_targets_have_existing_web_routes():
    """AC3: 매니페스트 target이 미존재 웹 라우트면 실패.

    `target_promotion_pending=True`(승격 대기 — 아직 라우트 없음을 스스로 선언한 엔트리,
    예: gate_detail(P1a-S4)·hypothesis "now" 폴백(P1a-S3)·artifact_detail(이번 스토리
    조사로 확인된 GAP))는 이 체크에서 제외한다 — 그 플래그 자체가 "아직 없다"는 선언이라
    실존 검증 대상이 아니다.

    나머지(target_promotion_pending=False, "이미 실존한다"고 선언한 엔트리)는
    `deeplink_contract_lib.target_route_exists()`(apps/web 파일시스템 직접 스캔)로 대조."""
    active_targets = {
        e.app.target for e in DEEPLINK_MANIFEST.entries if not e.app.target_promotion_pending
    }
    missing = sorted(t for t in active_targets if not target_route_exists(t))
    assert not missing, (
        "target_promotion_pending=False인데 apps/web에 대응 라우트가 없는 target — "
        "라우트를 만들거나 target_promotion_pending=True로 표시할 것: " + str(missing)
    )

"""S3-2: 워크플로우 위반 감지 서비스.

스토리 상태 전이 시 활성 레시피 가이드와 비교하여 위반 여부를 판단한다.
기본 동작: warn (블로킹 없음). 프로젝트 설정에서 block으로 변경 가능.
"""
from __future__ import annotations

from dataclasses import dataclass

# 표준 status 전이 순서
_STATUS_ORDER = [
    "backlog",
    "ready-for-dev",
    "in-progress",
    "in-review",
    "done",
]

_STATUS_RANK: dict[str, int] = {s: i for i, s in enumerate(_STATUS_ORDER)}


@dataclass
class ViolationResult:
    violated: bool
    reason: str | None = None
    severity: str = "warn"  # warn | block


def check_transition(
    old_status: str | None,
    new_status: str,
    violation_level: str = "warn",
) -> ViolationResult:
    """AC1: 상태 전이 위반 여부 판단.

    위반 조건: 2 이상의 단계를 건너뛰는 전진 전이.
    역방향 전이(reopen)는 위반 없음.
    """
    if old_status is None or old_status == new_status:
        return ViolationResult(violated=False)

    old_rank = _STATUS_RANK.get(old_status)
    new_rank = _STATUS_RANK.get(new_status)

    # 알 수 없는 status는 위반 없음 처리
    if old_rank is None or new_rank is None:
        return ViolationResult(violated=False)

    # 역방향 전이 (reopen) — 허용
    if new_rank <= old_rank:
        return ViolationResult(violated=False)

    # 2 이상 단계 건너뛰기 = 위반
    skip = new_rank - old_rank
    if skip >= 2:
        skipped = _STATUS_ORDER[old_rank + 1: new_rank]
        reason = f"'{old_status}' → '{new_status}' 전이: {', '.join(skipped)} 단계 건너뜀"
        return ViolationResult(violated=True, reason=reason, severity=violation_level)

    return ViolationResult(violated=False)


def build_violation_event(
    story_id: str,
    story_title: str,
    project_id: str,
    org_id: str,
    old_status: str | None,
    new_status: str,
    reason: str,
    severity: str = "warn",
) -> dict:
    """AC2: workflow_violation 이벤트 페이로드."""
    return {
        "event_type": "workflow_violation",
        "severity": severity,
        "story_id": story_id,
        "story_title": story_title,
        "project_id": project_id,
        "org_id": org_id,
        "old_status": old_status,
        "new_status": new_status,
        "reason": reason,
    }

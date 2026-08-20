"""story #2837(설계 락, 페드루 확定) — 흩어진 SimpleNamespace(Gate형) mock을 공용 팩토리로.

오늘 하루 2회 실사고(#3256: github_check_run_sha 누락·#3260: neutral_facts 누락) — 각 테스트가
그 시점 필요하다 생각한 필드만 SimpleNamespace에 손으로 채워 넣다 보니, Gate에 새 필드가 늘
때마다 여기저기서 AttributeError가 재발했다.

처방(②, PO 판정 — ①의 defaults-dict 수동유지안보다 근본적): SimpleNamespace 대신 진짜 `Gate`
ORM 인스턴스를 mock으로 쓴다. 세션에 붙지 않은 순수 Python 객체라 실 DB 왕복은 없다(테스트
안전) — 그러면서도 같은 클래스이므로 Gate에 필드가 늘어도 이 팩토리가 스키마에서 구조적으로
못 벗어난다(발산 원천 차단, defaults dict를 손으로 따라가야 하는 ①과의 핵심 차이).

⚠️detached 함정(⑤, 페드루): 컬럼 속성은 세션 밖에서도 안전하게 None으로 읽힌다(SimpleNamespace
와 달리 AttributeError 없음) — 그러나 **relationship 속성**(현재 Gate엔 없지만 앞으로 생기면)은
세션이 없으면 접근 시 DetachedInstanceError로 죽는다. 이 팩토리는 컬럼만 커버한다 — relationship
속성이 필요한 테스트는 각자 명시적으로 세팅할 것(mock/patch로 얹거나 별도 처리).

이관 범위(③, 페드루): 오늘 2회 이상 깨진 3파일(test_gate_can_approve_48f064e5.py·
test_gate_transition_human_only.py·test_rc1_body_trust_actor.py)만 우선 이관했다. 나머지
19개 파일의 기존 SimpleNamespace(Gate형) mock은 그대로 둔다 — **"건드릴 때 이관"**이 관례다:
이미 있는 파일을 굳이 먼저 손대지 않되, 새로 그 파일을 고칠 일이 생기면 그 김에 이 팩토리로
옮긴다(전수 스윕은 22파일 규모라 priority=low 대비 비용 과대라는 게 PO 판단). 이 규율을 다음
사람이 다시 고민하지 않도록 여기 명문화해 둔다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.models.gate import Gate


def make_gate(**overrides) -> Gate:
    """실 Gate 필드셋(app/models/gate.py) 그대로 기본값 채움 — 필요한 필드만 override.

    `default=`/`server_default=` 컬럼(id/status/requires_human/created_at/updated_at)은
    세션에 안 붙은 채로는 SQLAlchemy가 자동으로 안 채워주므로(그건 INSERT 시점 동작) 여기서
    직접 값을 준다 — 안 그러면 예전 SimpleNamespace보다 나을 게 없다(None으로 채워진 id 등)."""
    now = datetime.now(timezone.utc)
    defaults: dict = dict(
        id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        work_item_id=uuid.uuid4(),
        work_item_type="story",
        gate_type="merge",
        status="pending",
        resolver_id=None,
        resolved_at=None,
        resolution_note=None,
        held_until=None,
        neutral_facts=None,
        requires_human=False,
        evidence_status=None,
        decision_basis=None,
        auto_decision_reason=None,
        status_entered_at=None,
        evidence_status_entered_at=None,
        github_check_run_id=None,
        github_check_run_sha=None,
        approved_head_sha=None,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return Gate(**defaults)
